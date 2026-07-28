# AGENTS.md — SionnaRTStudio

Project context for coding agents.

## What this is

**SionnaRTStudio**: a browser-based wireless digital twin over NVIDIA
Sionna RT. React/Three.js frontend (Vite, port 3000) + FastAPI backend
(uvicorn, port 8000). Independent application architecture on top of Sionna RT
(many tools share that engine). GitHub:
`git@github.com:puloktarafder/SionnaRTStudio.git`
(SSH key auth works; `gh` CLI at `~/.local/bin/gh`, no `gh auth` configured).

Author: Pulok Tarafder, PhD student, EECS Howard University, WiCS Lab
(advisors Imtiaz Ahmed, Danda B. Rawat).

## Running it

- Both servers: `./run.sh` (or separately: uvicorn + `npm run dev`).
- Stale servers from earlier sessions often hold ports 3000/8000 — check
  `ss -tlnp` before starting.
- **Port 8000 is often held by the user's `claude-science serve` daemon —
  do NOT kill it.** Override with `SRTS_BACKEND_PORT` (read by both
  `run.sh` and the Vite proxy), e.g. `SRTS_BACKEND_PORT=8011 ./run.sh`.
  Python override: `SRTS_PYTHON`.
- Dev machine has an NVIDIA RTX 4000 Ada (20 GB); the backend pins Mitsuba
  variant `cuda_ad_mono_polarized`. Verify via `/api/health` (`"gpu": true`).
- After frontend edits, remind the user to hard-refresh the browser tab.

## Conventions

- Codebase passes `npx tsc --noUnusedLocals` — keep it that way.
- Solver feature toggles / antenna pattern / colormaps were ported from
  NVlabs/sionna-rt-gui.

## Mobility architecture (multi-Tx best-server — a key differentiator)

Draw waypoints in 3D (Trajectory tab) → Run Mobility (chunked solves,
capped 100 samples) → Play loops the receiver with per-step ray paths.

`solveMobility` sends all `txs`; the backend batches every (waypoint × Tx)
pair into ONE PathSolver dispatch over the `num_tx` axis
(`_solve_batched(tx_specs, …)` returns `results[rx][tx]`), then
`_mobility_step` picks the strongest-RSS Tx for the scalar KPIs (best-server;
sum-power combining also supported), returns the union of all Tx rays (each
`PropagationPath.txId`-tagged), plus a `perTx[]` breakdown and
`servingTxId`. All Tx must share `antennaArraySize` (one `scene.tx_array`),
like the radio map. Batched output verified exactly equal to per-(rx,tx)
solves on the CPU llvm variant.

## Validating solver logic WITHOUT a GPU

The venv's Mitsuba ships a CPU variant `llvm_ad_mono_polarized`. In a
standalone script, call `mi.set_variant('llvm_ad_mono_polarized')` BEFORE
importing `backend.solver` / building a scene (do NOT import `backend.main`,
which pins the CUDA variant). `build_scene`, `PathSolver`, etc. then run on
CPU so tensor shapes and numerics can be checked. This is how the mobility
batching refactor was verified (Sionna 2.0.1).

## Sionna RT 2.0.1 tensor shapes (with `synthetic_array=True`)

Geometric tensors carry an explicit rx axis — `valid/tau/doppler/theta_t/
phi_t/...` are `(num_rx, num_tx, num_paths)`, `interactions` is
`(depth, num_rx, num_tx, num_paths)`, `vertices` `(…, 3)`; coefficients `a`
keep antenna dims `(num_rx, num_rx_ant, num_tx, num_tx_ant, num_paths)`.
Paths are independent per (rx, tx), which is why mobility solves all
waypoints as receivers in one PathSolver dispatch instead of one call per
waypoint.

## Link-level performance (implemented 2026-07-15)

Both tiers of the formerly deferred plan are built:

1. *Channel KPIs* — `backend/linklevel.py` (pure NumPy) reduces the `solve_cir`
   CFR to Shannon-capacity KPIs: open-loop `log2 det(I + ρ/Nt·HHᴴ)`, MRT bound,
   the app's steered-uniform-precoder capacity (their gap = beamforming gain),
   spectral efficiency/throughput, transmit-covariance eigenstructure
   (effective rank / condition number), coherence bandwidth, link-budget
   effective SNR. Endpoint `/api/linkkpi`; card in the Analysis panel.
   ρ is a transmit-reference SNR applied to the physical un-normalized H, so
   nothing double-counts array gain. Unit tests: `backend/tests/test_linklevel.py`.
2. *Full PHY chain* — `backend/linkphy.py` + `/api/phyber` (+ `GET
   /api/phyber/{jobId}` polling): ray-traced CIR → Sionna PHY 2.0.1 (torch)
   5G NR PUSCH (LDPC/QAM/DMRS/LMMSE) BER/BLER-vs-Eb/N0 as a background job.
   Runs the RECIPROCAL uplink (UE transmits, BS array receives, per-element
   reciprocity); the CFR is normalized to unit mean energy so the Eb/N0 axis
   isolates selectivity from path loss. The PHY package is OPTIONAL
   (`backend/requirements-phy.txt`, ~4 GB torch wheels); `phy_available()` is
   a find_spec probe reported by `/api/health` as `"phy"`, heavy imports happen
   only inside a job, and `sionna.phy.config.device = "cpu"` MUST be set before
   building any PHY block or it lands on cuda:0 and fights Mitsuba.

Also added the same day: A3 handover (`backend/handover.py`, hysteresis + TTT
state machine over the mobility per-Tx RSS series; `handover` field on
`/api/mobility` request/response, UI in the Trajectory panel).
