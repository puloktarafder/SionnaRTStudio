/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Radio-map colormaps (matplotlib-sampled RGB stops, linear interpolation),
 * mirroring the colormap picker in NVIDIA's sionna-rt-gui. "viridis" is
 * Sionna RT's default coverage-map colormap.
 */

export type ColormapName = 'viridis' | 'plasma' | 'inferno' | 'turbo';

// Flat [r,g,b, r,g,b, ...] stops, evenly spaced over t in [0,1].
const VIRIDIS: number[] = [
  0.267,0.0049,0.3294, 0.277,0.0503,0.3757, 0.2823,0.095,0.4173, 0.2829,0.1359,0.4534,
  0.278,0.1804,0.4867, 0.2693,0.2188,0.5096, 0.2573,0.2561,0.5266, 0.2431,0.2921,0.5385,
  0.2259,0.3308,0.5473, 0.2105,0.3637,0.5522, 0.1959,0.3954,0.5553, 0.1823,0.4262,0.5571,
  0.1681,0.46,0.5581,   0.1563,0.4896,0.5579, 0.1448,0.5191,0.5566, 0.1337,0.5485,0.5535,
  0.1235,0.5817,0.5474, 0.1194,0.6111,0.539,  0.1248,0.6405,0.5271, 0.1433,0.6695,0.5112,
  0.1807,0.7014,0.4882, 0.2264,0.7289,0.4628, 0.2815,0.7552,0.4326, 0.3441,0.78,0.3974,
  0.4219,0.8058,0.3519, 0.4966,0.8264,0.3064, 0.5756,0.8446,0.2564, 0.6576,0.8602,0.2031,
  0.7519,0.875,0.1432,  0.8353,0.886,0.1026,  0.9162,0.8961,0.1007, 0.9932,0.9062,0.1439,
];

const PLASMA: number[] = [
  0.050,0.030,0.528, 0.275,0.012,0.624, 0.447,0.004,0.658, 0.612,0.090,0.620,
  0.741,0.215,0.525, 0.847,0.342,0.420, 0.929,0.475,0.326, 0.984,0.624,0.227,
  0.941,0.977,0.131,
];

const INFERNO: number[] = [
  0.001,0.000,0.014, 0.106,0.047,0.254, 0.290,0.047,0.419, 0.471,0.110,0.428,
  0.647,0.173,0.376, 0.812,0.267,0.275, 0.929,0.412,0.145, 0.984,0.608,0.024,
  0.988,1.000,0.643,
];

const TURBO: number[] = [
  0.188,0.071,0.231, 0.275,0.420,0.890, 0.224,0.694,0.937, 0.106,0.898,0.710,
  0.380,0.988,0.424, 0.643,0.988,0.231, 0.859,0.863,0.216, 0.973,0.702,0.216,
  0.965,0.471,0.157, 0.851,0.220,0.118, 0.478,0.016,0.012,
];

export const COLORMAPS: Record<ColormapName, number[]> = {
  viridis: VIRIDIS,
  plasma: PLASMA,
  inferno: INFERNO,
  turbo: TURBO,
};

export const COLORMAP_NAMES = Object.keys(COLORMAPS) as ColormapName[];

/** Sample a colormap at t in [0,1] -> [r, g, b] in [0,1]. */
export function sampleColormap(name: ColormapName, t: number): [number, number, number] {
  const stops = COLORMAPS[name] ?? VIRIDIS;
  const n = stops.length / 3;
  const x = Math.min(1, Math.max(0, t)) * (n - 1);
  const i = Math.floor(x);
  const f = x - i;
  const j = Math.min(i + 1, n - 1);
  return [
    stops[i * 3] + (stops[j * 3] - stops[i * 3]) * f,
    stops[i * 3 + 1] + (stops[j * 3 + 1] - stops[i * 3 + 1]) * f,
    stops[i * 3 + 2] + (stops[j * 3 + 2] - stops[i * 3 + 2]) * f,
  ];
}

/** CSS linear-gradient string for legends / colorbars. */
export function colormapCssGradient(name: ColormapName): string {
  const stops = COLORMAPS[name] ?? VIRIDIS;
  const n = stops.length / 3;
  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    const r = Math.round(stops[i * 3] * 255);
    const g = Math.round(stops[i * 3 + 1] * 255);
    const b = Math.round(stops[i * 3 + 2] * 255);
    parts.push(`rgb(${r},${g},${b}) ${((i / (n - 1)) * 100).toFixed(1)}%`);
  }
  return `linear-gradient(to right, ${parts.join(', ')})`;
}
