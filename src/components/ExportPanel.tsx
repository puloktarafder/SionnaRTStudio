/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useRef, useState } from 'react';
import { Transmitter, Receiver, BuildingFootprint, GeoAnchor, PropagationPath, RadioMapGrid, SolverOptions, MaterialConfig, ChannelGridConfig } from '../types';
import { exportGeoJSON, exportOBJ3D, exportPropagationCSV, exportCoverageChannelGrid } from '../utils';
import { exportCIR, CIRFormat, exportCIRBundle, exportChannelGrid, exportScene } from '../api';
import { createProjectDocument, StudioProjectState } from '../project';
import { FileDown, FileSpreadsheet, Box, Compass, Database, AlertOctagon, Waves, Loader2, FileUp, Save, Package, RotateCcw, Fingerprint } from 'lucide-react';
import { NumberField } from './NumberField';

// Backend cap on ray-traced channel-grid cells (MAX_CHANNEL_GRID_CELLS in
// backend/solver.py) — keep in sync so the UI blocks over-cap exports up front.
const CHANNEL_GRID_MAX_CELLS = 16384;

interface ExportPanelProps {
  buildings: BuildingFootprint[];
  anchor: GeoAnchor;
  paths: PropagationPath[];
  txs: Transmitter[];
  rxs: Receiver[];
  tx: Transmitter;
  rx: Receiver;
  freqGhz: number;
  maxDepth: number;
  solverOptions: SolverOptions;
  radioMap: RadioMapGrid | null;
  materials: MaterialConfig[];
  projectState: StudioProjectState;
  autosaveStatus: 'saving' | 'saved' | 'error';
  onResetProject: () => void;
  onImportProject: (text: string) => void;
}

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
};

const sha256Hex = async (value: unknown): Promise<string> => {
  const bytes = new TextEncoder().encode(JSON.stringify(canonicalize(value)));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
};

/**
 * Band that opens each group of exporter cards. Spans the full grid so the
 * cards below it read as belonging to the heading rather than to the card
 * that happens to precede them.
 */
function SectionHeading({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="md:col-span-2 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-b border-[var(--line)] pb-1.5 mt-2 first:mt-0">
      <h4 className="eyebrow text-[var(--text-hi)] whitespace-nowrap">{title}</h4>
      <p className="text-[12px] text-[var(--text-lo)] leading-snug">{hint}</p>
    </div>
  );
}

export function ExportPanel({
  buildings, anchor, paths, txs, rxs, tx, rx, freqGhz, maxDepth, solverOptions,
  radioMap, materials, projectState, autosaveStatus, onImportProject, onResetProject,
}: ExportPanelProps) {
  // Channel impulse/frequency response (CIR/CFR) export configuration.
  const [numSubcarriers, setNumSubcarriers] = useState(1024);
  const [subcarrierSpacingKhz, setSubcarrierSpacingKhz] = useState(30); // 5G NR µ=1
  const [normalizeDelays, setNormalizeDelays] = useState(true);
  const [cirBusy, setCirBusy] = useState<CIRFormat | 'bundle' | null>(null);
  const [cirError, setCirError] = useState('');
  const [exportAllDevices, setExportAllDevices] = useState(false);
  // Standalone Mitsuba/Sionna scene export (scene.xml + meshes + load_scene.py).
  const [sceneBusy, setSceneBusy] = useState(false);
  const [sceneError, setSceneError] = useState('');
  // Coverage-proxy/channel-grid config — OFDM subcarriers + bandwidth.
  const [channelGridConfig, setChannelGridConfig] = useState<ChannelGridConfig>({
    numSubcarriers: 64,
    bandwidthMhz: 100,
  });
  // Export mode: OFF = synthetic in-browser JSON (default, instant);
  // ON = per-cell ray-traced MIMO CFR with Tx/Rx port axes (slow, .npz).
  const [rayTracedGrid, setRayTracedGrid] = useState(false);
  const [channelGridBusy, setChannelGridBusy] = useState(false);
  const [channelGridError, setChannelGridError] = useState('');
  const [manifestBusy, setManifestBusy] = useState(false);
  const [projectMessage, setProjectMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const projectFileRef = useRef<HTMLInputElement>(null);
  // Local trigger downloads helper (string content or a ready-made Blob).
  const triggerDownload = (content: string | Blob, filename: string, mimeType?: string) => {
    const blob = content instanceof Blob ? content : new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleExportGeoJSON = () => {
    const geoJsonStr = exportGeoJSON(buildings, anchor);
    triggerDownload(geoJsonStr, 'sionna_rt_studio_building_footprints.geojson', 'application/json');
  };

  const handleExportOBJ = () => {
    const objStr = exportOBJ3D(buildings);
    triggerDownload(objStr, 'sionna_rt_studio_twin_model.obj', 'text/plain');
  };

  const handleExportCSV = () => {
    const csvStr = exportPropagationCSV(paths);
    triggerDownload(csvStr, 'sionna_rt_studio_multipath_rays_report.csv', 'text/csv');
  };

  const handleExportProject = () => {
    const document = createProjectDocument(projectState);
    triggerDownload(
      `${JSON.stringify(document, null, 2)}\n`,
      'sionna_rt_studio_project.json',
      'application/json',
    );
    setProjectMessage({ kind: 'success', text: 'Project file exported.' });
  };

  const handleImportProjectFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      onImportProject(await file.text());
      setProjectMessage({ kind: 'success', text: `Loaded ${file.name}. Computed results were cleared.` });
    } catch (error) {
      setProjectMessage({
        kind: 'error',
        text: error instanceof Error ? error.message : 'Could not import the project file.',
      });
    }
  };

  const handleExportManifest = async () => {
    setManifestBusy(true);
    try {
      const sceneInputSha256 = await sha256Hex(buildings);
      const featureCounts = buildings.reduce<Record<string, number>>((counts, feature) => {
        counts[feature.category] = (counts[feature.category] ?? 0) + 1;
        return counts;
      }, {});
      const manifest = {
        schemaVersion: 1,
        generatedAtUtc: new Date().toISOString(),
        application: {
          name: 'SionnaRTStudio',
          version: '1.0.0',
          engine: 'Sionna RT',
        },
        coordinateConvention: {
          api: 'local East-North-Up (metres)',
          renderer: '(X,Y,Z) = (East,Up,-North)',
        },
        scene: {
          anchor,
          featureCounts,
          featureCount: buildings.length,
          canonicalInputSha256: sceneInputSha256,
        },
        solver: {
          carrierFrequencyGhz: freqGhz,
          maxDepth,
          options: solverOptions,
          materials,
        },
        devices: { transmitters: txs, receivers: rxs },
        availableOutputs: {
          renderedPathCount: paths.length,
          radioMap: radioMap ? {
            cells: radioMap.cells.length,
            gridSizeM: radioMap.gridSize,
            heightOffsetM: radioMap.heightOffset,
            metric: radioMap.metric,
            samplesPerTx: radioMap.samplesPerTx,
            seed: radioMap.seed,
            stats: radioMap.stats,
          } : null,
        },
      };
      triggerDownload(
        `${JSON.stringify(manifest, null, 2)}\n`,
        'sionna_rt_studio_experiment_manifest.json',
        'application/json',
      );
    } finally {
      setManifestBusy(false);
    }
  };

  // Build the coverage-derived proxy from a received-power radio map.
  const handleExportCoverageGrid = () => {
    if (!radioMap) return;
    if (radioMap.metric && radioMap.metric !== 'power') {
      setChannelGridError('Coverage proxy requires a received-power map. Recompute Power coverage or select the ray-traced export.');
      return;
    }
    const datasetStr = exportCoverageChannelGrid(tx, radioMap, channelGridConfig, freqGhz);
    triggerDownload(datasetStr, `sionna_rt_studio_coverage_proxy_${freqGhz}Ghz.json`, 'application/json');
  };

  // Ray-traced path: re-trace every radio-map cell on the backend and download
  // the full per-Rx/per-Tx-port CFR (paths.cfr()) as a NumPy .npz.
  const handleExportRayTracedGrid = async () => {
    if (!radioMap) return;
    setChannelGridError('');
    setChannelGridBusy(true);
    try {
      const cells = radioMap.cells.map((c) => ({ x: c.x, y: c.y, z: c.z }));
      // Map the UI's (subcarriers, bandwidth) to an OFDM subcarrier spacing.
      const numSubcarriers = Math.max(1, Math.round(channelGridConfig.numSubcarriers));
      const subcarrierSpacing = Math.max(1, (channelGridConfig.bandwidthMhz * 1e6) / numSubcarriers);
      const { blob, filename } = await exportChannelGrid(
        tx,
        rx,
        buildings,
        cells,
        freqGhz,
        maxDepth,
        solverOptions,
        { numSubcarriers, subcarrierSpacing, normalizeDelays: true },
        materials,
      );
      triggerDownload(blob, filename);
    } catch (err) {
      setChannelGridError(err instanceof Error ? err.message : 'Ray-traced CFR export failed');
    } finally {
      setChannelGridBusy(false);
    }
  };

  // The export button branches on the toggle.
  const handleChannelGridClick = () => (rayTracedGrid ? handleExportRayTracedGrid() : handleExportCoverageGrid());
  // Over-cap grids are blocked up front (the backend would reject them anyway).
  const gridOverCap = rayTracedGrid && !!radioMap && radioMap.cells.length > CHANNEL_GRID_MAX_CELLS;
  const proxyNeedsPowerMap = !rayTracedGrid && !!radioMap && !!radioMap.metric && radioMap.metric !== 'power';

  // Re-runs the Sionna PathSolver on the backend and downloads the channel
  // impulse response (a, tau) / channel frequency response (h), like Python's
  // paths.cir() / paths.cfr().
  const handleExportCIR = async (format: CIRFormat) => {
    setCirError('');
    setCirBusy(format);
    try {
      const { blob, filename } = await exportCIR(
        tx,
        rx,
        buildings,
        freqGhz,
        maxDepth,
        solverOptions,
        format,
        {
          numSubcarriers: Math.max(1, Math.round(numSubcarriers)),
          subcarrierSpacing: Math.max(1, subcarrierSpacingKhz) * 1e3,
          normalizeDelays,
        },
        materials,
        exportAllDevices ? { txs, rxs } : undefined,
      );
      triggerDownload(blob, filename);
    } catch (err) {
      setCirError(err instanceof Error ? err.message : 'CIR/CFR export failed');
    } finally {
      setCirBusy(null);
    }
  };

  const handleExportCIRBundle = async () => {
    setCirError('');
    setCirBusy('bundle');
    try {
      const { blob, filename } = await exportCIRBundle(
        txs,
        rxs,
        buildings,
        freqGhz,
        maxDepth,
        solverOptions,
        normalizeDelays,
        materials,
      );
      triggerDownload(blob, filename);
    } catch (error) {
      setCirError(error instanceof Error ? error.message : 'All-pairs CIR bundle export failed');
    } finally {
      setCirBusy(null);
    }
  };

  // Downloads the Mitsuba scene the backend traces, plus a generated
  // load_scene.py replaying the Python-side setup Sionna keeps out of the XML.
  const handleExportScene = async () => {
    setSceneError('');
    setSceneBusy(true);
    try {
      const { blob, filename } = await exportScene(
        txs,
        rxs,
        buildings,
        freqGhz,
        maxDepth,
        solverOptions,
        {
          numSubcarriers: Math.max(1, Math.round(numSubcarriers)),
          subcarrierSpacing: Math.max(1, subcarrierSpacingKhz) * 1e3,
          normalizeDelays,
        },
        materials,
      );
      triggerDownload(blob, filename);
    } catch (error) {
      setSceneError(error instanceof Error ? error.message : 'Scene export failed');
    } finally {
      setSceneBusy(false);
    }
  };

  const txArraysMatch = txs.every(
    (candidate) =>
      candidate.antennaArraySize[0] === txs[0]?.antennaArraySize[0] &&
      candidate.antennaArraySize[1] === txs[0]?.antennaArraySize[1],
  );
  const rxArraysMatch = rxs.every(
    (candidate) =>
      candidate.antennaArraySize[0] === rxs[0]?.antennaArraySize[0] &&
      candidate.antennaArraySize[1] === rxs[0]?.antennaArraySize[1],
  );
  const multiDeviceArraysMatch = txArraysMatch && rxArraysMatch;
  const txPolarizationPorts = ['VH', 'cross'].includes(solverOptions.txPolarization) ? 2 : 1;
  const rxPolarizationPorts = ['VH', 'cross'].includes(solverOptions.rxPolarization) ? 2 : 1;
  const numTxPorts = txs[0]
    ? txs[0].antennaArraySize[0] * txs[0].antennaArraySize[1] * txPolarizationPorts
    : 0;
  const numRxPorts = rxs[0]
    ? rxs[0].antennaArraySize[0] * rxs[0].antennaArraySize[1] * rxPolarizationPorts
    : 0;
  const multiDeviceExportDisabled =
    exportAllDevices && (!multiDeviceArraysMatch || txs.length === 0 || rxs.length === 0);

  return (
    <div id="export-suite-panel" className="panel p-5 flex flex-col gap-6 h-full overflow-y-auto">
      {/* Title */}
      <div className="flex items-center gap-2 border-b border-[#e3e0d6] pb-3">
        <FileDown className="w-5 h-5 text-[#cc785c]" />
        <div>
          <h3 className="panel-title">Research Data &amp; Reproducibility Exports</h3>
          <p className="text-[12px] text-[#6b6862] font-semibold">Hash the scene inputs and export geometry, rays, and channel tensors</p>
        </div>
      </div>

      {/* Grid of exporter cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Project session. Studio state rather than a research artifact, so it
            reads as a control strip and stays above the exports — save, restore,
            and reset are what people reach for first. */}
        <div className="md:col-span-2 bg-[#f5f3ec] px-4 py-3 rounded border border-[#e3e0d6] flex flex-col gap-2 shadow-sm">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <Save className="w-4 h-4 text-[#cc785c] shrink-0" />
            <h4 className="panel-title">Project Session</h4>
            <span className={`text-[11px] px-2 py-0.5 rounded font-mono font-bold border whitespace-nowrap ${
                  autosaveStatus === 'saved'
                    ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                    : autosaveStatus === 'saving'
                    ? 'bg-amber-50 text-amber-700 border-amber-200'
                    : 'bg-red-50 text-red-700 border-red-200'
            }`}>
              {autosaveStatus === 'saved' ? 'Autosaved locally' : autosaveStatus === 'saving' ? 'Autosaving…' : 'Autosave failed'}
            </span>
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <button
                id="btn-export-project"
                onClick={handleExportProject}
                className="bg-[#cc785c] hover:bg-[#b2624a] text-white text-[14px] font-bold py-1.5 px-3 rounded flex items-center justify-center gap-1.5 transition cursor-pointer border border-transparent"
              >
                <FileDown className="w-4 h-4" />
                Export Project
              </button>
              <button
                id="btn-import-project"
                onClick={() => projectFileRef.current?.click()}
                className="bg-white hover:border-[#cc785c] text-slate-700 text-[14px] font-bold py-1.5 px-3 rounded flex items-center justify-center gap-1.5 transition cursor-pointer border border-[#ddd9cb]"
              >
                <FileUp className="w-4 h-4" />
                Import Project
              </button>
              <button
                id="btn-reset-project"
                onClick={onResetProject}
                title="Discard the autosaved project and return the studio to its defaults"
                className="bg-white hover:bg-red-50 hover:border-red-300 text-[#b4483c] text-[14px] font-bold py-1.5 px-3 rounded flex items-center justify-center gap-1.5 transition cursor-pointer border border-[var(--line)]"
              >
                <RotateCcw className="w-4 h-4" />
                Reset Studio
              </button>
              <input
                ref={projectFileRef}
                type="file"
                accept=".json,application/json"
                onChange={handleImportProjectFile}
                className="hidden"
                aria-label="Import SionnaRTStudio project JSON"
              />
            </div>
          </div>
          <p className="text-[12px] text-slate-600 leading-relaxed">
            Autosaves scene geometry, every Tx/Rx and antenna setting, solver and material controls,
            trajectory, coverage controls, and display choices. Ray paths, maps, matrices, and mobility
            results are recomputed after loading.
          </p>
          {projectMessage && (
            <div className={`text-[12px] rounded px-2.5 py-1.5 font-semibold border ${
              projectMessage.kind === 'success'
                ? 'text-emerald-700 bg-emerald-50 border-emerald-200'
                : 'text-red-700 bg-red-50 border-red-200'
            }`}>
              {projectMessage.text}
            </div>
          )}
        </div>

        <SectionHeading
          title="Channel data"
          hint="Sionna RT channel tensors — the primary research artifacts"
        />
        {/* Native Sionna channel tensors. The reason most people open this tab. */}
        <div className="md:col-span-2 bg-[#f5f3ec] p-5 rounded border border-[#e3e0d6] flex flex-col gap-4 shadow-md hover:border-[#cc785c]/40 transition duration-240">
          <div className="flex items-start justify-between">
            <div className="p-3 bg-[#ebe7dc] border border-[#e3e0d6] rounded text-[#141413] shadow-inner">
              <Waves className="w-6 h-6 text-[#7b6b93]" />
            </div>
            <span className="text-[11px] px-2 py-0.5 rounded font-mono font-bold bg-slate-100 text-slate-600 border border-slate-200">
               CHANNEL RESPONSE (.npz / .csv)
            </span>
          </div>

          <div className="flex flex-col gap-1">
            <h4 className="panel-title">CIR &amp; CFR Export (paths.cir / paths.cfr)</h4>
            <p className="text-[13px] text-slate-600 leading-relaxed">
              Re-runs the Sionna RT <code className="text-[12px] bg-slate-200 px-1 rounded">PathSolver</code> and exports the native channel tensors. Raw CIR returns exactly <code className="text-[12px] bg-slate-200 px-1 rounded">a, tau = paths.cir()</code>; the combined NPZ also evaluates <code className="text-[12px] bg-slate-200 px-1 rounded">paths.cfr()</code> over the OFDM grid.
            </p>
          </div>

          <label className="flex items-start gap-2.5 bg-white border border-[#ddd9cb] rounded p-3 cursor-pointer">
            <input
              id="chk-export-all-cir-devices"
              type="checkbox"
              checked={exportAllDevices}
              onChange={(event) => {
                setExportAllDevices(event.target.checked);
                setCirError('');
              }}
              className="mt-0.5 accent-[var(--accent)] cursor-pointer"
            />
            <span className="flex flex-col gap-1">
              <span className="text-[12px] font-bold text-slate-800">
                Export all Tx × Rx as one scene tensor
              </span>
              <span className="text-[11px] text-slate-600 leading-relaxed">
                {exportAllDevices
                  ? `Expected a: [${rxs.length}, ${numRxPorts}, ${txs.length}, ${numTxPorts}, paths, 1] · tau: [${rxs.length}, ${numRxPorts}, ${txs.length}, ${numTxPorts}, paths] · NPZ only`
                  : `Off: export active ${tx.name} → ${rx.name} only.`}
              </span>
            </span>
          </label>
          {exportAllDevices && !multiDeviceArraysMatch && (
            <div className="flex flex-col sm:flex-row sm:items-center gap-3 bg-[#f8f1ec] border border-[#dcb79a] rounded p-3">
              <div className="flex items-start gap-1.5 text-[#94503c] text-[12px] font-semibold flex-1">
                <AlertOctagon className="w-3.5 h-3.5 shrink-0" />
                <span>
                  A single dense scene tensor requires uniform arrays. Keep your heterogeneous arrays and export an exact per-pair ZIP instead.
                </span>
              </div>
              <button
                id="btn-export-cir-bundle"
                onClick={handleExportCIRBundle}
                disabled={cirBusy !== null || txs.length === 0 || rxs.length === 0}
                className="shrink-0 bg-[#94503c] hover:bg-[#7a4232] disabled:bg-slate-200 disabled:text-slate-400 text-white text-[12px] font-bold py-2 px-3 rounded flex items-center justify-center gap-1.5 transition cursor-pointer border-0 disabled:cursor-not-allowed"
                title={`Retraces ${txs.length * rxs.length} links and downloads one manifest plus one raw-CIR NPZ per pair.`}
              >
                {cirBusy === 'bundle' ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileDown className="w-4 h-4" />}
                {cirBusy === 'bundle' ? `Tracing ${txs.length * rxs.length} pairs…` : 'Export all-pairs ZIP'}
              </button>
            </div>
          )}

          {/* OFDM grid configuration */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-[11px] font-bold text-slate-600">Subcarriers · CFR only</span>
              <NumberField
                integer
                min={1}
                max={8192}
                value={numSubcarriers}
                onChange={setNumSubcarriers}
                className="bg-white border border-[#e3e0d6] rounded px-2 py-1.5 text-[14px] text-slate-900 focus:border-[var(--accent)] focus:outline-none"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[11px] font-bold text-slate-600">Spacing · CFR only (kHz)</span>
              <NumberField
                min={1}
                max={3840}
                value={subcarrierSpacingKhz}
                onChange={setSubcarrierSpacingKhz}
                className="bg-white border border-[#e3e0d6] rounded px-2 py-1.5 text-[14px] text-slate-900 focus:border-[var(--accent)] focus:outline-none"
              />
            </label>
            <label className="flex flex-col gap-1 justify-end">
              <span className="text-[11px] font-bold text-slate-600">Normalize delays</span>
              <button
                type="button"
                onClick={() => setNormalizeDelays((v) => !v)}
                className={`px-2 py-1.5 text-[14px] font-bold rounded border transition ${
                  normalizeDelays
                    ? 'bg-[var(--accent)] text-white border-transparent'
                    : 'bg-white text-slate-600 border-[#e3e0d6]'
                }`}
              >
                {normalizeDelays ? 'ON (τ₀ = 0)' : 'OFF (absolute τ)'}
              </button>
            </label>
          </div>

          {cirError && (
            <div className="flex items-center gap-1.5 bg-[#f9efec] border border-[#d9aaa2] text-[#b4483c] rounded py-1.5 px-3 text-[12px] font-semibold">
              <AlertOctagon className="w-3.5 h-3.5" />
              {cirError}
            </div>
          )}

          <div className="mt-auto grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
            <button
              id="btn-export-raw-cir-npz"
              onClick={() => handleExportCIR('cir_npz')}
              disabled={paths.length === 0 || cirBusy !== null || multiDeviceExportDisabled}
              className="bg-[var(--accent)] hover:bg-[var(--accent-deep)] disabled:bg-slate-100 disabled:text-slate-400 text-white text-[14px] font-bold py-2 px-3 rounded flex items-center justify-center gap-1.5 transition cursor-pointer border border-transparent disabled:cursor-not-allowed"
            >
              {cirBusy === 'cir_npz' ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileDown className="w-4 h-4" />}
              Raw a, tau (.npz)
            </button>
            <button
              id="btn-export-cir-npz"
              onClick={() => handleExportCIR('npz')}
              disabled={paths.length === 0 || cirBusy !== null || multiDeviceExportDisabled}
              className="bg-[#ebe7dc] hover:bg-[var(--accent)] hover:text-white disabled:bg-slate-100 disabled:text-slate-400 text-slate-700 text-[14px] font-bold py-2 px-3 rounded flex items-center justify-center gap-1.5 transition cursor-pointer border border-[#e3e0d6] hover:border-transparent disabled:cursor-not-allowed"
            >
              {cirBusy === 'npz' ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileDown className="w-4 h-4" />}
              a, tau, h (.npz)
            </button>
            <button
              id="btn-export-cir-csv"
              onClick={() => handleExportCIR('cir_csv')}
              disabled={paths.length === 0 || cirBusy !== null || exportAllDevices}
              title={exportAllDevices ? 'CSV supports one Tx→Rx link; use NPZ for the multi-device tensor.' : undefined}
              className="bg-[#ebe7dc] hover:bg-[var(--accent)] hover:text-white disabled:bg-slate-100 disabled:text-slate-400 text-slate-700 text-[14px] font-bold py-2 px-3 rounded flex items-center justify-center gap-1.5 transition cursor-pointer border border-[#e3e0d6] hover:border-transparent disabled:cursor-not-allowed"
            >
              {cirBusy === 'cir_csv' ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileSpreadsheet className="w-4 h-4" />}
              CIR (.csv)
            </button>
            <button
              id="btn-export-cfr-csv"
              onClick={() => handleExportCIR('cfr_csv')}
              disabled={paths.length === 0 || cirBusy !== null || exportAllDevices}
              title={exportAllDevices ? 'CSV supports one Tx→Rx link; use NPZ for the multi-device tensor.' : undefined}
              className="bg-[#ebe7dc] hover:bg-[var(--accent)] hover:text-white disabled:bg-slate-100 disabled:text-slate-400 text-slate-700 text-[14px] font-bold py-2 px-3 rounded flex items-center justify-center gap-1.5 transition cursor-pointer border border-[#e3e0d6] hover:border-transparent disabled:cursor-not-allowed"
            >
              {cirBusy === 'cfr_csv' ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileSpreadsheet className="w-4 h-4" />}
              CFR (.csv)
            </button>
          </div>
          {paths.length === 0 && (
            <p className="text-[11px] text-slate-500 font-medium leading-normal -mt-1">
              Solve a Tx→Rx link first (Link mode) to enable CIR/CFR export.
            </p>
          )}
        </div>

        {/* Grid-sampled dataset: coverage proxy, or per-cell ray-traced MIMO CFR. */}
        <div className="md:col-span-2 bg-[#f5f3ec] p-5 rounded border border-[#e3e0d6] flex flex-col gap-4 shadow-md hover:border-[#cc785c]/40 transition duration-240">
          <div className="flex items-start justify-between">
            <div className="p-3 bg-[#ebe7dc] border border-[#e3e0d6] rounded text-[#141413] shadow-inner">
              <Database className="w-6 h-6 text-[#4a727e]" />
            </div>
            <span className="text-[11px] px-2 py-0.5 rounded font-mono font-bold bg-slate-100 text-slate-600 border border-slate-200">
               {rayTracedGrid ? 'RAY-TRACED (.npz)' : 'COVERAGE PROXY (.json)'}
            </span>
          </div>

          <div className="flex flex-col gap-1">
            <h4 className="panel-title">Channel Grid Dataset</h4>
            <p className="text-[13px] text-slate-600 leading-relaxed">
              Per-cell dataset over the computed radio map. <strong>Synthetic</strong> (default): each cell's <code className="text-[12px] bg-slate-200 px-1 rounded">H</code> magnitude comes from its coverage power with a deterministic phase — instant, in-browser JSON. <strong>Ray-traced</strong>: re-traces every cell and exports the genuine <code className="text-[12px] bg-slate-200 px-1 rounded">paths.cfr()</code> channel as <code className="text-[12px] bg-slate-200 px-1 rounded">.npz</code>, preserving the active Tx and Rx array-port axes.
            </p>
          </div>

          {/* Export-mode toggle: synthetic (default) vs per-cell ray tracing. */}
          <div className="flex items-center justify-between gap-3 bg-white border border-[#e3e0d6] rounded px-3 py-2">
            <div className="flex flex-col">
              <span className="text-[12px] font-bold text-slate-800">Ray-Traced Per-Element CFR</span>
              <span className="text-[11px] text-slate-500">{rayTracedGrid ? 'paths.cfr() per cell — backend, slow' : 'Coverage-derived proxy — instant'}</span>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={rayTracedGrid}
              onClick={() => setRayTracedGrid(!rayTracedGrid)}
              className={`relative w-10 h-5 rounded-full transition shrink-0 cursor-pointer ${rayTracedGrid ? 'bg-[var(--accent)]' : 'bg-slate-300'}`}
            >
              <span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${rayTracedGrid ? 'translate-x-5' : ''}`} />
            </button>
          </div>

          {/* OFDM grid configuration */}
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-[11px] font-bold text-slate-600">Subcarriers</span>
              <NumberField
                integer
                min={1}
                max={8192}
                value={channelGridConfig.numSubcarriers}
                onChange={(numSubcarriers) => setChannelGridConfig({ ...channelGridConfig, numSubcarriers })}
                className="bg-white border border-[#e3e0d6] rounded px-2 py-1.5 text-[14px] text-slate-900 focus:border-[#4a727e] focus:outline-none"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[11px] font-bold text-slate-600">Bandwidth (MHz)</span>
              <NumberField
                integer
                min={1}
                max={2000}
                value={channelGridConfig.bandwidthMhz}
                onChange={(bandwidthMhz) => setChannelGridConfig({ ...channelGridConfig, bandwidthMhz })}
                className="bg-white border border-[#e3e0d6] rounded px-2 py-1.5 text-[14px] text-slate-900 focus:border-[#4a727e] focus:outline-none"
              />
            </label>
          </div>

          {!radioMap && (
            <div className="flex items-center gap-1.5 bg-[#f8f1ec] border border-[#dcb79a] text-[#cc785c] rounded py-1.5 px-3 text-[12px] font-semibold">
              <AlertOctagon className="w-3.5 h-3.5" />
              Compute a Radio Coverage grid first (Radio Coverage tab) to enable this export.
            </div>
          )}

          {proxyNeedsPowerMap && (
            <div className="flex items-start gap-1.5 bg-[#f8f1ec] border border-[#dcb79a] text-[#6f5624] rounded py-1.5 px-3 text-[12px] font-semibold">
              <AlertOctagon className="w-3.5 h-3.5 mt-px shrink-0" />
              <span>The JSON proxy requires a received-power radio map; SINR is not a channel magnitude. Recompute Power coverage or enable ray-traced CFR.</span>
            </div>
          )}

          {rayTracedGrid && radioMap && (
            <div className="flex items-start gap-1.5 bg-[#f8f1ec] border border-[#dcb79a] text-[#6f5624] rounded py-1.5 px-3 text-[12px] font-semibold">
              <AlertOctagon className="w-3.5 h-3.5 mt-px shrink-0" />
              <span>
                Ray-traces all {radioMap.cells.length} cells on the backend — this can take a while.
                {gridOverCap && ` Exceeds the ${CHANNEL_GRID_MAX_CELLS}-cell cap; recompute coverage with a coarser grid size.`}
              </span>
            </div>
          )}

          {channelGridError && (
            <div className="flex items-center gap-1.5 bg-red-50 border border-red-300 text-red-700 rounded py-1.5 px-3 text-[12px] font-semibold">
              <AlertOctagon className="w-3.5 h-3.5 shrink-0" />
              {channelGridError}
            </div>
          )}

          <button
            id="btn-export-channel-grid"
            onClick={handleChannelGridClick}
            disabled={!radioMap || channelGridBusy || gridOverCap || proxyNeedsPowerMap}
            className="mt-auto w-full bg-[#ebe7dc] hover:bg-[var(--accent)] hover:text-white disabled:bg-slate-100 disabled:text-slate-400 text-slate-700 text-[14px] font-bold py-2 px-3 rounded flex items-center justify-center gap-1.5 transition cursor-pointer border border-[#e3e0d6] hover:border-transparent disabled:cursor-not-allowed"
          >
            {channelGridBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileDown className="w-4 h-4" />}
            {channelGridBusy ? 'Ray-Tracing Cells…' : rayTracedGrid ? 'Download Ray-Traced CFR (NPZ)' : 'Download Coverage Proxy (JSON)'}
          </button>
        </div>
        <SectionHeading
          title="Reproducibility"
          hint="Rerun this experiment elsewhere, or record exactly how it ran"
        />
        {/* The traced Mitsuba scene itself, runnable without the app. */}
        <div className="md:col-span-2 bg-[#f5f3ec] p-5 rounded border border-[#e3e0d6] flex flex-col gap-4 shadow-md hover:border-[#cc785c]/40 transition duration-240">
          <div className="flex items-start justify-between">
            <div className="p-3 bg-[#ebe7dc] border border-[#e3e0d6] rounded text-[#141413] shadow-inner">
              <Package className="w-6 h-6 text-[#4a727e]" />
            </div>
            <span className="text-[11px] px-2 py-0.5 rounded font-mono font-bold bg-slate-100 text-slate-600 border border-slate-200">
               STANDALONE SIONNA RT SCENE (.zip)
            </span>
          </div>

          <div className="flex flex-col gap-1">
            <h4 className="panel-title">Sionna RT Scene Export (load_scene)</h4>
            <p className="text-[13px] text-slate-600 leading-relaxed">
              Downloads the exact Mitsuba scene this backend ray-traces — <code className="text-[12px] bg-slate-200 px-1 rounded">scene.xml</code> with ITU radio-material BSDFs plus one <code className="text-[12px] bg-slate-200 px-1 rounded">.ply</code> per building — alongside a generated <code className="text-[12px] bg-slate-200 px-1 rounded">load_scene.py</code>. The script replays what Sionna keeps in Python rather than in the XML: carrier frequency, material overrides, the <code className="text-[12px] bg-slate-200 px-1 rounded">PlanarArray</code> config, every Tx/Rx, and the <code className="text-[12px] bg-slate-200 px-1 rounded">PathSolver</code> switches — ending in <code className="text-[12px] bg-slate-200 px-1 rounded">paths.cir()</code> / <code className="text-[12px] bg-slate-200 px-1 rounded">paths.cfr()</code>. Run it in a plain notebook with no app in the loop.
            </p>
          </div>

          <p className="text-[11px] text-slate-500 font-medium leading-normal">
            Uses the OFDM grid and delay-normalization settings above. Uniform arrays
            make the generated script write one dense <code className="text-[11px] bg-slate-200 px-1 rounded">cir.npz</code>.
            For mixed arrays, the script writes exact antenna-compatible tensors under
            <code className="text-[11px] bg-slate-200 px-1 rounded ml-1">channels/</code>,
            together covering every Tx × Rx pair.
          </p>

          {sceneError && (
            <div className="flex items-center gap-1.5 bg-[#f9efec] border border-[#d9aaa2] text-[#b4483c] rounded py-1.5 px-3 text-[12px] font-semibold">
              <AlertOctagon className="w-3.5 h-3.5" />
              {sceneError}
            </div>
          )}

          <button
            id="btn-export-sionna-scene"
            onClick={handleExportScene}
            disabled={sceneBusy || buildings.length === 0}
            className="mt-auto w-full bg-[var(--accent)] hover:bg-[var(--accent-deep)] disabled:bg-slate-100 disabled:text-slate-400 text-white text-[14px] font-bold py-2 px-3 rounded flex items-center justify-center gap-1.5 transition cursor-pointer border border-transparent disabled:cursor-not-allowed"
          >
            {sceneBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileDown className="w-4 h-4" />}
            {sceneBusy ? 'Building scene…' : 'Scene + load_scene.py (.zip)'}
          </button>
          {buildings.length === 0 && (
            <p className="text-[11px] text-slate-500 font-medium leading-normal -mt-1">
              Load building footprints first to build a scene.
            </p>
          )}
        </div>

        {/* Reproduction manifest: concise inputs/provenance, not a result surrogate. */}
        <div className="bg-[#f5f3ec] p-5 rounded border border-[#e3e0d6] flex flex-col gap-4 shadow-md hover:border-[#cc785c]/40 transition duration-240">
          <div className="flex items-start justify-between">
            <div className="p-3 bg-[#ebe7dc] border border-[#e3e0d6] rounded shadow-inner">
              <Fingerprint className="w-6 h-6 text-[#cc785c]" />
            </div>
            <span className="text-[11px] px-2 py-0.5 rounded font-mono font-bold bg-[#ebe7dc] text-slate-600 border border-[#e3e0d6]">
               PROVENANCE (.json)
            </span>
          </div>

          <div className="flex flex-col gap-1">
            <h4 className="panel-title">Experiment Reproduction Manifest</h4>
            <p className="text-[13px] text-slate-600 leading-relaxed">
              Records every transmitter and receiver, solver flags, path-sampling seed and budget, material overrides, coordinate convention, radio-map controls, and a SHA-256 digest of the canonical scene input. Export the matching GeoJSON or OBJ beside it to preserve the geometry.
            </p>
          </div>
          <button
            id="btn-export-experiment-manifest"
            onClick={handleExportManifest}
            disabled={manifestBusy || buildings.length === 0}
            className="mt-auto w-full bg-[#ebe7dc] hover:bg-[#cc785c] hover:text-white disabled:bg-slate-100 disabled:text-slate-400 text-slate-700 text-[14px] font-bold py-2 px-3 rounded flex items-center justify-center gap-1.5 transition cursor-pointer border border-[#e3e0d6] hover:border-transparent disabled:cursor-not-allowed"
          >
            {manifestBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileDown className="w-4 h-4" />}
            Download Manifest (.json)
          </button>
        </div>

        {/* Per-path record of the current solve, readable in a spreadsheet. */}
        <div className="bg-[#f5f3ec] p-5 rounded border border-[#e3e0d6] flex flex-col gap-4 shadow-md hover:border-[#cc785c]/40 transition duration-240">
          <div className="flex items-start justify-between">
            <div className="p-3 bg-[#ebe7dc] border border-[#e3e0d6] rounded text-[#141413] shadow-inner">
              <FileSpreadsheet className="w-6 h-6 text-[#5f7f5a]" />
            </div>
            <span className="text-[11px] px-2 py-0.5 rounded font-mono font-bold bg-slate-100 text-slate-600 border border-slate-200">
               SPREADSHEET SPREAD (.csv)
            </span>
          </div>

          <div className="flex flex-col gap-1">
            <h4 className="panel-title">Propagation Path Rays Report</h4>
            <p className="text-[13px] text-slate-600 leading-relaxed">
              Export computed propagation reflection parameters. Mapped values include specific path identifier names, order indices (LOS/Reflection orders), total distance metric, power levels (dBm), delays (ns), and coordinates.
            </p>
          </div>

          <button
            id="btn-export-rays-csv"
            onClick={handleExportCSV}
            disabled={paths.length === 0}
            className="mt-auto w-full bg-[#ebe7dc] hover:bg-[#cc785c] hover:text-white disabled:bg-slate-100 disabled:text-slate-700 text-slate-700 text-[14px] font-bold py-2 px-3 rounded flex items-center justify-center gap-1.5 transition cursor-pointer border border-[#e3e0d6] hover:border-transparent"
          >
            <FileDown className="w-4 h-4" />
            Download Propagation CSV
          </button>
        </div>

        <SectionHeading
          title="Scene geometry"
          hint="The 3D twin and its footprints, for other tools"
        />
        {/* Extruded 3D twin for Blender / Unity / CAD. */}
        <div className="bg-[#f5f3ec] p-5 rounded border border-[#e3e0d6] flex flex-col gap-4 shadow-md hover:border-[#cc785c]/40 transition duration-240">
          <div className="flex items-start justify-between">
            <div className="p-3 bg-[#ebe7dc] border border-[#e3e0d6] rounded text-[#141413] shadow-inner">
              <Box className="w-6 h-6 text-[#cc785c]" />
            </div>
            <span className="text-[11px] px-2 py-0.5 rounded font-mono font-bold bg-slate-100 text-slate-600 border border-slate-200">
               3D MESH MODEL (.obj)
            </span>
          </div>

          <div className="flex flex-col gap-1">
            <h4 className="panel-title">Wavefront 3D OBJ Export</h4>
            <p className="text-[13px] text-slate-600 leading-relaxed">
              Export the procedurally extruded 3D twin (including building shapes, heights, streets, vegetation, and waterways) as standard Wavefront OBJ vertices and face indices, fully compatible with Blender, Unity, and CAD.
            </p>
          </div>

          <button
            id="btn-export-mesh-obj"
            onClick={handleExportOBJ}
            disabled={buildings.length === 0}
            className="mt-auto w-full bg-[#ebe7dc] hover:bg-[#cc785c] hover:text-white disabled:bg-slate-100 disabled:text-slate-700 text-slate-700 text-[14px] font-bold py-2 px-3 rounded flex items-center justify-center gap-1.5 transition cursor-pointer border border-[#e3e0d6] hover:border-transparent"
          >
            <FileDown className="w-4 h-4" />
            Download 3D OBJ Model
          </button>
        </div>

        {/* Footprint polygons and tags for GIS tools. */}
        <div className="bg-[#f5f3ec] p-5 rounded border border-[#e3e0d6] flex flex-col gap-4 shadow-md hover:border-[#cc785c]/40 transition duration-240">
          <div className="flex items-start justify-between">
            <div className="p-3 bg-[#ebe7dc] border border-[#e3e0d6] rounded text-[#141413] shadow-inner">
              <Compass className="w-6 h-6 text-[#4a727e]" />
            </div>
            <span className="text-[11px] px-2 py-0.5 rounded font-mono font-bold bg-slate-100 text-slate-600 border border-slate-200">
               GEOGRAPHIC VECTOR (.geojson)
            </span>
          </div>

          <div className="flex flex-col gap-1">
            <h4 className="panel-title">GeoJSON Footprint Features</h4>
            <p className="text-[13px] text-slate-600 leading-relaxed">
              Compile active coordinate anchor boundaries, physical building footprint polygons, material property metadata tags, structures levels, and highway vector coordinates as standard vector GeoJSON coordinates.
            </p>
          </div>

          <button
            id="btn-export-gis-geojson"
            onClick={handleExportGeoJSON}
            disabled={buildings.length === 0}
            className="mt-auto w-full bg-[#ebe7dc] hover:bg-[#cc785c] hover:text-white disabled:bg-slate-100 disabled:text-slate-700 text-slate-700 text-[14px] font-bold py-2 px-3 rounded flex items-center justify-center gap-1.5 transition cursor-pointer border border-[#e3e0d6] hover:border-transparent"
          >
            <FileDown className="w-4 h-4" />
            Download GeoJSON Footprints
          </button>
        </div>

      </div>
    </div>
  );
}
