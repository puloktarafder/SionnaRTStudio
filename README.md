<div align="center">

<img src="assets/SionnaRTStudio-bone.png" alt="SionnaRTStudio — Wireless Digital Twin" width="760"/>

**A browser-based wireless digital twin powered by NVIDIA Sionna RT GPU ray tracing.**

[![Sionna RT](https://img.shields.io/badge/Sionna%20RT-NVlabs-76B900?logo=nvidia&logoColor=white)](https://github.com/NVlabs/sionna-rt)
[![React 19](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)](https://react.dev/)
[![TypeScript 5.8](https://img.shields.io/badge/TypeScript-5.8-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Three.js r184](https://img.shields.io/badge/Three.js-r184-000000?logo=threedotjs&logoColor=white)](https://threejs.org/)
[![Vite 6](https://img.shields.io/badge/Vite-6-646CFF?logo=vite&logoColor=white)](https://vitejs.dev/)
[![FastAPI](https://img.shields.io/badge/FastAPI-backend-009688?logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com/)
[![Python 3.11+](https://img.shields.io/badge/Python-3.11+-3776AB?logo=python&logoColor=white)](https://www.python.org/)
[![CUDA GPU](https://img.shields.io/badge/CUDA-GPU%20required-76B900?logo=nvidia&logoColor=white)](https://developer.nvidia.com/cuda-toolkit)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

</div>

---

**SionnaRTStudio** turns any real-world location into an interactive wireless propagation
sandbox. Pick an area on a map, pull its buildings from **OpenStreetMap**, place
transmitters and receivers inside a 3D digital twin, and run **NVIDIA
[Sionna RT](https://github.com/NVlabs/sionna-rt)** GPU ray tracing — multipath links,
coverage maps, multi-transmitter receiver mobility with 3GPP A3 handover analysis,
Shannon-capacity link KPIs, an optional standard-compliant 5G NR PUSCH BER/BLER
chain, and notebook-grade channel-response exports (CIR / CFR) — all from the
browser.

## Table of contents

- [Features](#features)
- [Architecture](#architecture)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Using it](#using-it)
- [Channel-response exports (CIR / CFR)](#channel-response-exports-cir--cfr)
- [Standalone Sionna RT scene export](#standalone-sionna-rt-scene-export)
- [Freezing an OSM scene](#freezing-an-osm-scene)
- [Running the tests](#running-the-tests)
- [Troubleshooting](#troubleshooting)
- [Notes](#notes)
- [License](#license)

## Features

- **GIS digital twin** — fetch building footprints, roads, parks, and water for any
  bounding box via the OpenStreetMap Overpass API; rendered as an interactive
  Three.js 3D scene with ITU radio materials per building.
- **Link analysis** — GPU ray tracing between any Tx/Rx pair: multipath rays in 3D,
  CIR taps, RX power, RMS delay spread, LOS/NLOS. Supports multiple transmitters
  and receivers with an all-pairs link matrix.
- **Beamforming** — configurable antenna array size, pattern (isotropic, dipole,
  half-wave dipole, 3GPP TR 38.901), polarization (V / H / VH / cross), and
  azimuth/elevation beamsteering that the solver genuinely applies.
- **Ray interaction control** — toggle line-of-sight, specular reflection, diffuse
  reflection, refraction, diffraction, and edge diffraction per solve
  (applies to links, mobility, and radio maps alike). PathSolver samples/source
  and seed are explicit, separately from radio-map Monte Carlo controls.
- **Radio coverage maps** — Sionna `RadioMapSolver` with best-server combining
  across transmitters; viridis/plasma/inferno/turbo colormaps with auto or
  manual vmin/vmax range. Monte Carlo rays/Tx and a deterministic seed are
  explicit controls and are returned with each grid for reproducibility.
- **Mobility (multi-transmitter)** — draw a receiver trajectory in the 3D scene (or
  generate a loop), then ray-trace **every transmitter** to each sampled position
  on the GPU (all Tx × all waypoints batched into one `PathSolver` dispatch). The
  API returns execution telemetry, and the UI visibly warns if the defensive serial
  fallback was used. Play it back: the receiver moves along the path while the rays
  from every transmitter, RX power, Doppler, delay spread, and LOS status update at
  every step, with a step scrubber and looping playback. A per-run **Best-server / Sum
  power** toggle picks how the multiple transmitters collapse into each step's KPIs:
  - **Best-server** — the single strongest Tx supplies the metrics and is highlighted
    as the serving cell, so you can inspect instantaneous **serving-cell
    transitions** as the receiver moves (no hysteresis or time-to-trigger is
    implied).
  - **Sum power** — non-coherently sums incident powers. It does not merge
    cross-transmitter delays/phases or invent a joint delay spread without an
    inter-cell synchronization model; per-Tx delay spreads remain available.

  Either way the scene renders the union of every transmitter's rays, and a per-Tx RSS
  / LOS breakdown is shown for each waypoint. Add transmitters right in the Trajectory
  panel; all Tx share one antenna array (matching `antennaArraySize` required).
- **A3 handover analysis** — on top of the instantaneous best-server association,
  the mobility solve runs the 3GPP A3 event model (hysteresis + time-to-trigger,
  honored in seconds via waypoint spacing and speed) over the per-Tx RSS series:
  serving-cell series, handover events (clickable — they jump the playback),
  ping-pong count, and the hysteresis-free switch count as the baseline.
- **Link-level KPIs (Shannon)** — one click re-traces the active link, samples
  `paths.cfr()` on a configurable OFDM grid and reduces it to capacity KPIs:
  open-loop vs MRT vs the steered uniform beam actually applied (their gap is the
  measured beamforming gain), spectral efficiency and throughput, transmit-covariance
  effective rank / condition number, coherence bandwidth, and a link-budget
  effective SNR. Pure NumPy on the backend — no PHY package needed.
- **PHY BER/BLER (optional)** — with the optional Sionna PHY package installed
  (`pip install -r backend/requirements-phy.txt`), the ray-traced channel is
  replayed through the standard-compliant 5G NR PUSCH chain (LDPC transport
  blocks, QAM, DMRS-based estimation, LMMSE) as the reciprocal uplink, sweeping
  Eb/N0 to a BER/BLER waterfall — as a background job with live progress. The
  PHY runs CPU-pinned so the GPU stays exclusive to the ray tracer.
- **CIR / CFR export** — re-run `PathSolver` for the active link or every Tx/Rx
  in one scene dispatch. Download raw `a, tau = paths.cir()` without an OFDM
  grid, or include `h = paths.cfr()` over configurable subcarriers. Multi-device
  NPZ files preserve Sionna's full receiver/antenna/transmitter tensor axes.
- **Standalone Sionna RT scene export** — download the exact Mitsuba scene the
  backend ray-traces (`scene.xml` with ITU radio-material BSDFs plus one `.ply`
  per building) alongside a generated `load_scene.py` that replays everything
  Sionna keeps in Python rather than in the XML: carrier frequency, material
  overrides, the `PlanarArray` config, every Tx/Rx, and the `PathSolver`
  switches. Run it in a plain notebook to reproduce a solve with no app in the
  loop.
- **Project save / restore** — editable scene state autosaves in the browser. A
  versioned project JSON can also be exported and imported to move the complete
  geometry, Tx/Rx and antenna settings, solver/material controls, trajectory,
  coverage controls, and display choices between runs or computers. Computed
  rays and maps are deliberately regenerated after loading.
- **Scene & dataset export** — GeoJSON / Wavefront OBJ / propagation CSV scene exports,
  plus two clearly separated channel-grid paths: a coverage-derived JSON proxy
  whose `H` is synthesized from map power, and a backend `.npz` containing
  ray-traced per-cell MIMO CFR from `paths.cfr()` with the active Tx and Rx
  array-port axes. This is not a standardized third-party scenario package.

## Architecture

```
┌────────────────────────────┐         ┌──────────────────────────────┐
│  Frontend (port 3000)      │  /api   │  Backend (port 8000)         │
│  React + Three.js + Vite   │ ──────► │  FastAPI + Sionna RT         │
│  src/                      │  proxy  │  backend/                    │
│  • 3D scene & map UI       │         │  • Mitsuba scene from OSM    │
│  • playback & charts       │         │    footprints (ENU meters)   │
│  • exporters (CIR/CFR…)    │         │  • PathSolver / RadioMap-    │
│                            │         │    Solver on CUDA            │
└────────────────────────────┘         └──────────────────────────────┘
```

The backend builds a Sionna/Mitsuba scene from the same ENU building footprints
the frontend renders (cached by geometry hash). The API therefore needs no
geodetic reprojection; the renderer maps ENU values into Three.js as
`(X, Y, Z) = (east, up, -north)`.

## Requirements

- **NVIDIA GPU + CUDA** — ray tracing is pinned to Mitsuba's
  `cuda_ad_mono_polarized` variant; `GET /api/health` reports the active variant.
- **Node.js 20+** and **Python 3.11+**.

## Quick start

```bash
./setup.sh     # once: installs frontend deps + a local Python venv with Sionna
./run.sh       # starts backend (:8000) + frontend (:3000); Ctrl+C stops both
```

(or `npm run setup` / `npm start`). Then open **http://localhost:3000**.
The header badge shows **RT-CORE ONLINE** when the backend is reachable.

Two environment variables override the defaults:

| Variable | Default | Purpose |
| -------- | ------- | ------- |
| `SRTS_PYTHON` | `./.venv/bin/python` | Point at an existing Python environment that already has Sionna, instead of the local venv. Read by `setup.sh` and `run.sh`. |
| `SRTS_BACKEND_PORT` | `8000` | Move the backend off port 8000 when something else holds it. Read by both `run.sh` and the Vite proxy, so the frontend follows automatically. |

```bash
SRTS_PYTHON=/path/to/venv/bin/python ./run.sh
SRTS_BACKEND_PORT=8011 ./run.sh
```

## Using it

1. **Geography** — pan the Leaflet map to an area and press
   **Fetch OSM Physical Twin** to download real buildings (or keep the preloaded
   demo city).
2. **Link Analysis** — place Tx/Rx (map drag, *Place TX/RX* in the 3D scene, or
   sliders), set frequency / max depth / ray interactions, press
   **Solve Link · Sionna RT**. With multiple devices, **Solve All Pairs** fills
   the link matrix; click a cell to focus that pair.
3. **Radio Coverage** — choose grid step and height, press
   **Map Coverage Matrix Grid**. Adjust the colormap and range under *Display*.
4. **Trajectory** (mobility) — add/select transmitters in the panel (**+ Add** under
   *Transmitters ray-traced to the path*), pick the **Best-server / Sum power** KPI
   mode, press **Draw Path** and click waypoints in the 3D scene, then **Run Mobility ·
   Sionna RT** (every transmitter is ray-traced to each sampled position, capped at
   100). Press **Play** to watch the receiver move with live per-position rays and
   metrics — including the serving Tx and a per-Tx RSS breakdown; drag the scrubber to
   inspect any step. With two or more transmitters, the **A3 handover** card sets
   hysteresis (0–15 dB) and time-to-trigger; after a run, handover events are listed
   and clicking one jumps the playback to that waypoint.
5. **Analysis** — after solving a link, **Compute KPIs** reduces its ray-traced CFR
   to Shannon-capacity KPIs (open-loop vs MRT vs the applied steered beam, coherence
   bandwidth, effective rank, link-budget SNR), and — with the optional PHY package —
   **Run BER Sweep** replays the channel through the 5G NR PUSCH chain to a BER/BLER
   waterfall as a background job with live progress.
6. **Export** — use **Export Project** / **Import Project** for a reloadable
   SionnaRTStudio project, or download the scene (OBJ / GeoJSON), propagation
   report (CSV), channel response (CIR / CFR), or a ray-traced channel grid /
   explicitly labeled coverage proxy. **Scene + load_scene.py (.zip)** exports the
   ray-traced Mitsuba scene as a standalone Sionna RT project that runs outside
   the app. Editable project inputs also autosave in the current browser.

## Channel-response exports (CIR / CFR)

The **Export** tab can reproduce the standard Sionna notebook workflow directly
from the browser. The **CIR & CFR Export** card re-runs `PathSolver` for either
the active link or, with **Export all Tx × Rx as one scene tensor**, every
device in one dispatch:

| Output | Description |
| ------ | ----------- |
| `a` | Complex baseband path coefficients (channel impulse response) |
| `tau` | Path delays in seconds |
| `h_freq` | Channel frequency response over the OFDM subcarrier grid |
| `frequencies` | Baseband subcarrier offsets (Hz) |

The **Raw a, tau (.npz)** button does not build a subcarrier grid or evaluate
`paths.cfr()`. The combined NPZ uses the selected subcarrier count and spacing.
Both honor delay normalization (`tau_0 = 0`). Multi-device CSV is intentionally
disabled because flattening its device and antenna axes would be ambiguous.

If array sizes differ, the card offers **Export all-pairs ZIP** instead of
forcing heterogeneous devices into an invalid dense tensor. The backend
retraces every pair with its actual Tx/Rx arrays and writes `cir/*.npz` plus
`manifest.json`. The earlier **Solve All Pairs** matrix cannot be reused because
it retains display rays and KPIs, not the full complex CIR tensors.

The `.npz` loads straight into Python:

```python
import numpy as np
d = np.load("sionna_rt_studio_cir_cfr.npz")
a, tau, h = d["a"], d["tau"], d["h_freq"]   # CIR coeffs, delays [s], CFR
print(a.shape)   # [num_rx, num_rx_ant, num_tx, num_tx_ant, paths, time]
print(tau.shape) # [num_rx, num_rx_ant, num_tx, num_tx_ant, paths]
```

With synthetic arrays, Sionna internally shares geometric delays across antenna
ports. The export broadcasts `tau` over those antenna axes to match the tutorial
layout and also stores the unbroadcast native values as `tau_geometric`.
`tx_ids`, `rx_ids`, names, positions, array sizes, and device counts label the
tensor axes.

Single-link CIR and CFR CSV variants remain available for quick inspection.
This mirrors:

```python
p_solver = PathSolver()
paths = p_solver(scene, max_depth=...)
a, tau = paths.cir(normalize_delays=True)
h = paths.cfr(frequencies=subcarrier_frequencies(num_subcarriers, subcarrier_spacing))
```

See [`backend/README.md`](backend/README.md) for the full API reference.

## Standalone Sionna RT scene export

The **Export** tab's *Sionna RT Scene Export* card downloads the ray-tracing
scene as a self-contained Sionna RT project, so a solve can be reproduced with
no app in the loop. Every mesh reference in the XML is relative, so the
directory is relocatable as-is.

| Member | Contents |
| ------ | -------- |
| `scene.xml` | Mitsuba scene with ITU radio-material BSDFs and relative mesh paths |
| `meshes/*.ply` | Ground plane plus one extruded prism per building |
| `load_scene.py` | Replays the Python-side setup Sionna keeps out of the XML |
| `manifest.json` | The exact settings this export was generated from |
| `README.md` | Usage notes for the bundle itself |

The XML cannot carry what Sionna holds on the Python side, which is why the
generated script exists. It replays the carrier frequency, radio-material
overrides, the `PlanarArray` configuration, every transmitter/receiver (with
each Tx's configured `power_dbm`), and the `PathSolver` interaction switches,
ending in `paths.cir()` / `paths.cfr()`:

```bash
pip install sionna-rt
python load_scene.py       # writes cir.npz next to the script
```

For a uniform-array scene the script writes a single `cir.npz`. When device
array sizes differ, one dense tensor is impossible — a Sionna scene has one
shared Tx array and one shared Rx array — so the script groups devices by exact
array-size pair and writes one tensor per compatible combination under
`channels/`, with `manifest.json` mapping each group to its file. Together they
cover every Tx×Rx pair without padding or replacing any antenna array.

Coordinates are ENU metres (x=East, y=North, z=Up) with the ground plane at
z=0, matching the rest of the app. Device heights are roof-aware: a device over
a building footprint sits on it.

## Freezing an OSM scene

Both the browser and freezer call `src/utils.ts::parseOsmElements`:

```bash
npm run check:osm-parser
npm run freeze:osm-scene
```

The freezer writes the raw Overpass payload, all visual features, backend-ready
buildings, and `osm_scene_manifest.json` with the query, bounds, counts, runtime,
and SHA-256 hashes under `artifacts/osm-scene/` by default. Use `--out-dir` to
choose another destination. Re-run it only when intentionally creating a new
dated scene snapshot; experiments should cite the frozen hashes.

## Running the tests

The backend suite covers the pure-math pieces — solver reductions, link-level
KPIs, the A3 handover state machine, and scene-export packaging. **None of it
needs a GPU or a Sionna scene build**, so it runs anywhere in well under a
second:

```bash
./.venv/bin/python -m unittest discover backend/tests
```

| Suite | Covers |
| ----- | ------ |
| `test_solver_math.py` | Beamforming, channel metrics, coverage stats, geometry hashing |
| `test_linklevel.py` | Shannon-capacity KPI reduction (open-loop / MRT / steered) |
| `test_handover.py` | 3GPP A3 hysteresis + time-to-trigger state machine |
| `test_scene_export.py` | Standalone scene bundle contents and manifest |

Two frontend checks round it out — both offline, both fixture-based:

```bash
npm run check:osm-parser   # pins the shared OSM parser against a fixture
npm run lint               # tsc --noEmit
```

`npm run check:osm-parser` guards `src/utils.ts::parseOsmElements`, which the
browser and the scene freezer both call — it is the one piece of parsing where
a silent regression would desynchronize the rendered scene from a frozen
snapshot.

## Troubleshooting

**`RT-CORE ONLINE` never appears / requests fail.** The backend is unreachable.
Confirm it is up and check which port it took: `curl localhost:8000/api/health`.
If something else already holds 8000, restart with `SRTS_BACKEND_PORT=8011
./run.sh` — the Vite proxy reads the same variable, so the frontend follows.

**Solves are slow, and `/api/health` reports `"gpu": false`.** The backend pins
Mitsuba's `cuda_ad_mono_polarized` variant only when it is actually available,
so with no CUDA build it starts normally and silently falls back to a CPU
variant rather than failing. Check the reported `variant`: anything not
starting with `cuda` means rays are being traced on the CPU. Reinstall
`mitsuba` against a working CUDA toolkit.

**Rays pass straight through buildings.** Almost always a missing
`mapbox_earcut` — trimesh cannot triangulate the footprints, so buildings never
mesh and drop out of the ray-traced scene entirely. The browser gives no hint,
but the backend log does: look for `[scene_build] WARNING: failed to extrude
building`. Fix with `pip install mapbox_earcut` (it is in
`backend/requirements.txt` for exactly this reason).

**Fetching OSM fails.** The app tries two Overpass mirrors in order
(`overpass-api.de`, then `overpass.kumi.systems`) with a 25-second query
timeout, and reports the last error from each. Public Overpass instances rate-
limit aggressively; a `429` or `504` from both usually just means wait, or draw
a smaller bounding box.

**`Run BER Sweep` is unavailable.** The Sionna PHY package is optional and not
installed by `setup.sh`. `/api/health` reports it as `"phy"`. Install with
`pip install -r backend/requirements-phy.txt` (~4 GB with torch). A second
concurrent sweep returns `409` — only one job runs at a time.

**Frontend changes do not appear.** Hard-refresh the tab; Vite's cached module
graph survives an ordinary reload.

## Notes

- Only `category:"building"` footprints are ray-traced (a ground plane is added
  automatically); roads/parks/water are visual-only.
- Multipolygon outer rings are preserved; interior courtyard rings are not yet
  represented by the current simple footprint schema.
- Diffuse reflection and refraction add many ray branches — expect slower solves,
  especially on radio maps.
- Tx and Rx arrays are physical Sionna `PlanarArray` objects with configurable
  size, pattern, and polarization. PathSolver uses synthetic arrays (device-center
  tracing plus Sionna's per-port phase application); scalar RSS sums the resulting
  Rx-port powers rather than adding an analytic `10·log10(Nr)` term.
- Sionna `RadioMapSolver` uses its own ideal dual-polarized isotropic receiver,
  so configured Rx arrays apply to links, mobility, CIR/CFR, link KPIs, PHY
  replay, and ray-traced channel-grid export—not to the coverage heatmap.
- Link/mobility channel KPIs (total power, RMS delay spread, path count) are
  computed over the **full** Sionna path set; only the rays drawn in the 3D view
  are capped (to the 15 strongest) for legibility.
- **Refraction** is approximate for solid structures. Sionna RT models each surface
  as a flat slab and folds wall thickness into the transmission coefficient;
  buildings here are closed prisms, so a transmitted ray crosses two wall slabs
  (entry + exit), each costing a `max_depth` bounce. Reflection and LOS occlusion
  are unaffected.
- The radio map's per-cell **LOS flag** is a 2D-footprint geometric approximation
  (Sionna's `RadioMapSolver` returns path gain / RSS / SINR, not per-cell LOS), so
  treat it as a hint, not ground truth.

## License

Apache-2.0. See [NOTICE](NOTICE) for third-party notices. Map data ©
[OpenStreetMap](https://www.openstreetmap.org/copyright) contributors. Sionna RT
is © NVIDIA Corporation (Apache-2.0).
