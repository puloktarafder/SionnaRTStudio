/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export interface GeoAnchor {
  latitude: number;
  longitude: number;
}

export interface ENUVector {
  x: number; // East (meters)
  y: number; // North (meters)
  z: number; // Up (meters)
}

export interface BuildingFootprint {
  id: string;
  /** OSM feature label, primarily used for named roads in the 3D map. */
  name?: string;
  points: { lat: number; lon: number }[];
  enuPoints: ENUVector[];
  height: number;
  levels?: number;
  category: 'building' | 'infrastructure' | 'terrain' | 'water';
  type: string;
  material: string; // e.g., 'itu_concrete', 'itu_glass', 'itu_brick'
}

export interface Transmitter {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  height: number; // Antenna height above ground/roof in meters
  enu: ENUVector;
  powerDbm: number; // e.g., 30 dBm (1W)
  antennaArraySize: [number, number]; // [horizontal, vertical] e.g. [8, 8] for massive MIMO
  beamsteeringAzimuth: number; // degrees
  beamsteeringElevation: number; // degrees
}

export interface Receiver {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  height: number;
  enu: ENUVector;
  antennaArraySize: [number, number];
}

export type InteractionKind = 'specular' | 'diffuse' | 'refraction' | 'diffraction' | 'other';

export interface PropagationPath {
  id: string;
  points: ENUVector[]; // path segments: Tx -> P1 -> P2 -> ... -> Rx
  type: 'LOS' | 'Reflection' | 'Diffraction' | 'NLOS';
  order: number; // 0 for LOS, 1 for single bounce, etc.
  distance: number; // total meters
  pathLossDb: number;
  receivedPowerDbm: number;
  delayNs: number;
  phasesRad: number[]; // phase shifts at each interaction
  materialsReached: string[];
  // Exact per-bounce interaction types from Sionna paths.interactions.
  interactionKinds?: InteractionKind[];
  // Angles of departure (Tx) / arrival (Rx), degrees. Azimuth clockwise from
  // North (0=N, 90=E); elevation above the horizon.
  aodAzimuthDeg?: number | null;
  aodElevationDeg?: number | null;
  aoaAzimuthDeg?: number | null;
  aoaElevationDeg?: number | null;
  // Which transmitter this ray departs from — set when several Tx are solved at
  // once (multi-Tx mobility), so the scene can tell each transmitter's rays apart.
  txId?: string | null;
}

export interface ChannelMetrics {
  totalRxPowerDbm: number;
  losStatus: 'LOS' | 'NLOS';
  numPaths: number;
  rmsDelaySpreadNs: number;
  rmsDelaySpreadValid?: boolean;
  strongestPathPowerDbm: number;
  strongestPathType: string;
}

export type CoverageMetric = 'power' | 'sinr';

// How multi-Tx mobility collapses every transmitter into each waypoint's KPIs:
// 'best_server' = strongest-Tx association; 'sum' = non-coherent total incident
// power over all Tx. A cross-Tx delay spread is undefined in the latter mode.
export type MobilityCombineMode = 'best_server' | 'sum';

export interface RadioMapCell {
  x: number;
  y: number;
  z: number;
  powerDbm: number; // best-server received power [dBm]
  isLos: boolean;
  sinr?: number | null; // best-server SINR [dB]
  servingTx?: number | null;
}

export interface CoverageStats {
  metric: CoverageMetric;
  unit: string; // 'dBm' | 'dB'
  thresholdDb: number;
  servedPercent: number;
  p5: number;
  p50: number;
  p95: number;
  minVal: number;
  maxVal: number;
}

export interface RadioMapGrid {
  cells: RadioMapCell[];
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  gridSize: number;
  heightOffset: number;
  metric?: CoverageMetric;
  unit?: string;
  stats?: CoverageStats | null;
  samplesPerTx?: number;
  seed?: number;
}

// OFDM grid for coverage-proxy and ray-traced channel-grid exports.
export interface ChannelGridConfig {
  numSubcarriers: number;
  bandwidthMhz: number;
}

// One drawn/generated waypoint of the receiver's mobility trajectory.
export interface TrajectoryPoint {
  lat: number;
  lon: number;
  enu: ENUVector;
}

// One solved Tx→Rx pair in the all-pairs link matrix.
export interface MatrixCell {
  txId: string;
  rxId: string;
  metrics: ChannelMetrics;
  paths: PropagationPath[];
}

// Ray-interaction switches + Tx/Rx antenna config, mirroring the feature
// checkboxes / antenna panel of NVIDIA's sionna-rt-gui. Sent with every
// solve (link, mobility, radio map).
export interface SolverOptions {
  los: boolean;
  specularReflection: boolean;
  diffuseReflection: boolean;
  refraction: boolean;
  diffraction: boolean;
  edgeDiffraction: boolean;
  txPattern: 'iso' | 'dipole' | 'hw_dipole' | 'tr38901';
  txPolarization: 'V' | 'H' | 'VH' | 'cross';
  rxPattern: 'iso' | 'dipole' | 'hw_dipole' | 'tr38901';
  rxPolarization: 'V' | 'H' | 'VH' | 'cross';
  pathSamplesPerSource: number;
  pathSeed: number;
}

export const DEFAULT_SOLVER_OPTIONS: SolverOptions = {
  los: true,
  specularReflection: true,
  diffuseReflection: false,
  refraction: false,
  diffraction: false,
  edgeDiffraction: false,
  txPattern: 'tr38901',
  txPolarization: 'V',
  rxPattern: 'iso',
  rxPolarization: 'V',
  pathSamplesPerSource: 1_000_000,
  pathSeed: 42,
};

export type ScatteringPattern = 'none' | 'lambertian' | 'directive' | 'backscattering';

// Per-material electromagnetic + scattering overrides, sent with each solve.
// `id` matches a building material id (e.g. 'itu_concrete').
export interface MaterialConfig {
  id: string;
  scatteringCoefficient: number; // S in [0,1]
  xpdCoefficient: number; // cross-pol discrimination in [0,1]
  scatteringPattern: ScatteringPattern;
  relativePermittivity?: number | null;
  conductivity?: number | null; // S/m
  thickness?: number | null; // m
}

export function defaultMaterialConfig(id: string): MaterialConfig {
  return { id, scatteringCoefficient: 0, xpdCoefficient: 0, scatteringPattern: 'none' };
}
