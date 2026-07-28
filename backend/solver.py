"""Real Sionna RT solvers mapped onto the frontend's data shapes.

solve_link  -> PropagationPath[] + ChannelMetrics  (PathSolver)
solve_radiomap -> RadioMapGrid                      (RadioMapSolver)

The API and solver share ENU coordinates. The renderer applies only a fixed
ENU-to-Three.js axis permutation/sign change (no geodetic reprojection).
"""
from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

from .models import (
    BuildingFootprint,
    ChannelMetrics,
    CoverageStats,
    ENUVector,
    PropagationPath,
    RadioMapCell,
    RadioMapGrid,
    RadioMapRequest,
    Receiver,
    SolveRequest,
    SolverOptions,
    Transmitter,
)
from .scene_build import build_scene

# Sionna InteractionType codes (sionna.rt.constants.InteractionType).
_INTERACTION_NAMES = {1: "specular", 2: "diffuse", 4: "refraction", 8: "diffraction"}

MAX_PATHS = 15
MAX_DEPTH = 3
# Hard cap on cells for the ray-traced channel-grid export. Cells are solved in
# chunked PathSolver dispatches (chunkSize receivers each), so GPU memory is
# bounded by the chunk — this cap guards total runtime and output size. Keep in
# sync with CHANNEL_GRID_MAX_CELLS in src/components/ExportPanel.tsx.
MAX_CHANNEL_GRID_CELLS = 16384


@dataclass
class _TxSpec:
    """One transmitter resolved for a solve: its scene position, the point its
    beam looks at, its transmit power, and its frontend identity."""
    pos: list[float]
    beam: list[float] | None
    power_dbm: float
    id: str | None = None
    name: str | None = None


def to_numpy(value) -> np.ndarray:
    if isinstance(value, np.ndarray):
        return value
    if np.isscalar(value) or isinstance(value, (list, tuple)):
        return np.asarray(value)
    try:
        import drjit as dr

        return np.asarray(dr.detach(value))
    except Exception:
        if hasattr(value, "numpy"):
            return np.asarray(value.numpy())
        return np.asarray(value)


def _clear_devices(scene) -> None:
    """Remove any transmitters/receivers left on a cached scene from a prior solve.

    Critical: scenes are cached by geometry, so a stale tx from a Link solve would
    otherwise make the radio map see multiple transmitters (path_gain gains a tx
    axis) and break per-cell indexing.
    """
    for attr in ("transmitters", "receivers"):
        try:
            for name in list(getattr(scene, attr).keys()):
                scene.remove(name)
        except Exception:
            pass


def _beam_target(tx_pos, az_deg, el_deg) -> list[float]:
    """A point ~100 m along the steered beam.

    Convention: azimuth degrees clockwise from North (North=0, East=90),
    elevation degrees above the horizon. Matches the 3D beam cone in the UI.
    """
    az = math.radians(float(az_deg or 0.0))
    el = math.radians(float(el_deg or 0.0))
    d = (math.cos(el) * math.sin(az), math.cos(el) * math.cos(az), math.sin(el))
    R = 100.0
    return [float(tx_pos[0] + d[0] * R),
            float(tx_pos[1] + d[1] * R),
            float(tx_pos[2] + d[2] * R)]


def _set_planar_array(
    scene,
    side: str,
    array_size,
    pattern: str,
    polarization: str,
) -> int:
    """Configure one of Sionna's scene-level planar antenna arrays.

    ``array_size`` follows the UI's ``[horizontal, vertical]`` convention, so
    horizontal maps to PlanarArray columns and vertical maps to rows. The return
    value is Sionna's number of linearly polarized antenna ports; dual-polarized
    elements therefore contribute two ports.
    """
    from sionna.rt import PlanarArray

    if side not in ("tx", "rx"):
        raise ValueError(f"Unknown antenna-array side: {side}")
    try:
        cols, rows = int(array_size[0]), int(array_size[1])
    except (IndexError, TypeError, ValueError) as exc:
        raise ValueError(f"{side.upper()} antennaArraySize must be [horizontal, vertical]") from exc
    if cols < 1 or rows < 1:
        raise ValueError(f"{side.upper()} antennaArraySize entries must both be at least 1")

    array = PlanarArray(
        num_rows=rows,
        num_cols=cols,
        vertical_spacing=0.5,
        horizontal_spacing=0.5,
        pattern=pattern,
        polarization=polarization,
    )
    setattr(scene, f"{side}_array", array)
    return int(array.num_ant)


def _uniform_array_size(devices, label: str) -> tuple[int, int]:
    """Return the shared [horizontal, vertical] size or reject mixed arrays."""
    if not devices:
        raise ValueError(f"CIR export needs at least one {label.lower()}")
    try:
        sizes = [tuple(int(v) for v in device.antennaArraySize) for device in devices]
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{label} antennaArraySize must be [horizontal, vertical]") from exc
    if any(len(size) != 2 or size[0] < 1 or size[1] < 1 for size in sizes):
        raise ValueError(f"{label} antennaArraySize entries must both be at least 1")
    if any(size != sizes[0] for size in sizes[1:]):
        raise ValueError(
            f"CIR export requires matching antennaArraySize across {label.lower()}s"
        )
    return sizes[0]


def _set_tx_array(scene, array_size, opts: SolverOptions | None = None) -> int:
    """Set the scene-wide Tx array from the requested Sionna configuration.

    Returns the number of antenna ports. With this array + transmitter orientation,
    the default uniform precoding forms the main lobe along boresight, so the
    beam genuinely steers (both PathSolver and RadioMapSolver respect it).
    """
    opts = opts or SolverOptions()
    return _set_planar_array(
        scene, "tx", array_size, opts.txPattern, opts.txPolarization
    )


def _set_rx_array(scene, array_size, opts: SolverOptions | None = None) -> int:
    """Set the scene-wide Rx array exactly as a Sionna notebook would."""
    opts = opts or SolverOptions()
    return _set_planar_array(
        scene, "rx", array_size, opts.rxPattern, opts.rxPolarization
    )


def _place_tx(scene, name: str, pos: list[float], beam: list[float] | None,
              power_dbm: float | None = None):
    """Add a transmitter to the scene, oriented toward its steered beam target."""
    from sionna.rt import Transmitter as RtTransmitter

    kwargs: dict = {"name": name, "position": pos}
    if power_dbm is not None:
        kwargs["power_dbm"] = float(power_dbm)
    tx_dev = RtTransmitter(**kwargs)
    if beam is not None:
        try:
            tx_dev.look_at([float(v) for v in beam])  # boresight = beam dir
        except Exception:
            pass
    scene.add(tx_dev)
    return tx_dev


def _trace_paths(scene, max_depth: int, opts: SolverOptions | None):
    """Run PathSolver on the scene with the request's interaction switches."""
    from sionna.rt import PathSolver

    opts = opts or SolverOptions()
    return PathSolver()(scene, max_depth=int(max(0, max_depth)),
                        samples_per_src=int(opts.pathSamplesPerSource),
                        seed=int(opts.pathSeed),
                        los=opts.los,
                        specular_reflection=opts.specularReflection,
                        diffuse_reflection=opts.diffuseReflection,
                        refraction=opts.refraction,
                        diffraction=opts.diffraction,
                        edge_diffraction=opts.edgeDiffraction,
                        synthetic_array=True)


def _device_z(enu: ENUVector, height: float, buildings: list[BuildingFootprint]) -> float:
    """Antenna height; if the device sits over a building footprint, it's on the roof."""
    from shapely.geometry import Point, Polygon

    pt = Point(enu.x, enu.y)
    roof = 0.0
    for b in buildings:
        if b.category != "building" or len(b.enuPoints) < 3:
            continue
        try:
            if Polygon([(p.x, p.y) for p in b.enuPoints]).contains(pt):
                roof = max(roof, float(b.height))
        except Exception:
            continue
    return roof + float(height)


def _beamform(a_coeffs: np.ndarray, n_tx_ant: int, num_paths: int) -> np.ndarray:
    """Apply the unit-norm uniform Tx precoder while preserving every Rx port.

    Input is one Tx/Rx-device pair with layout
    ``[num_rx_ant, num_tx_ant, num_paths]`` (a flat array is accepted for the
    pure-math tests). Output is ``[num_rx_ant, num_paths]``. Receive ports are
    deliberately not coherently collapsed: Sionna's physical receive-array
    response, including element patterns and geometry-dependent phase, remains
    intact for the receive-power reduction.
    """
    n_tx = max(1, int(n_tx_ant))
    n_paths = max(0, int(num_paths))
    a = np.asarray(a_coeffs, dtype=complex)
    if n_paths == 0:
        return np.zeros((1, 0), dtype=complex)

    expected_per_rx = n_tx * n_paths
    if a.size % expected_per_rx:
        raise ValueError(
            f"Path coefficient size {a.size} is incompatible with "
            f"{n_tx} Tx ports × {n_paths} paths"
        )
    n_rx = max(1, a.size // expected_per_rx)
    a = a.reshape(n_rx, n_tx, n_paths)
    return a.sum(axis=1) / math.sqrt(n_tx)


def _rx_path_power(a_path: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Return per-path power across physical Rx ports and a phase reference.

    Summing ``|a|²`` over receive ports is the signal-power term used by ideal
    MRC with equal, independent receiver noise. It lets scalar link/mobility
    KPIs benefit from the actual Sionna array response without inventing a
    separate ``10*log10(Nr)`` gain. The strongest port supplies a stable phase
    reference for the legacy scalar path visualization.
    """
    a = np.asarray(a_path, dtype=complex)
    if a.ndim == 1:
        a = a[None, :]
    if a.ndim != 2:
        raise ValueError("Receive path coefficients must be [num_rx_ant, num_paths]")
    power = np.sum(np.abs(a) ** 2, axis=0)
    strongest_port = np.argmax(np.abs(a), axis=0)
    reference = a[strongest_port, np.arange(a.shape[1])]
    return power, reference


def _build_paths(
    valid: np.ndarray,
    tau: np.ndarray,
    a_path: np.ndarray,
    doppler: np.ndarray,
    interactions: np.ndarray,
    vertices: np.ndarray,
    theta_t: np.ndarray,
    phi_t: np.ndarray,
    theta_r: np.ndarray,
    phi_r: np.ndarray,
    tx_pos: list[float],
    rx_pos: list[float],
    power_dbm: float,
    tx_id: str | None = None,
) -> tuple[list[PropagationPath], float]:
    """Turn one receiver's per-path arrays into PropagationPath objects.

    Inputs are already reduced to a single (rx, tx) pair: ``valid``/``tau``/
    ``doppler``/angles are shape ``(num_paths,)`` and ``a_path`` is
    ``(num_rx_ant, num_paths)`` after Tx precoding. ``interactions`` is
    ``(depth, num_paths)`` and ``vertices`` is ``(depth, num_paths, 3)``.
    Returns the full path list (strongest first) plus max |Doppler| [Hz].
    """
    num_paths = int(valid.shape[0])
    depth = int(interactions.shape[0])
    path_power, phase_reference = _rx_path_power(a_path)
    tx_vec = ENUVector(x=tx_pos[0], y=tx_pos[1], z=tx_pos[2])
    rx_vec = ENUVector(x=rx_pos[0], y=rx_pos[1], z=rx_pos[2])

    out: list[PropagationPath] = []
    max_doppler = 0.0
    for p in range(num_paths):
        if not valid[p] or not np.isfinite(tau[p]):
            continue
        bounce_pts: list[ENUVector] = []
        order = 0
        kinds: list[int] = []
        for d in range(depth):
            itype = int(interactions[d, p])
            if itype == 0:  # InteractionType.NONE
                continue
            v = vertices[d, p]
            if not np.all(np.isfinite(v)):
                continue
            bounce_pts.append(ENUVector(x=float(v[0]), y=float(v[1]), z=float(v[2])))
            order += 1
            kinds.append(itype)

        points = [tx_vec, *bounce_pts, rx_vec]
        distance = float(sum(
            math.dist((points[i].x, points[i].y, points[i].z),
                      (points[i + 1].x, points[i + 1].y, points[i + 1].z))
            for i in range(len(points) - 1)
        ))
        # Tx precoding and the physical Sionna Rx array are both already in
        # `path_power`; do not add a separate analytic receive-array gain.
        gain = float(path_power[p])
        rx_power = power_dbm + 10.0 * math.log10(max(gain, 1e-30))
        path_loss = power_dbm - rx_power
        if np.isfinite(doppler[p]):
            max_doppler = max(max_doppler, abs(float(doppler[p])))
        aod_az, aod_el = _az_el(theta_t[p], phi_t[p])
        aoa_az, aoa_el = _az_el(theta_r[p], phi_r[p])
        out.append(PropagationPath(
            id=f"path_{p}",
            points=points,
            type=_path_type(order, kinds),
            order=order,
            distance=distance,
            pathLossDb=path_loss,
            receivedPowerDbm=rx_power,
            delayNs=float(tau[p]) * 1e9,
            phasesRad=[float(np.angle(phase_reference[p]))],
            materialsReached=[],
            interactionKinds=[_INTERACTION_NAMES.get(k, "other") for k in kinds],
            aodAzimuthDeg=aod_az, aodElevationDeg=aod_el,
            aoaAzimuthDeg=aoa_az, aoaElevationDeg=aoa_el,
            txId=tx_id,
        ))

    out.sort(key=lambda pp: pp.receivedPowerDbm, reverse=True)
    return out, max_doppler


def _solve_at(
    scene,
    tx_pos: list[float],
    rx_pos: list[float],
    power_dbm: float,
    n_tx_ant: int,
    beam_target: list[float] | None = None,
    rx_velocity: list[float] | None = None,
    max_depth: int = MAX_DEPTH,
    opts: SolverOptions | None = None,
    tx_id: str | None = None,
) -> tuple[list[PropagationPath], float]:
    """Run PathSolver for one Tx/Rx placement; return paths + max |Doppler| (Hz).

    Returns the *full* path list (sorted by received power, strongest first).
    Channel KPIs are computed over this complete set by the caller; the display
    cap to MAX_PATHS is applied separately so the metrics stay faithful to Sionna.

    The Tx is oriented toward ``beam_target`` (real beamsteering): its directive
    array is combined with uniform precoding, so paths off the beam get less power.
    """
    from sionna.rt import Receiver as RtReceiver

    _clear_devices(scene)
    _place_tx(scene, "tx_d", tx_pos, beam_target)
    rx_dev = RtReceiver(name="rx_d", position=rx_pos)
    if rx_velocity is not None:
        try:
            rx_dev.velocity = [float(v) for v in rx_velocity]
        except Exception:
            pass
    scene.add(rx_dev)

    paths = _trace_paths(scene, max_depth, opts)

    valid = np.squeeze(to_numpy(paths.valid)).astype(bool).reshape(-1)
    num_paths = int(valid.shape[0])
    if num_paths == 0:
        return [], 0.0

    vraw = to_numpy(paths.vertices)
    depth = vraw.shape[0]
    vertices = vraw.reshape(depth, -1, 3).reshape(depth, num_paths, 3)
    interactions = to_numpy(paths.interactions).reshape(depth, num_paths)
    tau = np.squeeze(to_numpy(paths.tau)).reshape(-1)[:num_paths]
    a_real, a_imag = paths.a
    a_full = to_numpy(a_real).astype(float) + 1j * to_numpy(a_imag).astype(float)
    # One device pair: [num_rx_ant, num_tx_ant, num_paths]. Apply only the Tx
    # precoder and preserve every physical receive port.
    a_pair = a_full[0, :, 0, :, :]
    a_path = _beamform(a_pair, n_tx_ant, num_paths)
    try:
        doppler = np.squeeze(to_numpy(paths.doppler)).reshape(-1)[:num_paths]
    except Exception:
        doppler = np.zeros(num_paths)

    # Angles of departure (Tx) / arrival (Rx): zenith (theta) + azimuth (phi) [rad].
    def _angles(attr) -> np.ndarray:
        try:
            return np.squeeze(to_numpy(getattr(paths, attr))).reshape(-1)[:num_paths]
        except Exception:
            return np.full(num_paths, np.nan)

    theta_t, phi_t = _angles("theta_t"), _angles("phi_t")
    theta_r, phi_r = _angles("theta_r"), _angles("phi_r")

    # Build PropagationPaths from this single (rx, tx) pair. The caller computes
    # KPIs over the FULL returned list and caps to MAX_PATHS only for display —
    # Sionna's PathSolver can emit far more than MAX_PATHS, so truncating before
    # the metrics would understate path count and delay spread.
    return _build_paths(valid, tau, a_path, doppler, interactions, vertices,
                        theta_t, phi_t, theta_r, phi_r,
                        tx_pos, rx_pos, power_dbm, tx_id=tx_id)


def _solve_batched(
    scene,
    tx_specs: list[_TxSpec],
    rx_positions: list[list[float]],
    rx_velocities: list[list[float]],
    n_tx_ant: int,
    max_depth: int = MAX_DEPTH,
    opts: SolverOptions | None = None,
) -> list[list[tuple[list[PropagationPath], float]]]:
    """Ray-trace every (waypoint, transmitter) pair in a SINGLE PathSolver dispatch.

    Sionna computes paths independently per (rx, tx) pair, so adding every
    transmitter AND every waypoint-receiver to the scene and solving once yields
    the same per-pair paths as calling ``_solve_at`` for each — but with one GPU
    launch instead of N×M (the mobility speed-up, now spanning all transmitters).

    With ``synthetic_array`` the geometric tensors carry explicit rx/tx axes:
    valid/tau/doppler/angles are ``(num_rx, num_tx, num_paths)``, interactions
    ``(depth, num_rx, num_tx, num_paths)``, vertices ``(…, 3)``, and the
    coefficients a are ``(num_rx, num_rx_ant, num_tx, num_tx_ant, num_paths)``.

    Returns ``results[rx_index][tx_index] = (paths, max|Doppler|)`` — one entry
    per transmitter for each receiver, both in input order.
    """
    from sionna.rt import Receiver as RtReceiver

    _clear_devices(scene)
    for j, spec in enumerate(tx_specs):
        _place_tx(scene, f"tx_b_{j}", spec.pos, spec.beam)
    for i, (pos, vel) in enumerate(zip(rx_positions, rx_velocities)):
        rx_dev = RtReceiver(name=f"rx_b_{i}", position=pos)
        try:
            rx_dev.velocity = [float(v) for v in vel]  # per-rx Doppler heading
        except Exception:
            pass
        scene.add(rx_dev)

    paths = _trace_paths(scene, max_depth, opts)

    valid = to_numpy(paths.valid).astype(bool)     # (num_rx, num_tx, num_paths)
    num_rx = valid.shape[0]
    num_tx = valid.shape[1]
    num_paths = valid.shape[-1]
    tau = to_numpy(paths.tau)
    a_real, a_imag = paths.a
    a_full = to_numpy(a_real).astype(float) + 1j * to_numpy(a_imag).astype(float)
    inter = to_numpy(paths.interactions)
    vert = to_numpy(paths.vertices)
    depth = vert.shape[0]
    try:
        dopp = to_numpy(paths.doppler)
    except Exception:
        dopp = np.zeros_like(tau)

    def _ang(attr) -> np.ndarray:
        try:
            return to_numpy(getattr(paths, attr))
        except Exception:
            return np.full((num_rx, num_tx, num_paths), np.nan)

    theta_t, phi_t = _ang("theta_t"), _ang("phi_t")
    theta_r, phi_r = _ang("theta_r"), _ang("phi_r")

    results: list[list[tuple[list[PropagationPath], float]]] = []
    for r in range(num_rx):
        per_tx: list[tuple[list[PropagationPath], float]] = []
        for t in range(num_tx):
            valid_rt = valid[r, t, :].reshape(-1)
            if valid_rt.shape[0] == 0:
                per_tx.append(([], 0.0))
                continue
            tau_rt = tau[r, t, :].reshape(-1)[:num_paths]
            # Preserve the physical Rx-port axis while applying the same
            # unit-norm Tx precoder as the single-pair solve.
            a_path_rt = _beamform(a_full[r, :, t, :, :], n_tx_ant, num_paths)
            dopp_rt = dopp[r, t, :].reshape(-1)[:num_paths]
            inter_rt = inter[:, r, t, :].reshape(depth, num_paths)
            vert_rt = vert[:, r, t, :, :].reshape(depth, num_paths, 3)
            tt_rt = theta_t[r, t, :].reshape(-1)[:num_paths]
            pt_rt = phi_t[r, t, :].reshape(-1)[:num_paths]
            tr_rt = theta_r[r, t, :].reshape(-1)[:num_paths]
            pr_rt = phi_r[r, t, :].reshape(-1)[:num_paths]
            spec = tx_specs[t]
            per_tx.append(_build_paths(valid_rt, tau_rt, a_path_rt, dopp_rt, inter_rt, vert_rt,
                                       tt_rt, pt_rt, tr_rt, pr_rt,
                                       spec.pos, rx_positions[r], spec.power_dbm,
                                       tx_id=spec.id))
        results.append(per_tx)
    return results


def solve_link(req: SolveRequest) -> tuple[list[PropagationPath], ChannelMetrics]:
    scene = build_scene(req.buildings, req.freqGhz, req.materials)
    tx_pos = [float(req.tx.enu.x), float(req.tx.enu.y),
              _device_z(req.tx.enu, req.tx.height, req.buildings)]
    rx_pos = [float(req.rx.enu.x), float(req.rx.enu.y),
              _device_z(req.rx.enu, req.rx.height, req.buildings)]
    n_tx_ant = _set_tx_array(scene, req.tx.antennaArraySize, req.options)
    _set_rx_array(scene, req.rx.antennaArraySize, req.options)
    beam = _beam_target(tx_pos, req.tx.beamsteeringAzimuth, req.tx.beamsteeringElevation)
    paths, _ = _solve_at(scene, tx_pos, rx_pos, req.tx.powerDbm, n_tx_ant,
                         beam_target=beam, max_depth=req.maxDepth,
                         opts=req.options)
    # KPIs over the full path set; only the displayed rays are capped to MAX_PATHS.
    metrics = _channel_metrics(paths)
    return paths[:MAX_PATHS], metrics


def _cir_request_devices(req, plural: str, singular: str, label: str):
    """Resolve multi-device CIR fields while retaining KPI/PHY request support."""
    resolver = getattr(req, plural, None)
    if callable(resolver):
        return resolver()
    devices = getattr(req, f"{singular}s", None)
    if devices:
        return list(devices)
    device = getattr(req, singular, None)
    if device is not None:
        return [device]
    raise ValueError(f"CIR export needs `{singular}s` or `{singular}` ({label})")


def _notebook_tau_shape(a, tau) -> np.ndarray:
    """Return delays with the antenna axes shown in the Sionna RT tutorial.

    With synthetic arrays, Sionna 2.0.1 can return geometric delays as
    [rx, tx, path]. Every synthetic antenna pair shares those delays, so they
    can be broadcast losslessly to [rx, rx_ant, tx, tx_ant, path].
    """
    a_array = np.asarray(a)
    tau_array = np.asarray(tau, dtype=float)
    expected_shape = a_array.shape[:-1]
    if tau_array.shape == expected_shape:
        return tau_array
    if (
        a_array.ndim == 6
        and tau_array.ndim == 3
        and tau_array.shape
        == (a_array.shape[0], a_array.shape[2], a_array.shape[4])
    ):
        return np.broadcast_to(
            tau_array[:, np.newaxis, :, np.newaxis, :],
            expected_shape,
        ).copy()
    raise ValueError(
        f"Unexpected CIR delay shape {tau_array.shape} "
        f"for coefficient shape {a_array.shape}"
    )


def solve_cir(req) -> dict:
    """Run one PathSolver dispatch for all requested devices and return CIR/CFR.

    Faithful to the Python workflow::

        # Add every Tx and Rx to the same scene first
        p_solver = PathSolver()
        paths = p_solver(scene, max_depth=...)
        a, tau = paths.cir(normalize_delays=..., out_type="numpy")
        freqs = subcarrier_frequencies(num_subcarriers, subcarrier_spacing)
        h = paths.cfr(frequencies=freqs, normalize_delays=..., out_type="numpy")

    ``a`` has native Sionna layout
    [num_rx, num_rx_ant, num_tx, num_tx_ant, num_paths, num_time_steps],
    while synthetic-array ``tau`` may use the compact geometric layout
    [num_rx, num_tx, num_paths]. The NPZ writer broadcasts those shared delays
    over antenna axes for compatibility with the Sionna tutorial layout.
    """
    from sionna.rt import Receiver as RtReceiver, subcarrier_frequencies

    txs = _cir_request_devices(req, "transmitters", "tx", "transmitter")
    rxs = _cir_request_devices(req, "receivers", "rx", "receiver")
    tx_size = _uniform_array_size(txs, "Transmitter")
    rx_size = _uniform_array_size(rxs, "Receiver")

    scene = build_scene(req.buildings, req.freqGhz, getattr(req, "materials", None))
    tx_positions = np.asarray([
        [float(tx.enu.x), float(tx.enu.y),
         _device_z(tx.enu, tx.height, req.buildings)]
        for tx in txs
    ], dtype=float)
    rx_positions = np.asarray([
        [float(rx.enu.x), float(rx.enu.y),
         _device_z(rx.enu, rx.height, req.buildings)]
        for rx in rxs
    ], dtype=float)
    n_tx_ant = _set_tx_array(scene, tx_size, req.options)
    n_rx_ant = _set_rx_array(scene, rx_size, req.options)

    _clear_devices(scene)
    for index, (tx, tx_pos_arr) in enumerate(zip(txs, tx_positions)):
        tx_pos = tx_pos_arr.tolist()
        beam = _beam_target(
            tx_pos, tx.beamsteeringAzimuth, tx.beamsteeringElevation
        )
        _place_tx(scene, f"tx_cir_{index}", tx_pos, beam)
    for index, rx_pos in enumerate(rx_positions):
        scene.add(RtReceiver(name=f"rx_cir_{index}", position=rx_pos.tolist()))

    paths = _trace_paths(scene, req.maxDepth, req.options)

    # CIR: complex baseband path coefficients a and propagation delays tau [s].
    a, tau = paths.cir(normalize_delays=bool(req.normalizeDelays), out_type="numpy")

    # Raw CIR export deliberately does not construct a frequency grid or CFR.
    include_cfr = getattr(req, "format", "npz") != "cir_npz"
    num_sc = max(1, int(req.numSubcarriers)) if include_cfr else 0
    spacing = float(req.subcarrierSpacing)
    if include_cfr:
        freqs = subcarrier_frequencies(num_sc, spacing)
        h = paths.cfr(
            frequencies=freqs,
            normalize_delays=bool(req.normalizeDelays),
            out_type="numpy",
        )
        frequencies = np.asarray(to_numpy(freqs), dtype=float)
        h_array = np.asarray(h)
    else:
        frequencies = np.asarray([], dtype=float)
        h_array = None

    a_array = np.asarray(a)

    return {
        "a": a_array,                              # complex CIR coefficients
        "tau": np.asarray(tau, dtype=float),        # delays [s]
        "h": h_array,                              # complex CFR (None for raw CIR)
        "frequencies": frequencies,                # baseband offsets [Hz]
        "carrier_frequency": float(np.asarray(to_numpy(scene.frequency)).reshape(-1)[0]),
        "subcarrier_spacing": spacing,
        "num_subcarriers": num_sc,
        "num_paths": int(a_array.shape[-2]) if a_array.ndim >= 2 else 0,
        "num_tx": len(txs),
        "num_rx": len(rxs),
        "num_tx_ant": n_tx_ant,
        "num_rx_ant": n_rx_ant,
        "tx_array": np.asarray(tx_size, dtype=int),
        "rx_array": np.asarray(rx_size, dtype=int),
        "tx_ids": np.asarray([tx.id for tx in txs], dtype=str),
        "rx_ids": np.asarray([rx.id for rx in rxs], dtype=str),
        "tx_names": np.asarray([tx.name for tx in txs], dtype=str),
        "rx_names": np.asarray([rx.name for rx in rxs], dtype=str),
        "tx_positions": tx_positions,
        "rx_positions": rx_positions,
    }


def solve_channel_grid(req) -> dict:
    """Ray-trace a per-cell channel grid over the radio-map cells.

    This is the physics-based counterpart to the frontend's coverage proxy.
    For every cell it runs Sionna's PathSolver and keeps the real
    ``paths.cfr()`` channel frequency response with its full Tx- and Rx-antenna
    axes rather than a beamformed scalar, plus ray-traced LOS and
    channel-derived received power. Receivers are batched ``chunkSize`` at a
    time into PathSolver dispatches, so the whole grid costs a handful of GPU
    launches instead of one per cell.

    Returns NumPy arrays ready for ``.npz`` packing::

        h                  complex64 [n_cells, n_rx_ant, n_tx_ant, n_subcarrier]
        coordinates        float     [n_cells, 3]  (ENU)
        los                bool      [n_cells]     (order-0 path present)
        received_power_dbm float     [n_cells]
    """
    from sionna.rt import Receiver as RtReceiver, subcarrier_frequencies

    cells = req.cells
    n_cells = len(cells)
    if n_cells == 0:
        raise ValueError("Channel-grid export needs at least one cell")
    if n_cells > MAX_CHANNEL_GRID_CELLS:
        raise ValueError(
            f"Ray-traced channel export is capped at {MAX_CHANNEL_GRID_CELLS} cells "
            f"({n_cells} requested). Recompute coverage with a coarser grid size."
        )

    scene = build_scene(req.buildings, req.freqGhz, getattr(req, "materials", None))
    # Both arrays are physical Sionna PlanarArrays. Every cell Receiver shares
    # this one scene.rx_array, matching the scene-level array rule.
    n_tx_ant = _set_tx_array(scene, req.tx.antennaArraySize, req.options)
    rx_size = req.rx.antennaArraySize if req.rx is not None else (1, 1)
    n_rx_ant = _set_rx_array(scene, rx_size, req.options)
    tx_pos = [float(req.tx.enu.x), float(req.tx.enu.y),
              _device_z(req.tx.enu, req.tx.height, req.buildings)]
    beam = _beam_target(tx_pos, req.tx.beamsteeringAzimuth, req.tx.beamsteeringElevation)

    num_sc = max(1, int(req.numSubcarriers))
    spacing = float(req.subcarrierSpacing)
    freqs = subcarrier_frequencies(num_sc, spacing)
    opts = req.options
    chunk = max(1, int(req.chunkSize))

    # Cell centers are used verbatim as receiver positions so the exported
    # coordinates line up 1:1 with the displayed coverage grid.
    coords = np.array([[float(c.x), float(c.y), float(c.z)] for c in cells], dtype=float)
    h_blocks: list[np.ndarray] = []
    los_all = np.zeros(n_cells, dtype=bool)
    power_all = np.full(n_cells, -np.inf, dtype=float)

    for start in range(0, n_cells, chunk):
        block = coords[start:start + chunk]
        _clear_devices(scene)
        _place_tx(scene, "tx_grid", tx_pos, beam)
        for i, pos in enumerate(block):
            scene.add(RtReceiver(name=f"rx_grid_{i}",
                                 position=[float(pos[0]), float(pos[1]), float(pos[2])]))

        paths = _trace_paths(scene, req.maxDepth, opts)

        # CFR sampled on the OFDM grid. Sionna returns the per-antenna channel as
        # [num_rx, num_rx_ant, num_tx, num_tx_ant, num_time, num_sc] — with one
        # transmitter and no mobility the num_tx / num_time axes are singletons.
        # Reshape to a fixed [num_rx, num_rx_ant, num_tx_ant, num_sc] layout from
        # the known dims (the size-1 axes fold away without reordering).
        h = np.asarray(paths.cfr(frequencies=freqs,
                                 normalize_delays=bool(req.normalizeDelays),
                                 out_type="numpy"))
        nrx = len(block)
        expected = nrx * n_rx_ant * n_tx_ant * num_sc
        if h.size != expected:
            raise ValueError(
                f"Unexpected CFR size {h.size}; expected {expected} for "
                f"{nrx} receivers × {n_rx_ant} Rx ports × "
                f"{n_tx_ant} Tx ports × {num_sc} subcarriers"
            )
        h = h.reshape(nrx, n_rx_ant, n_tx_ant, num_sc)
        h_blocks.append(h.astype(np.complex64))

        # Ray-traced LOS: a valid path with zero interactions (order 0) exists.
        valid = to_numpy(paths.valid).astype(bool)   # [num_rx, num_tx, num_paths]
        inter = to_numpy(paths.interactions)          # [depth, num_rx, num_tx, num_paths]
        for r in range(nrx):
            vr = valid[r, 0, :].reshape(-1)
            if inter.ndim == 4 and inter.size:
                order = (inter[:, r, 0, :] != 0).sum(axis=0).reshape(-1)
                los_all[start + r] = bool(np.any(vr & (order == 0)))
            else:
                los_all[start + r] = bool(np.any(vr))

        # Received power with unit-norm uniform Tx precoding. Sum physical Rx-port
        # powers (the MRC signal-power term), then average over subcarriers.
        hb = h.sum(axis=2) / math.sqrt(max(1, n_tx_ant))   # [num_rx, num_rx_ant, num_sc]
        p_lin = (np.abs(hb) ** 2).sum(axis=1).mean(axis=1)  # [num_rx]
        with np.errstate(divide="ignore"):
            p_dbm = float(req.tx.powerDbm) + 10.0 * np.log10(p_lin)
        p_dbm[~np.isfinite(p_dbm)] = -np.inf
        power_all[start:start + nrx] = p_dbm

    H = (np.concatenate(h_blocks, axis=0) if h_blocks
         else np.zeros((0, 1, max(1, n_tx_ant), num_sc), dtype=np.complex64))
    carrier = float(np.asarray(to_numpy(scene.frequency)).reshape(-1)[0])
    return {
        "h": H,                                # [n_cells, n_rx_ant, n_tx_ant, n_sc]
        "coordinates": coords,                 # [n_cells, 3] ENU
        "los": los_all,                        # [n_cells] ray-traced LOS
        "received_power_dbm": power_all,       # [n_cells]
        "frequencies": np.asarray(to_numpy(freqs), dtype=float),
        "carrier_frequency": carrier,
        "subcarrier_spacing": spacing,
        "tx_power_dbm": float(req.tx.powerDbm),
        # [horizontal, vertical] element counts, as configured in the UI.
        "tx_array": np.asarray([int(req.tx.antennaArraySize[0]),
                                int(req.tx.antennaArraySize[1])]),
        "rx_array": np.asarray([int(rx_size[0]), int(rx_size[1])]),
        "num_tx_ant": n_tx_ant,
        "num_rx_ant": n_rx_ant,
        "num_cells": n_cells,
    }


def _mobility_step(
    index: int,
    rx_pos: list[float],
    tx_specs: list[_TxSpec],
    per_tx_results: list[tuple[list[PropagationPath], float]],
    combine: str = "best_server",
):
    """Assemble one waypoint's MobilityStep from each transmitter's solved link.

    ``combine`` selects what the scalar KPIs report:

    * ``"best_server"`` — the single strongest transmitter (instantaneous
      association); its metrics become the headline and ``servingTx*`` names it.
    * ``"sum"`` — non-coherent incident power aggregated over every transmitter;
      there is no single server, so ``servingTx*`` is left unset. A joint delay
      spread is deliberately not reported because independent transmitters do
      not share a delay/phase reference without an explicit synchronization
      model; their individual delay spreads remain available in ``perTx``.

    Either way the rays from every transmitter are merged (strongest first, each
    tagged with its ``txId``) so the scene shows all links and association changes.
    """
    from .models import MobilityStep, TxLinkMetrics

    per_tx_metrics: list[TxLinkMetrics] = []
    union_paths: list[PropagationPath] = []   # capped per-Tx, for display
    best_idx = -1
    best_power = -math.inf
    best_metrics: ChannelMetrics | None = None
    best_doppler = 0.0
    max_doppler_all = 0.0

    for t, (paths_t, dop_t) in enumerate(per_tx_results):
        metrics_t = _channel_metrics(paths_t)
        spec = tx_specs[t]
        per_tx_metrics.append(TxLinkMetrics(
            txId=spec.id or f"tx_{t}",
            txName=spec.name or f"Tx {t + 1}",
            receivedPowerDbm=metrics_t.totalRxPowerDbm,
            rmsDelaySpreadNs=metrics_t.rmsDelaySpreadNs,
            numPaths=metrics_t.numPaths,
            maxDopplerHz=float(dop_t),
            losStatus=metrics_t.losStatus,
        ))
        # Cap each Tx's rays to MAX_PATHS for display (KPIs use the full set);
        # the union across transmitters is what the 3D scene renders.
        union_paths.extend(paths_t[:MAX_PATHS])
        max_doppler_all = max(max_doppler_all, float(dop_t))
        if paths_t and metrics_t.totalRxPowerDbm > best_power:
            best_power = metrics_t.totalRxPowerDbm
            best_idx = t
            best_metrics = metrics_t
            best_doppler = float(dop_t)

    union_paths.sort(key=lambda pp: pp.receivedPowerDbm, reverse=True)
    rx_vec = ENUVector(x=rx_pos[0], y=rx_pos[1], z=rx_pos[2])

    if best_metrics is None:  # no transmitter reached this waypoint
        empty = _empty_metrics()
        return MobilityStep(
            index=index, rxPosition=rx_vec,
            receivedPowerDbm=empty.totalRxPowerDbm,
            rmsDelaySpreadNs=empty.rmsDelaySpreadNs,
            rmsDelaySpreadValid=combine != "sum",
            numPaths=0, maxDopplerHz=0.0, losStatus=empty.losStatus,
            paths=[], perTx=per_tx_metrics,
        )

    if combine == "sum":
        # Non-coherent total incident power. Do not merge delays/phases across
        # independently transmitting cells: that would silently assume a shared
        # clock and waveform. Per-Tx channel metrics above remain well defined.
        reachable = [metric for metric in per_tx_metrics if metric.numPaths > 0]
        total_mw = sum(10.0 ** (m.receivedPowerDbm / 10.0) for m in reachable)
        # -200 dBm is the API's finite no-path sentinel. Summing sentinel
        # values would manufacture a 10*log10(N_tx) gain, so exclude them.
        aggregate_dbm = (10.0 * math.log10(max(total_mw, 1e-30))
                         if reachable else -300.0)
        return MobilityStep(
            index=index, rxPosition=rx_vec,
            receivedPowerDbm=aggregate_dbm,
            rmsDelaySpreadNs=0.0,
            rmsDelaySpreadValid=False,
            numPaths=sum(m.numPaths for m in per_tx_metrics),
            maxDopplerHz=max_doppler_all,
            losStatus="LOS" if any(m.losStatus == "LOS" for m in reachable) else "NLOS",
            paths=union_paths,
            servingTxId=None,        # combined over all Tx — no single server
            servingTxName=None,
            perTx=per_tx_metrics,
        )

    serving = tx_specs[best_idx]
    return MobilityStep(
        index=index, rxPosition=rx_vec,
        receivedPowerDbm=best_metrics.totalRxPowerDbm,
        rmsDelaySpreadNs=best_metrics.rmsDelaySpreadNs,
        numPaths=best_metrics.numPaths,
        maxDopplerHz=best_doppler,
        losStatus=best_metrics.losStatus,
        paths=union_paths,
        servingTxId=serving.id,
        servingTxName=serving.name,
        perTx=per_tx_metrics,
    )


def solve_mobility(req) -> tuple[list, dict, "HandoverAnalysis | None"]:
    """Best-server mobility: ray-trace EVERY transmitter to each Rx waypoint.

    All transmitters and all waypoints go into a single batched PathSolver
    dispatch (Sionna solves each (rx, tx) pair independently). For every waypoint
    each Tx's link is kept, the strongest becomes the serving cell (the step's
    scalar KPIs), and the union of all Tx rays is returned so the scene shows
    every link and association changes as the Rx moves. Falls back to
    per-(waypoint, Tx) solves if the batched extraction fails, so mobility always
    returns a result. With ≥ 2 transmitters the per-Tx RSS series is additionally
    run through the A3 hysteresis/TTT state machine (backend/handover.py).
    """
    import sys

    txs = req.transmitters()
    combine = getattr(req, "combineMode", "best_server")
    execution_mode = getattr(req, "executionMode", "auto")
    scene = build_scene(req.buildings, req.freqGhz, getattr(req, "materials", None))

    # One scene tx_array is shared by every transmitter (Sionna), so they must use
    # the same antenna geometry — the same rule the multi-Tx radio map enforces.
    array_sizes = [tuple(int(v) for v in t.antennaArraySize) for t in txs]
    if any(size != array_sizes[0] for size in array_sizes):
        raise ValueError(
            "Multi-transmitter mobility requires matching antennaArraySize across transmitters"
        )

    n_tx_ant = _set_tx_array(scene, txs[0].antennaArraySize, req.options)
    _set_rx_array(scene, req.rx.antennaArraySize, req.options)

    # Resolve each transmitter once (scene position, steered beam target, power).
    tx_specs: list[_TxSpec] = []
    for t in txs:
        pos = [float(t.enu.x), float(t.enu.y), _device_z(t.enu, t.height, req.buildings)]
        beam = _beam_target(pos, t.beamsteeringAzimuth, t.beamsteeringElevation)
        tx_specs.append(_TxSpec(pos=pos, beam=beam, power_dbm=float(t.powerDbm),
                                id=t.id, name=t.name))

    speed_ms = float(req.speedKmh) / 3.6
    wps = req.waypoints
    # Per-waypoint Rx position + velocity (heading toward the next waypoint; the
    # last waypoint reuses the previous heading), shared by both solve paths.
    rx_positions: list[list[float]] = []
    velocities: list[list[float]] = []
    for i, wp in enumerate(wps):
        rx_positions.append([float(wp.x), float(wp.y),
                             _device_z(wp, req.rx.height, req.buildings)])
        nxt = wps[i + 1] if i + 1 < len(wps) else wps[i - 1] if i > 0 else None
        velocity = [0.0, 0.0, 0.0]
        if nxt is not None:
            dx, dy = float(nxt.x) - float(wp.x), float(nxt.y) - float(wp.y)
            norm = math.hypot(dx, dy)
            if i + 1 >= len(wps):
                dx, dy = -dx, -dy  # keep heading direction on the last point
            if norm > 1e-6:
                velocity = [dx / norm * speed_ms, dy / norm * speed_ms, 0.0]
        velocities.append(velocity)

    # Fast path: one GPU dispatch for all (waypoint, Tx) pairs. Defensive fallback
    # to per-(waypoint, Tx) solves if the batched extraction misbehaves.
    per_wp: list[list[tuple[list, float]]] | None = None
    if execution_mode != "serial_reference":
        try:
            per_wp = _solve_batched(scene, tx_specs, rx_positions, velocities,
                                    n_tx_ant,
                                    max_depth=req.maxDepth, opts=req.options)
            if len(per_wp) != len(wps):
                per_wp = None
        except Exception as exc:  # pragma: no cover - defensive fallback
            print(f"[solver] batched mobility solve failed ({exc}); using per-waypoint path",
                  file=sys.stderr)
            per_wp = None
        if execution_mode == "batched" and per_wp is None:
            raise RuntimeError("Required batched mobility execution did not produce a valid result")

    batched_result_used = per_wp is not None
    steps: list = []
    for i in range(len(wps)):
        if per_wp is not None:
            per_tx_results = per_wp[i]
        else:
            per_tx_results = [
                _solve_at(scene, spec.pos, rx_positions[i], spec.power_dbm,
                          n_tx_ant, beam_target=spec.beam,
                          rx_velocity=velocities[i], max_depth=req.maxDepth,
                          opts=req.options, tx_id=spec.id)
                for spec in tx_specs
            ]
        steps.append(_mobility_step(i, rx_positions[i], tx_specs, per_tx_results, combine))
    pair_count = len(wps) * len(tx_specs)
    strategy = ("single_batched_dispatch" if batched_result_used else
                "serial_reference" if execution_mode == "serial_reference" else
                "serial_pair_fallback")
    execution = {
        "strategy": strategy,
        "batchedResultUsed": batched_result_used,
        "transmitterCount": len(tx_specs),
        "waypointCount": len(wps),
        "pairCount": pair_count,
        # Counts only successful PathSolver calls. A failed batched attempt is
        # intentionally not advertised as a completed dispatch.
        "successfulPathSolverDispatches": 1 if batched_result_used else pair_count,
        "samplesPerSource": int(req.options.pathSamplesPerSource),
        "seed": int(req.options.pathSeed),
    }
    return steps, execution, _handover_analysis(req, steps, tx_specs, rx_positions, speed_ms)


def _handover_analysis(req, steps: list, tx_specs: list[_TxSpec],
                       rx_positions: list[list[float]], speed_ms: float):
    """A3 hysteresis/TTT association over the solved per-Tx RSS series.

    Post-processing only (no GPU): meaningful with ≥ 2 transmitters, else None.
    """
    from .handover import a3_association, step_durations
    from .models import HandoverAnalysis, HandoverConfig, HandoverEvent

    if len(tx_specs) < 2 or not steps:
        return None
    cfg = getattr(req, "handover", None) or HandoverConfig()
    rss = [[m.receivedPowerDbm for m in s.perTx] for s in steps]
    result = a3_association(
        rss, step_durations(rx_positions, speed_ms),
        hysteresis_db=float(cfg.hysteresisDb),
        ttt_s=float(cfg.timeToTriggerMs) / 1000.0,
        ping_pong_window_s=float(cfg.pingPongWindowS),
    )

    def _tx_id(i: int) -> str:
        return tx_specs[i].id or f"tx_{i}"

    def _tx_name(i: int) -> str:
        return tx_specs[i].name or f"Tx {i + 1}"

    events = [HandoverEvent(stepIndex=e["stepIndex"], timeS=e["timeS"],
                            fromTxId=_tx_id(e["fromIdx"]), fromTxName=_tx_name(e["fromIdx"]),
                            toTxId=_tx_id(e["toIdx"]), toTxName=_tx_name(e["toIdx"]),
                            pingPong=e["pingPong"])
              for e in result["events"]]
    return HandoverAnalysis(
        hysteresisDb=float(cfg.hysteresisDb),
        timeToTriggerMs=float(cfg.timeToTriggerMs),
        pingPongWindowS=float(cfg.pingPongWindowS),
        servingTxIds=[_tx_id(i) if i >= 0 else None for i in result["servingIdx"]],
        events=events,
        handoverCount=len(events),
        pingPongCount=sum(1 for e in events if e.pingPong),
        instantaneousChangeCount=int(result["instantaneousChanges"]),
    )


def _az_el(theta_rad: float, phi_rad: float) -> tuple[float | None, float | None]:
    """Convert Sionna (zenith theta, azimuth phi) [rad] to the app's convention:
    azimuth clockwise from North (0=N, 90=E) in [-180,180], elevation above horizon."""
    if not (np.isfinite(theta_rad) and np.isfinite(phi_rad)):
        return None, None
    elevation = 90.0 - math.degrees(float(theta_rad))      # zenith → elevation
    az = 90.0 - math.degrees(float(phi_rad))               # math (from E, CCW) → from N, CW
    az = ((az + 180.0) % 360.0) - 180.0                    # wrap to [-180, 180]
    return float(az), float(elevation)


def _path_type(order: int, kinds: list[int]) -> str:
    if order == 0:
        return "LOS"
    if any(k == 8 for k in kinds):  # DIFFRACTION
        return "Diffraction"
    if all(k == 1 for k in kinds):  # SPECULAR
        return "Reflection"
    return "NLOS"


def _segment_has_building_los(
    start: list[float],
    end: list[float],
    buildings: list[BuildingFootprint],
) -> bool:
    """Approximate LOS test for radio-map cells using the scene footprints."""
    from shapely.geometry import LineString, Polygon

    line = LineString([(float(start[0]), float(start[1])), (float(end[0]), float(end[1]))])
    for b in buildings:
        if b.category != "building" or len(b.enuPoints) < 3:
            continue
        try:
            poly = Polygon([(p.x, p.y) for p in b.enuPoints])
            if poly.is_empty or not line.intersects(poly):
                continue
        except Exception:
            continue

        # If the 2D segment crosses the footprint, sample the segment near the
        # building center. If the ray is below the roof there, LOS is blocked.
        bx, by = poly.centroid.x, poly.centroid.y
        dx, dy = float(end[0]) - float(start[0]), float(end[1]) - float(start[1])
        denom = dx * dx + dy * dy
        if denom <= 1e-9:
            continue
        t = max(0.0, min(1.0, ((bx - float(start[0])) * dx + (by - float(start[1])) * dy) / denom))
        z_at_building = float(start[2]) + t * (float(end[2]) - float(start[2]))
        if 0.0 <= z_at_building <= float(b.height):
            return False
    return True


def _empty_metrics() -> ChannelMetrics:
    return ChannelMetrics(totalRxPowerDbm=-200.0, losStatus="NLOS", numPaths=0,
                          rmsDelaySpreadNs=0.0, strongestPathPowerDbm=-200.0,
                          strongestPathType="None")


def _channel_metrics(paths: list[PropagationPath]) -> ChannelMetrics:
    if not paths:
        return _empty_metrics()
    powers_lin = np.array([10 ** (p.receivedPowerDbm / 10.0) for p in paths])
    delays = np.array([p.delayNs for p in paths])
    total = float(10.0 * math.log10(max(powers_lin.sum(), 1e-30)))
    mean_delay = float((powers_lin * delays).sum() / powers_lin.sum())
    rms = float(math.sqrt(max((powers_lin * (delays - mean_delay) ** 2).sum() / powers_lin.sum(), 0.0)))
    strongest = max(paths, key=lambda p: p.receivedPowerDbm)
    return ChannelMetrics(
        totalRxPowerDbm=total,
        losStatus="LOS" if any(p.type == "LOS" for p in paths) else "NLOS",
        numPaths=len(paths),
        rmsDelaySpreadNs=rms,
        strongestPathPowerDbm=strongest.receivedPowerDbm,
        strongestPathType=strongest.type,
    )


def _default_threshold(metric: str, given: float | None) -> float:
    """Served threshold: -90 dBm for received power, 0 dB for SINR (unless given)."""
    if given is not None:
        return float(given)
    return -90.0 if metric == "power" else 0.0


def _coverage_stats(values: np.ndarray, metric: str, threshold: float) -> CoverageStats:
    """Coverage stats over the finite metric values of reachable cells."""
    unit = "dBm" if metric == "power" else "dB"
    finite = values[np.isfinite(values)]
    if finite.size == 0:
        return CoverageStats(metric=metric, unit=unit, thresholdDb=float(threshold),
                             servedPercent=0.0, p5=0.0, p50=0.0, p95=0.0,
                             minVal=0.0, maxVal=0.0)
    served = float(100.0 * np.mean(finite >= threshold))
    p5, p50, p95 = (float(np.percentile(finite, q)) for q in (5, 50, 95))
    return CoverageStats(metric=metric, unit=unit, thresholdDb=float(threshold),
                         servedPercent=served, p5=p5, p50=p50, p95=p95,
                         minVal=float(finite.min()), maxVal=float(finite.max()))


def _to_tx_cells(arr, num_tx: int, n_cells: int) -> np.ndarray:
    """Normalize a radio-map metric tensor to shape (num_tx, n_cells)."""
    a = np.asarray(to_numpy(arr), dtype=float)
    if a.size == num_tx * n_cells:
        return a.reshape(num_tx, n_cells)
    if a.size == n_cells:
        return a.reshape(1, n_cells)
    return a.reshape(num_tx, -1)[:, :n_cells]


def solve_radiomap(req: RadioMapRequest) -> RadioMapGrid:
    from sionna.rt import RadioMapSolver

    txs = req.transmitters()
    scene = build_scene(req.buildings, req.freqGhz, req.materials)

    # Physical noise floor for SINR: bandwidth → thermal noise; fold the receiver
    # noise figure into an effective temperature (raises the floor by NF dB).
    try:
        scene.bandwidth = float(req.bandwidthHz)
        scene.temperature = 293.0 * (10.0 ** (float(req.noiseFigureDb) / 10.0))
    except Exception:
        pass

    # Bounding box must enclose every transmitter and all geometry.
    xs = [t.enu.x for t in txs]
    ys = [t.enu.y for t in txs]
    for b in req.buildings:
        for p in b.enuPoints:
            xs.append(p.x)
            ys.append(p.y)
    minx, maxx = min(xs), max(xs)
    miny, maxy = min(ys), max(ys)
    cx, cy = (minx + maxx) / 2.0, (miny + maxy) / 2.0
    size_x = max(maxx - minx, 100.0) + 60.0
    size_y = max(maxy - miny, 100.0) + 60.0
    cell = max(float(req.gridSize), 1.0)

    array_sizes = [tuple(int(v) for v in t.antennaArraySize) for t in txs]
    if any(size != array_sizes[0] for size in array_sizes):
        raise ValueError("Radio maps with multiple transmitters require matching antennaArraySize")

    # Directive array so the beam genuinely steers; default uniform precoding
    # forms the main lobe along each Tx's boresight.
    _set_tx_array(scene, txs[0].antennaArraySize, req.options)

    # Add every transmitter (with its real power, so RSS/SINR are physical),
    # each oriented toward its own steered beam.
    _clear_devices(scene)
    tx_positions: list[list[float]] = []
    for i, t in enumerate(txs):
        tz = _device_z(t.enu, t.height, req.buildings)
        pos = [float(t.enu.x), float(t.enu.y), tz]
        tx_positions.append(pos)
        beam = _beam_target(pos, t.beamsteeringAzimuth, t.beamsteeringElevation)
        _place_tx(scene, f"tx_rm_{i}", pos, beam, power_dbm=t.powerDbm)

    rm = RadioMapSolver()(
        scene,
        center=[cx, cy, float(req.gridHeight)],
        orientation=[0.0, 0.0, 0.0],
        size=[size_x, size_y],
        cell_size=[cell, cell],
        samples_per_tx=int(req.samplesPerTx),
        max_depth=int(max(0, req.maxDepth)),
        los=req.options.los,
        specular_reflection=req.options.specularReflection,
        diffuse_reflection=req.options.diffuseReflection,
        refraction=req.options.refraction,
        diffraction=req.options.diffraction,
        edge_diffraction=req.options.edgeDiffraction,
        seed=int(req.seed),
    )

    centers = np.asarray(to_numpy(rm.cell_centers), dtype=float).reshape(-1, 3)
    n_cells = centers.shape[0]
    num_tx = len(txs)

    rss = _to_tx_cells(rm.rss, num_tx, n_cells)     # (num_tx, n_cells) linear W
    sinr = _to_tx_cells(rm.sinr, num_tx, n_cells)   # (num_tx, n_cells) linear

    # Best-server selection by received power (RSS), then read SINR at that tx.
    with np.errstate(divide="ignore", invalid="ignore"):
        rss_dbm = 10.0 * np.log10(rss) + 30.0
    rss_dbm[~np.isfinite(rss_dbm)] = -np.inf
    best_tx = rss_dbm.argmax(axis=0)                # (n_cells,)
    idx = np.arange(n_cells)
    best_pwr = rss_dbm[best_tx, idx]               # (n_cells,) dBm
    with np.errstate(divide="ignore", invalid="ignore"):
        sinr_db = 10.0 * np.log10(sinr[best_tx, idx])  # (n_cells,) dB

    metric = req.metric
    threshold = _default_threshold(metric, req.coverageThresholdDb)
    unit = "dBm" if metric == "power" else "dB"
    chosen = best_pwr if metric == "power" else sinr_db
    stats = _coverage_stats(chosen, metric, threshold)

    cells: list[RadioMapCell] = []
    for k in range(n_cells):
        pos = centers[k]
        finite = np.isfinite(best_pwr[k])
        power = float(best_pwr[k]) if finite else -250.0
        sinr_val = float(sinr_db[k]) if np.isfinite(sinr_db[k]) else None
        serving = int(best_tx[k]) if finite else None
        # NOTE: Sionna's RadioMapSolver exposes path gain / RSS / SINR per cell,
        # but not a per-cell LOS flag. `isLos` here is an app-side approximation
        # from the 2D footprints (best-server Tx → cell), not an RT output, so it
        # can disagree with the actual propagation (e.g. a footprint-"blocked"
        # cell still served via reflection/diffraction). It drives only UI hints
        # and the synthetic channel-grid LOS hint, never the RSS/SINR values.
        is_los = False
        if finite:
            is_los = _segment_has_building_los(
                tx_positions[int(best_tx[k])],
                [float(pos[0]), float(pos[1]), float(pos[2])], req.buildings)
        cells.append(RadioMapCell(x=float(pos[0]), y=float(pos[1]), z=float(pos[2]),
                                  powerDbm=power, isLos=is_los, sinr=sinr_val,
                                  servingTx=serving))

    return RadioMapGrid(cells=cells, minX=float(minx), maxX=float(maxx),
                        minY=float(miny), maxY=float(maxy), gridSize=cell,
                        heightOffset=float(req.gridHeight), metric=metric,
                        unit=unit, stats=stats,
                        samplesPerTx=int(req.samplesPerTx), seed=int(req.seed))
