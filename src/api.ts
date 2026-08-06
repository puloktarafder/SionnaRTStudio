/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Client for the real Sionna RT backend (FastAPI). These replace the in-browser
 * approximate solvers in utils.ts. Vite proxies /api -> http://localhost:8000.
 */
import {
  BuildingFootprint,
  ChannelMetrics,
  CoverageMetric,
  DEFAULT_SOLVER_OPTIONS,
  MaterialConfig,
  MobilityCombineMode,
  PropagationPath,
  RadioMapGrid,
  Receiver,
  SolverOptions,
  Transmitter,
} from './types';
import { withRequestTimeout } from './utils';

// Request budgets. A solve or export is genuinely slow (ray tracing, radio
// maps, mobility batches), so its ceiling is generous — it exists to surface a
// wedged backend as an error rather than a spinner that never stops. Health
// checks and job polls answer promptly or not at all.
const SOLVE_TIMEOUT_MS = 10 * 60_000;
const HEALTH_TIMEOUT_MS = 5_000;
const POLL_TIMEOUT_MS = 15_000;

export interface SolveResponse {
  paths: PropagationPath[];
  metrics: ChannelMetrics;
}

// One transmitter's link to the Rx at a single waypoint (multi-Tx mobility).
export interface TxLinkMetrics {
  txId: string;
  txName: string;
  receivedPowerDbm: number;
  rmsDelaySpreadNs: number;
  numPaths: number;
  maxDopplerHz: number;
  losStatus: 'LOS' | 'NLOS';
}

export interface MobilityStep {
  index: number;
  rxPosition: { x: number; y: number; z: number };
  // Scalar KPIs describe the serving (best-server) transmitter at this waypoint.
  receivedPowerDbm: number;
  rmsDelaySpreadNs: number;
  rmsDelaySpreadValid?: boolean;
  numPaths: number;
  maxDopplerHz: number;
  losStatus: 'LOS' | 'NLOS';
  // Rays from every transmitter to this waypoint (each tagged with its txId).
  paths: PropagationPath[];
  // Best-server transmitter + the per-Tx breakdown behind the scalar KPIs.
  servingTxId?: string | null;
  servingTxName?: string | null;
  perTx?: TxLinkMetrics[];
}

export interface MobilityExecution {
  strategy: 'single_batched_dispatch' | 'serial_pair_fallback' | 'serial_reference';
  batchedResultUsed: boolean;
  transmitterCount: number;
  waypointCount: number;
  pairCount: number;
  successfulPathSolverDispatches: number;
  samplesPerSource: number;
  seed: number;
  solveTimeMs: number;
}

// A3-event handover parameters (3GPP): a neighbor must exceed the serving cell
// by hysteresisDb continuously for timeToTriggerMs before a handover fires.
export interface HandoverConfig {
  hysteresisDb: number;
  timeToTriggerMs: number;
  pingPongWindowS?: number;
}

export interface HandoverEvent {
  stepIndex: number;
  timeS: number;
  fromTxId: string;
  fromTxName: string;
  toTxId: string;
  toTxName: string;
  pingPong: boolean;
}

// A3 association over the mobility per-Tx RSS series. instantaneousChangeCount
// is the hysteresis-free baseline (how often the raw best server flips).
export interface HandoverAnalysis {
  hysteresisDb: number;
  timeToTriggerMs: number;
  pingPongWindowS: number;
  servingTxIds: (string | null)[];
  events: HandoverEvent[];
  handoverCount: number;
  pingPongCount: number;
  instantaneousChangeCount: number;
}

export interface MobilityResponse {
  steps: MobilityStep[];
  execution: MobilityExecution;
  handover?: HandoverAnalysis | null; // present when ≥ 2 Tx were solved
}

// Turn a failed Response into a readable message. FastAPI's `detail` is a string
// for our HTTPExceptions but an ARRAY of {loc,msg,type} objects for 422 request
// validation errors — JSON.stringify'ing that array is what produced the old
// "[object Object]" toast. Flatten it to "field: message" lines instead.
async function errorDetail(res: Response): Promise<string> {
  try {
    const j = await res.json();
    const d = j?.detail;
    if (typeof d === 'string') return d;
    if (Array.isArray(d)) {
      return d
        .map((e: any) => {
          const where = Array.isArray(e?.loc) ? e.loc.filter((x: any) => x !== 'body').join('.') : '';
          return where ? `${where}: ${e?.msg ?? ''}` : e?.msg ?? JSON.stringify(e);
        })
        .join('; ');
    }
    if (d) return typeof d === 'object' ? JSON.stringify(d) : String(d);
  } catch {}
  return res.statusText || `Request failed (${res.status})`;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  return withRequestTimeout(SOLVE_TIMEOUT_MS, async (signal) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      throw new Error(await errorDetail(res));
    }
    return (await res.json()) as T;
  });
}

// POST JSON, return the response as a downloadable blob with the filename the
// backend set via Content-Disposition (falling back to `fallbackName`).
async function postForBlob(
  url: string,
  body: unknown,
  fallbackName: string,
): Promise<{ blob: Blob; filename: string }> {
  return withRequestTimeout(SOLVE_TIMEOUT_MS, async (signal) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      throw new Error(await errorDetail(res));
    }
    const blob = await res.blob();
    const cd = res.headers.get('Content-Disposition') || '';
    const m = cd.match(/filename="?([^"]+)"?/);
    return { blob, filename: m ? m[1] : fallbackName };
  });
}

export async function checkBackend(): Promise<boolean> {
  try {
    return await withRequestTimeout(HEALTH_TIMEOUT_MS, async (signal) => {
      const res = await fetch('/api/health', { signal });
      return res.ok;
    });
  } catch {
    return false;
  }
}

export function solveLink(
  tx: Transmitter,
  rx: Receiver,
  buildings: BuildingFootprint[],
  freqGhz: number,
  maxDepth: number,
  options: SolverOptions = DEFAULT_SOLVER_OPTIONS,
  materials: MaterialConfig[] = [],
): Promise<SolveResponse> {
  return postJson<SolveResponse>('/api/solve', { tx, rx, buildings, freqGhz, maxDepth, options, materials });
}

// Extra coverage controls for the radio map (interference-aware SINR).
export interface CoverageOptions {
  metric?: CoverageMetric;
  bandwidthHz?: number;
  noiseFigureDb?: number;
  coverageThresholdDb?: number | null;
  samplesPerTx?: number;
  seed?: number;
}

export function solveRadioMap(
  txs: Transmitter[],
  buildings: BuildingFootprint[],
  freqGhz: number,
  gridSize: number,
  gridHeight: number,
  maxDepth: number,
  options: SolverOptions = DEFAULT_SOLVER_OPTIONS,
  materials: MaterialConfig[] = [],
  coverage: CoverageOptions = {},
): Promise<RadioMapGrid> {
  // Best-server coverage across all transmitters (Sionna RadioMapSolver).
  return postJson<RadioMapGrid>('/api/radiomap', {
    txs,
    buildings,
    freqGhz,
    gridSize,
    gridHeight,
    maxDepth,
    options,
    materials,
    ...coverage,
  });
}

// Link-level Shannon-capacity KPIs computed from the ray-traced CFR (Tier 1 —
// pure NumPy on the backend, no PHY package). Mirrors backend LinkKpiResponse.
export interface LinkKpiCurve {
  snrDb: number[];
  openLoop: number[]; // bit/s/Hz, log2 det(I + rho/Nt·HHᴴ) — no CSIT
  beamformed: number[]; // single-stream MRT/MRC upper reference
}

export interface LinkKpiSpectrum {
  frequencyHz: number[]; // baseband subcarrier offsets (decimated)
  gainDb: number[]; // beamformed channel gain per subcarrier
  capacity: number[]; // open-loop capacity per subcarrier at the operating SNR
}

export interface LinkKpiResponse {
  reachable: boolean;
  numTxAnt: number;
  numRxAnt: number;
  numSubcarriers: number;
  bandwidthHz: number;
  noisePowerDbm: number;
  snrSource: 'link_budget' | 'override';
  rxPowerDbm: number | null;
  effectiveSnrDb: number | null;
  capacityOpenLoopBitsHz: number;
  capacityBeamformedBitsHz: number;
  capacityUniformBitsHz: number; // what the app's steered sum/sqrt(Nt) beam delivers
  throughputMbps: number;
  beamformingGainDb: number | null; // MRT vs the steered uniform beam
  conditionNumberDb: number | null;
  effectiveRank: number | null;
  spatialEigenvaluesDb: number[];
  coherenceBw50Hz: number | null; // null = flat over the measured band
  curve: LinkKpiCurve;
  spectrum: LinkKpiSpectrum;
}

export interface LinkKpiOptions {
  numSubcarriers: number;
  subcarrierSpacing: number; // Hz
  noiseFigureDb: number;
  snrOverrideDb?: number | null; // null/undefined = use the link-budget SNR
}

export function solveLinkKpi(
  tx: Transmitter,
  rx: Receiver,
  buildings: BuildingFootprint[],
  freqGhz: number,
  maxDepth: number,
  options: SolverOptions,
  materials: MaterialConfig[],
  kpi: LinkKpiOptions,
): Promise<LinkKpiResponse> {
  return postJson<LinkKpiResponse>('/api/linkkpi', {
    tx,
    rx,
    buildings,
    freqGhz,
    maxDepth,
    options,
    materials,
    numSubcarriers: kpi.numSubcarriers,
    subcarrierSpacing: kpi.subcarrierSpacing,
    noiseFigureDb: kpi.noiseFigureDb,
    snrOverrideDb: kpi.snrOverrideDb ?? null,
  });
}

// ── Full PHY chain: NR PUSCH BER/BLER sweep (optional backend package) ──────

export interface PhyBerOptions {
  mcsIndex: number; // 3GPP 38.214 MCS table 1 (0-27)
  numPrb: number;
  snrMinDb: number;
  snrMaxDb: number;
  snrStepDb: number;
  slotsPerPoint: number;
}

export interface PhyBerPoint {
  ebNoDb: number;
  ber: number;
  bler: number;
  bitErrors: number;
  bits: number;
  blockErrors: number;
  blocks: number;
}

export interface PhyBerResult {
  points: PhyBerPoint[];
  mcsIndex: number;
  modulationOrder: number;
  targetCoderate: number;
  numPrb: number;
  numSubcarriers: number;
  subcarrierSpacingHz: number;
  numRxAnt: number; // base-station elements (reciprocal uplink receive side)
  numTxAnt: number; // effective PUSCH streams
  numUeArrayPorts: number; // physical UE ports under the uniform precoder
  numPaths: number;
  slotsPerPoint: number;
  transportBlockBits: number;
  seed: number;
}

export interface PhyBerJobStatus {
  jobId: string;
  status: 'running' | 'done' | 'error';
  progress: number; // 0..1
  message: string;
  result?: PhyBerResult | null;
}

// Whether the backend has the optional Sionna PHY package installed.
export async function checkPhyAvailable(): Promise<boolean> {
  try {
    return await withRequestTimeout(HEALTH_TIMEOUT_MS, async (signal) => {
      const res = await fetch('/api/health', { signal });
      if (!res.ok) return false;
      return Boolean((await res.json()).phy);
    });
  } catch {
    return false;
  }
}

/** Start a BER/BLER-vs-Eb/N0 sweep of the link through the 5G NR PUSCH chain
 * (background job on the backend — poll with getPhyBerStatus). */
export function startPhyBerSweep(
  tx: Transmitter,
  rx: Receiver,
  buildings: BuildingFootprint[],
  freqGhz: number,
  maxDepth: number,
  options: SolverOptions,
  materials: MaterialConfig[],
  phy: PhyBerOptions,
): Promise<PhyBerJobStatus> {
  return postJson<PhyBerJobStatus>('/api/phyber', {
    tx, rx, buildings, freqGhz, maxDepth, options, materials, ...phy,
  });
}

export async function getPhyBerStatus(jobId: string): Promise<PhyBerJobStatus> {
  return withRequestTimeout(POLL_TIMEOUT_MS, async (signal) => {
    const res = await fetch(`/api/phyber/${jobId}`, { signal });
    if (!res.ok) throw new Error(await errorDetail(res));
    return (await res.json()) as PhyBerJobStatus;
  });
}

export type CIRFormat = 'npz' | 'cir_npz' | 'cir_csv' | 'cfr_csv';

export interface CIRExportOptions {
  numSubcarriers: number;
  subcarrierSpacing: number; // Hz
  normalizeDelays: boolean;
}

export interface CIRDeviceSelection {
  txs: Transmitter[];
  rxs: Receiver[];
}

/**
 * Export native Sionna channel tensors for either the selected Tx→Rx link or
 * every device in one scene/PathSolver dispatch. Multi-device NPZ tensors keep
 * [num_rx, num_rx_ant, num_tx, num_tx_ant, ...] axis order.
 */
export function exportCIR(
  tx: Transmitter,
  rx: Receiver,
  buildings: BuildingFootprint[],
  freqGhz: number,
  maxDepth: number,
  options: SolverOptions,
  format: CIRFormat,
  cir: CIRExportOptions,
  materials: MaterialConfig[] = [],
  devices?: CIRDeviceSelection,
): Promise<{ blob: Blob; filename: string }> {
  return postForBlob('/api/cir', {
    ...(devices ? { txs: devices.txs, rxs: devices.rxs } : { tx, rx }),
    buildings,
    freqGhz,
    maxDepth,
    options,
    materials,
    format,
    numSubcarriers: cir.numSubcarriers,
    subcarrierSpacing: cir.subcarrierSpacing,
    normalizeDelays: cir.normalizeDelays,
  }, 'sionna_rt_studio_cir.bin');
}

/**
 * Retrace every Tx→Rx pair independently and download one ZIP. This preserves
 * heterogeneous array sizes because each NPZ contains its pair's native CIR
 * tensor instead of forcing every device onto one scene-wide array.
 */
export function exportCIRBundle(
  txs: Transmitter[],
  rxs: Receiver[],
  buildings: BuildingFootprint[],
  freqGhz: number,
  maxDepth: number,
  options: SolverOptions,
  normalizeDelays: boolean,
  materials: MaterialConfig[] = [],
): Promise<{ blob: Blob; filename: string }> {
  return postForBlob('/api/cir-bundle', {
    txs,
    rxs,
    buildings,
    freqGhz,
    maxDepth,
    options,
    materials,
    normalizeDelays,
    format: 'cir_npz',
  }, 'sionna_rt_studio_cir_all_pairs.zip');
}

export interface SceneExportOptions {
  numSubcarriers: number;
  subcarrierSpacing: number; // Hz
  normalizeDelays: boolean;
}

/**
 * Download the traced scene as a standalone Sionna RT project: the Mitsuba
 * `scene.xml` + `meshes/*.ply` the backend actually ray-traces, plus a generated
 * `load_scene.py` that replays the Python-side setup (frequency, material
 * overrides, exact PlanarArray groups, devices, PathSolver switches) so the
 * same solve(s) run in a plain notebook.
 */
export function exportScene(
  txs: Transmitter[],
  rxs: Receiver[],
  buildings: BuildingFootprint[],
  freqGhz: number,
  maxDepth: number,
  options: SolverOptions,
  scene: SceneExportOptions,
  materials: MaterialConfig[] = [],
): Promise<{ blob: Blob; filename: string }> {
  return postForBlob('/api/scene-export', {
    txs,
    rxs,
    buildings,
    freqGhz,
    maxDepth,
    options,
    materials,
    numSubcarriers: scene.numSubcarriers,
    subcarrierSpacing: scene.subcarrierSpacing,
    normalizeDelays: scene.normalizeDelays,
  }, 'sionna_rt_studio_scene.zip');
}

export interface ChannelGridExportOptions {
  numSubcarriers: number;
  subcarrierSpacing: number; // Hz
  normalizeDelays: boolean;
}

/**
 * Ray-traced channel-grid export. Every radio-map cell is retraced on the
 * backend and the full per-Rx/per-Tx-port CFR (`paths.cfr()`) is returned as a
 * NumPy `.npz`. `cells` are the radio-map cell centers (ENU); all of those
 * virtual receivers share the active receiver's scene.rx_array.
 */
export function exportChannelGrid(
  tx: Transmitter,
  rx: Receiver,
  buildings: BuildingFootprint[],
  cells: { x: number; y: number; z: number }[],
  freqGhz: number,
  maxDepth: number,
  options: SolverOptions,
  gridOptions: ChannelGridExportOptions,
  materials: MaterialConfig[] = [],
): Promise<{ blob: Blob; filename: string }> {
  return postForBlob('/api/channel-grid', {
    tx,
    rx,
    buildings,
    cells,
    freqGhz,
    maxDepth,
    options,
    materials,
    numSubcarriers: gridOptions.numSubcarriers,
    subcarrierSpacing: gridOptions.subcarrierSpacing,
    normalizeDelays: gridOptions.normalizeDelays,
  }, 'sionna_rt_studio_channel_grid.npz');
}

// Ray-traces every transmitter in `txs` to each waypoint. `combineMode` chooses
// how the per-step KPIs collapse the transmitters: 'best_server' = strongest Tx
// (instantaneous serving-cell association), 'sum' = total incident power over all Tx. Rays are the union either
// way; each step carries the serving Tx (best_server only) + a per-Tx breakdown.
export function solveMobility(
  txs: Transmitter[],
  rx: Receiver,
  buildings: BuildingFootprint[],
  waypoints: { x: number; y: number; z: number }[],
  freqGhz: number,
  speedKmh: number,
  maxDepth: number,
  options: SolverOptions = DEFAULT_SOLVER_OPTIONS,
  materials: MaterialConfig[] = [],
  combineMode: MobilityCombineMode = 'best_server',
  executionMode: 'auto' | 'batched' | 'serial_reference' = 'auto',
  handover?: HandoverConfig,
): Promise<MobilityResponse> {
  return postJson<MobilityResponse>('/api/mobility', {
    txs,
    rx,
    buildings,
    waypoints,
    freqGhz,
    speedKmh,
    maxDepth,
    options,
    materials,
    combineMode,
    executionMode,
    ...(handover ? { handover } : {}),
  });
}
