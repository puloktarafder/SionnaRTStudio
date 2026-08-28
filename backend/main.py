"""FastAPI app exposing exactly what the React frontend calls.

Core endpoints (camelCase JSON, matching src/types.ts):
  GET  /api/health
  POST /api/solve     {tx, rx, buildings, freqGhz} -> {paths, metrics}
  POST /api/radiomap  {tx, buildings, freqGhz, gridSize, gridHeight} -> RadioMapGrid
  POST /api/mobility  {txs, rx, buildings, waypoints, ...} -> {steps, execution}
  POST /api/cir       link + OFDM grid -> CIR/CFR file
  POST /api/linkkpi   link + OFDM grid -> Shannon-capacity link KPIs
  POST /api/phyber    link + PUSCH config -> BER/BLER sweep job (optional PHY pkg)
  GET  /api/phyber/{jobId}  poll a running sweep -> progress/result
  POST /api/channel-grid  tx + receiver cells + OFDM grid -> ray-traced CFR file
  POST /api/scene-export  buildings + devices -> standalone Sionna RT scene ZIP

Real NVIDIA Sionna RT ray tracing runs here (needs an NVIDIA GPU + CUDA Mitsuba
variant). Solves are serialized with a lock because the Sionna/Mitsuba runtime is
not re-entrant.
"""
from __future__ import annotations

import io
import importlib.metadata
import json
import platform
import threading
import time
import traceback
import zipfile

# Homebrew LLVM is keg-only. Configure Dr.Jit before importing Mitsuba so
# direct uvicorn launches work as reliably as setup.sh/run.sh on macOS.
from .runtime_env import configure_drjit_llvm_path

configure_drjit_llvm_path()

import mitsuba as mi
import numpy as np

# Prefer GPU ray tracing. Sionna RT would pick a variant on its own, but pinning
# one here (before sionna is imported) makes that explicit and lets /api/health
# report which device actually traces the rays.
#
# mi.variants() lists what Mitsuba was COMPILED with, not what this host can
# actually run — the published wheels always bundle the CUDA variants. So
# membership alone is not enough: set_variant() is the call that initializes
# CUDA, and it raises on any machine without a usable GPU (a VM with no
# passthrough, a box with no NVIDIA card, a driver/library mismatch). Falling
# through to a CPU variant keeps the backend serving instead of killing the
# whole process at import time.
# Only the `_ad_` variants carry the autodiff + vectorized types Sionna's solvers
# need; the `scalar_*` ones are deliberately NOT candidates. Mitsuba will happily
# select a scalar variant, but every solve then dies deep inside Sionna with
# "epsilon(): input is not a Dr.Jit array" — a backend that answers /api/health
# and fails every actual request is worse than one that refuses to start.
_GPU_VARIANT = "cuda_ad_mono_polarized"
_CPU_VARIANT = "llvm_ad_mono_polarized"

_failures: list[str] = []
for _candidate in (_GPU_VARIANT, _CPU_VARIANT):
    if _candidate not in mi.variants():
        _failures.append(f"{_candidate}: not compiled into this Mitsuba build")
        continue
    try:
        mi.set_variant(_candidate)
        break
    except Exception as exc:  # noqa: BLE001 — any init failure means "try the next one"
        _failures.append(f"{_candidate}: {str(exc).strip().splitlines()[0]}")
        print(f"[startup] Mitsuba variant {_candidate!r} unavailable.")
else:
    if platform.system() == "Darwin":
        _llvm_help = (
            "On Apple Silicon, install Homebrew LLVM with: brew install llvm\n"
            "SionnaRTStudio auto-discovers its keg-only libLLVM.dylib; re-run "
            "./setup.sh if it is still unavailable."
        )
    else:
        _llvm_help = (
            "With no NVIDIA GPU, the CPU path needs the LLVM runtime:\n"
            "  sudo apt install llvm-runtime\n"
            "or point Dr.Jit at an existing one with DRJIT_LIBLLVM_PATH."
        )
    raise RuntimeError(
        "No usable Mitsuba variant — cannot ray-trace on this machine.\n"
        + "\n".join(f"  - {f}" for f in _failures)
        + "\n\n"
        + _llvm_help
    )

if not (mi.variant() or "").startswith("cuda"):
    print(
        f"[startup] WARNING: no CUDA GPU — ray tracing on the CPU via "
        f"{mi.variant()!r}. Solves will be far slower; /api/health reports "
        f'"gpu": false.'
    )

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response

from .linklevel import compute_link_kpis
from .linkphy import phy_available, run_pusch_ber_sweep
from .models import (
    CIRRequest,
    ChannelGridRequest,
    LinkKpiRequest,
    LinkKpiResponse,
    MobilityRequest,
    MobilityResponse,
    PhyBerJobStatus,
    PhyBerRequest,
    PhyBerResult,
    RadioMapGrid,
    RadioMapRequest,
    SceneExportRequest,
    SolveRequest,
    SolveResponse,
)
from .scene_export import scene_export_zip
from .solver import (
    _notebook_tau_shape,
    solve_channel_grid,
    solve_cir,
    solve_link,
    solve_mobility,
    solve_radiomap,
)

app = FastAPI(title="SionnaRTStudio Backend", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Sionna/Mitsuba is single-threaded; serialize solves.
_solve_lock = threading.Lock()


def _solve_error(exc: Exception, label: str) -> HTTPException:
    """Map a solver failure to an HTTP error.

    ValueError means the request itself was invalid (bad geometry, mismatched
    arrays, cell cap exceeded) → 400. Anything else is a server-side fault
    (GPU/Mitsuba/Sionna runtime) → 500.
    """
    traceback.print_exc()
    status = 400 if isinstance(exc, ValueError) else 500
    return HTTPException(status_code=status, detail=f"{label}: {exc}")


@app.get("/api/health")
def health() -> dict:
    variant = mi.variant() or "unset"
    def version(distribution: str) -> str:
        try:
            return importlib.metadata.version(distribution)
        except importlib.metadata.PackageNotFoundError:
            return "unknown"

    return {
        "ok": True,
        "app": "SionnaRTStudio",
        "appVersion": "1.0.0",
        "engine": "Sionna RT",
        "solver": "real ray tracing",
        "variant": variant,
        "gpu": variant.startswith("cuda"),
        "pythonVersion": platform.python_version(),
        "sionnaRtVersion": version("sionna-rt"),
        "mitsubaVersion": version("mitsuba"),
        "drjitVersion": version("drjit"),
        # Optional Sionna PHY package (full NR PUSCH BER/BLER chain).
        "phy": phy_available(),
        "sionnaPhyVersion": version("sionna") if phy_available() else None,
    }


@app.post("/api/solve", response_model=SolveResponse)
def api_solve(req: SolveRequest) -> SolveResponse:
    try:
        with _solve_lock:
            paths, metrics = solve_link(req)
        return SolveResponse(paths=paths, metrics=metrics)
    except Exception as exc:  # surface a clean error to the UI
        raise _solve_error(exc, "Link solve failed") from exc


@app.post("/api/radiomap", response_model=RadioMapGrid)
def api_radiomap(req: RadioMapRequest) -> RadioMapGrid:
    try:
        with _solve_lock:
            return solve_radiomap(req)
    except Exception as exc:
        raise _solve_error(exc, "Radio map failed") from exc


@app.post("/api/mobility", response_model=MobilityResponse)
def api_mobility(req: MobilityRequest) -> MobilityResponse:
    try:
        with _solve_lock:
            started = time.perf_counter()
            steps, execution, handover = solve_mobility(req)
            execution["solveTimeMs"] = (time.perf_counter() - started) * 1000.0
        return MobilityResponse(steps=steps, execution=execution, handover=handover)
    except Exception as exc:
        raise _solve_error(exc, "Mobility solve failed") from exc


# ── PHY BER/BLER background job (Tier 2) ────────────────────────────────────
# One job at a time: the sweep is CPU-bound for minutes and the UI polls it.
_phy_jobs: dict[str, dict] = {}
_phy_jobs_lock = threading.Lock()


def _phy_job_worker(job_id: str, req: PhyBerRequest) -> None:
    job = _phy_jobs[job_id]

    def set_progress(fraction: float, message: str) -> None:
        job["progress"] = float(fraction)
        job["message"] = message

    try:
        set_progress(0.0, "Ray tracing the link (GPU)")
        with _solve_lock:  # RT solve only; the CPU sweep runs unlocked
            cir = solve_cir(req)
        snr_points: list[float] = []
        snr = req.snrMinDb
        while snr <= req.snrMaxDb + 1e-9:
            snr_points.append(round(snr, 6))
            snr += req.snrStepDb
        result = run_pusch_ber_sweep(
            cir,
            mcs_index=req.mcsIndex, num_prb=req.numPrb,
            snr_points_db=snr_points, slots_per_point=req.slotsPerPoint,
            seed=req.seed, progress=set_progress,
        )
        job["result"] = result
        job["status"] = "done"
    except Exception as exc:
        traceback.print_exc()
        job["status"] = "error"
        job["message"] = f"PHY sweep failed: {exc}"


@app.post("/api/phyber", response_model=PhyBerJobStatus)
def api_phyber_start(req: PhyBerRequest) -> PhyBerJobStatus:
    """Start a BER/BLER-vs-Eb/N0 sweep of the active link (background job)."""
    if not phy_available():
        raise HTTPException(
            status_code=400,
            detail="Sionna PHY is not installed — "
                   "pip install -r backend/requirements-phy.txt",
        )
    with _phy_jobs_lock:
        if any(j["status"] == "running" for j in _phy_jobs.values()):
            raise HTTPException(status_code=409, detail="A PHY sweep is already running")
        job_id = f"phy_{int(time.time() * 1000)}"
        _phy_jobs[job_id] = {"status": "running", "progress": 0.0,
                             "message": "Queued", "result": None}
    threading.Thread(target=_phy_job_worker, args=(job_id, req), daemon=True).start()
    return PhyBerJobStatus(jobId=job_id, status="running", progress=0.0, message="Queued")


@app.get("/api/phyber/{job_id}", response_model=PhyBerJobStatus)
def api_phyber_status(job_id: str) -> PhyBerJobStatus:
    job = _phy_jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail=f"Unknown PHY job {job_id}")
    result = PhyBerResult(**job["result"]) if job["result"] else None
    return PhyBerJobStatus(jobId=job_id, status=job["status"],
                           progress=job["progress"], message=job["message"],
                           result=result)


@app.post("/api/linkkpi", response_model=LinkKpiResponse)
def api_linkkpi(req: LinkKpiRequest) -> LinkKpiResponse:
    """Shannon-capacity KPIs for one link from its ray-traced CFR (Tier 1 —
    pure NumPy on the solve_cir output, no PHY package)."""
    try:
        with _solve_lock:
            data = solve_cir(req)
        # KPI reduction is plain NumPy — no GPU/Mitsuba, so run outside the lock.
        kpis = compute_link_kpis(
            data["h"], data["frequencies"], data["num_tx_ant"],
            tx_power_dbm=req.tx.powerDbm,
            subcarrier_spacing=req.subcarrierSpacing,
            num_subcarriers=data["num_subcarriers"],
            noise_figure_db=req.noiseFigureDb,
            snr_override_db=req.snrOverrideDb,
        )
        return LinkKpiResponse(**kpis)
    except Exception as exc:
        raise _solve_error(exc, "Link KPI solve failed") from exc


def _cir_npz_metadata(d: dict) -> dict:
    """Device/array metadata shared by raw-CIR and combined CIR/CFR files."""
    return {
        "carrier_frequency": np.asarray(d["carrier_frequency"]),
        "tx_array": d["tx_array"],                 # [horizontal, vertical]
        "rx_array": d["rx_array"],                 # [horizontal, vertical]
        "num_tx": np.asarray(d["num_tx"]),
        "num_rx": np.asarray(d["num_rx"]),
        "num_tx_ant": np.asarray(d["num_tx_ant"]), # polarization-aware port count
        "num_rx_ant": np.asarray(d["num_rx_ant"]),
        "tx_ids": d["tx_ids"],                     # tensor axis index -> device
        "rx_ids": d["rx_ids"],
        "tx_names": d["tx_names"],
        "rx_names": d["rx_names"],
        "tx_positions": d["tx_positions"],         # ENU [m], effective height
        "rx_positions": d["rx_positions"],
        "synthetic_array": np.asarray(True),
    }


def _cir_npz(d: dict) -> bytes:
    """Pack full-fidelity CIR/CFR arrays into NumPy ``.npz``."""
    buf = io.BytesIO()
    np.savez_compressed(
        buf,
        a=d["a"],                              # complex CIR coefficients
        tau=_notebook_tau_shape(d["a"], d["tau"]), # tutorial-compatible delays
        tau_geometric=d["tau"],                # native synthetic-array delays
        h_freq=d["h"],                         # complex CFR
        frequencies=d["frequencies"],          # baseband subcarrier offsets [Hz]
        subcarrier_spacing=np.asarray(d["subcarrier_spacing"]),
        **_cir_npz_metadata(d),
    )
    return buf.getvalue()


def _raw_cir_npz(d: dict) -> bytes:
    """Pack exactly ``a, tau = paths.cir(...)`` plus device-axis metadata."""
    buf = io.BytesIO()
    np.savez_compressed(
        buf,
        a=d["a"],
        tau=_notebook_tau_shape(d["a"], d["tau"]),
        tau_geometric=d["tau"],
        **_cir_npz_metadata(d),
    )
    return buf.getvalue()


def _safe_bundle_name(value: str) -> str:
    """Filesystem-safe device label for a ZIP member name."""
    cleaned = "".join(
        character if character.isalnum() or character in "-_" else "_"
        for character in value
    ).strip("_")
    return cleaned or "device"


def _cir_bundle_zip(req: CIRRequest) -> bytes:
    """Retrace heterogeneous Tx×Rx pairs and package native CIR NPZ files."""
    txs = req.transmitters()
    rxs = req.receivers()
    manifest = {
        "format": "SionnaRTStudio heterogeneous CIR bundle",
        "schemaVersion": 1,
        "generatedAtUtc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "carrierFrequencyGhz": req.freqGhz,
        "maxDepth": req.maxDepth,
        "normalizeDelays": req.normalizeDelays,
        "solverOptions": req.options.model_dump(),
        "materials": [material.model_dump() for material in req.materials],
        "tensorLayout": {
            "a": ["num_rx=1", "num_rx_ant", "num_tx=1", "num_tx_ant",
                  "num_paths", "num_time_steps=1"],
            "tau": ["num_rx=1", "num_rx_ant", "num_tx=1", "num_tx_ant",
                    "num_paths"],
        },
        "transmitterCount": len(txs),
        "receiverCount": len(rxs),
        "pairCount": len(txs) * len(rxs),
        "pairs": [],
    }

    output = io.BytesIO()
    with zipfile.ZipFile(output, mode="w", compression=zipfile.ZIP_STORED) as archive:
        for rx_index, rx in enumerate(rxs):
            for tx_index, tx in enumerate(txs):
                pair_req = req.model_copy(update={
                    "tx": tx,
                    "rx": rx,
                    "txs": None,
                    "rxs": None,
                    "format": "cir_npz",
                })
                data = solve_cir(pair_req)
                member = (
                    f"cir/rx_{rx_index:03d}_{_safe_bundle_name(rx.id)}"
                    f"__tx_{tx_index:03d}_{_safe_bundle_name(tx.id)}.npz"
                )
                archive.writestr(member, _raw_cir_npz(data))
                manifest["pairs"].append({
                    "file": member,
                    "rxIndex": rx_index,
                    "rxId": rx.id,
                    "rxName": rx.name,
                    "rxArray": list(rx.antennaArraySize),
                    "numRxAnt": data["num_rx_ant"],
                    "rxPosition": data["rx_positions"][0].tolist(),
                    "txIndex": tx_index,
                    "txId": tx.id,
                    "txName": tx.name,
                    "txArray": list(tx.antennaArraySize),
                    "numTxAnt": data["num_tx_ant"],
                    "txPosition": data["tx_positions"][0].tolist(),
                    "numPaths": data["num_paths"],
                    "aShape": list(data["a"].shape),
                    "tauShape": list(_notebook_tau_shape(
                        data["a"], data["tau"]
                    ).shape),
                })
        archive.writestr(
            "manifest.json",
            json.dumps(manifest, indent=2, ensure_ascii=False) + "\n",
        )
    return output.getvalue()


def _cir_csv(d: dict) -> bytes:
    """Per-path CIR table (first antenna pair / first time step)."""
    a = d["a"]
    num_paths = int(d["num_paths"])
    # a shape: [num_rx, num_rx_ant, num_tx, num_tx_ant, num_paths, num_time_steps]
    a0 = a[..., 0] if a.ndim >= 6 else a            # drop the time axis
    flat = a0.reshape(-1, num_paths) if num_paths else a0.reshape(1, 0)
    rep = flat[0] if flat.shape[0] else np.zeros(num_paths, dtype=complex)
    power = (np.abs(flat) ** 2).sum(axis=0)          # combined over antenna pairs
    tau = np.asarray(d["tau"]).reshape(-1, num_paths)[0] if num_paths else np.zeros(0)

    lines = [
        "# Channel impulse response (CIR) — paths.cir(); first antenna pair shown,",
        "# Magnitude/Magnitude_dB combine power over all antenna pairs.",
        f"# carrier_frequency_hz={d['carrier_frequency']:.6e}",
        "Path_Index,Delay_ns,a_real,a_imag,Magnitude,Magnitude_dB,Phase_rad",
    ]
    for i in range(num_paths):
        mag = float(np.sqrt(power[i]))
        mdb = 20.0 * np.log10(mag) if mag > 0 else -np.inf
        lines.append(
            f"{i},{tau[i] * 1e9:.6f},{rep[i].real:.6e},{rep[i].imag:.6e},"
            f"{mag:.6e},{mdb:.3f},{np.angle(rep[i]):.6f}"
        )
    return ("\n".join(lines) + "\n").encode()


def _cfr_csv(d: dict) -> bytes:
    """CFR magnitude/phase per subcarrier (first antenna pair / first time step)."""
    h = d["h"]
    freqs = np.asarray(d["frequencies"]).reshape(-1)
    nf = h.shape[-1]
    h0 = h.reshape(-1, nf)[0] if h.size else np.zeros(nf, dtype=complex)
    carrier = float(d["carrier_frequency"])

    lines = [
        "# Channel frequency response (CFR) — paths.cfr(); first antenna pair shown.",
        f"# carrier_frequency_hz={carrier:.6e}",
        "Subcarrier_Index,Frequency_Offset_Hz,Absolute_Frequency_Hz,h_real,h_imag,Magnitude,Magnitude_dB,Phase_rad",
    ]
    for k in range(nf):
        val = h0[k]
        mag = float(np.abs(val))
        mdb = 20.0 * np.log10(mag) if mag > 0 else -np.inf
        f_off = float(freqs[k]) if k < freqs.size else 0.0
        lines.append(
            f"{k},{f_off:.3f},{carrier + f_off:.3f},{val.real:.6e},{val.imag:.6e},"
            f"{mag:.6e},{mdb:.3f},{np.angle(val):.6f}"
        )
    return ("\n".join(lines) + "\n").encode()


def _channel_grid_npz(d: dict) -> bytes:
    """Pack the per-cell ray-traced channel grid into a NumPy ``.npz``.

    Load with ``np.load(path)``; the channel is ``d['h']`` with layout
    ``[n_cells, n_rx_ant, n_tx_ant, n_subcarrier]``. ``synthetic=False`` marks it
    as a real ray-traced channel (vs the frontend's synthetic JSON export).
    """
    buf = io.BytesIO()
    np.savez_compressed(
        buf,
        h=d["h"],                                  # complex per-cell MIMO CFR
        coordinates=d["coordinates"],              # ENU cell centers
        los=d["los"],                              # ray-traced LOS flag
        received_power_dbm=d["received_power_dbm"],
        frequencies=d["frequencies"],              # baseband subcarrier offsets [Hz]
        carrier_frequency=np.asarray(d["carrier_frequency"]),
        subcarrier_spacing=np.asarray(d["subcarrier_spacing"]),
        tx_power_dbm=np.asarray(d["tx_power_dbm"]),
        tx_array=d["tx_array"],                    # [horizontal, vertical]
        rx_array=d["rx_array"],                    # [horizontal, vertical]
        num_tx_ant=np.asarray(d["num_tx_ant"]),
        num_rx_ant=np.asarray(d["num_rx_ant"]),
        h_layout=np.asarray("[n_cells, n_rx_ant, n_tx_ant, n_subcarrier]"),
        synthetic=np.asarray(False),
    )
    return buf.getvalue()


@app.post("/api/channel-grid")
def api_channel_grid(req: ChannelGridRequest) -> Response:
    """Per-cell ray-traced CFR export with physical Tx and Rx array axes."""
    try:
        with _solve_lock:
            data = solve_channel_grid(req)
    except Exception as exc:
        raise _solve_error(exc, "Channel-grid export failed") from exc
    return Response(
        content=_channel_grid_npz(data),
        media_type="application/octet-stream",
        headers={"Content-Disposition": 'attachment; filename="sionna_rt_studio_channel_grid.npz"'},
    )


@app.post("/api/cir")
def api_cir(req: CIRRequest) -> Response:
    """Export native Sionna CIR/CFR tensors for one link or the whole scene."""
    try:
        req.validate_format_scope()
        with _solve_lock:
            data = solve_cir(req)
    except Exception as exc:
        raise _solve_error(exc, "CIR/CFR export failed") from exc

    if req.format == "cir_npz":
        return Response(
            content=_raw_cir_npz(data),
            media_type="application/octet-stream",
            headers={"Content-Disposition": 'attachment; filename="sionna_rt_studio_cir.npz"'},
        )
    if req.format == "cir_csv":
        return Response(
            content=_cir_csv(data),
            media_type="text/csv",
            headers={"Content-Disposition": 'attachment; filename="sionna_rt_studio_cir.csv"'},
        )
    if req.format == "cfr_csv":
        return Response(
            content=_cfr_csv(data),
            media_type="text/csv",
            headers={"Content-Disposition": 'attachment; filename="sionna_rt_studio_cfr.csv"'},
        )
    return Response(
        content=_cir_npz(data),
        media_type="application/octet-stream",
        headers={"Content-Disposition": 'attachment; filename="sionna_rt_studio_cir_cfr.npz"'},
    )


@app.post("/api/cir-bundle")
def api_cir_bundle(req: CIRRequest) -> Response:
    """Export heterogeneous arrays as one ZIP of exact per-pair CIR tensors."""
    try:
        # Hold the lock for the complete bundle so another request cannot
        # interleave with this deterministic sequence of Sionna solves.
        with _solve_lock:
            content = _cir_bundle_zip(req)
    except Exception as exc:
        raise _solve_error(exc, "CIR bundle export failed") from exc
    return Response(
        content=content,
        media_type="application/zip",
        headers={
            "Content-Disposition":
                'attachment; filename="sionna_rt_studio_cir_all_pairs.zip"'
        },
    )


@app.post("/api/scene-export")
def api_scene_export(req: SceneExportRequest) -> Response:
    """Export the traced scene as a standalone Sionna RT project (ZIP)."""
    try:
        # The scene directory is owned by the build cache, so hold the solver
        # lock while copying it out: that is what stops a concurrent solve from
        # evicting the entry (and deleting the meshes) mid-read.
        with _solve_lock:
            content = scene_export_zip(req)
    except Exception as exc:
        raise _solve_error(exc, "Scene export failed") from exc
    return Response(
        content=content,
        media_type="application/zip",
        headers={
            "Content-Disposition":
                'attachment; filename="sionna_rt_studio_scene.zip"'
        },
    )
