"""Package the ray-tracing scene as a standalone Sionna RT project.

The backend already traces a real Mitsuba scene: :func:`scene_build.build_scene`
writes ``scene.xml`` plus ``meshes/*.ply`` and hands that to ``load_scene``. Every
shape reference in the XML is relative, so the directory is relocatable as-is.

What the XML cannot carry is everything Sionna keeps on the Python side — the
carrier frequency, radio-material overrides, the ``PlanarArray`` configuration,
the transmitters/receivers, and the ``PathSolver`` switches. This module copies
the scene tree into a ZIP and generates a ``load_scene.py`` that replays exactly
those Python-side steps, so running it in a notebook reproduces the app's solve
without the app.

The generated script preserves each transmitter's configured ``power_dbm``.
Sionna's CIR/CFR coefficients are independent of transmit power, but retaining
it makes later RSS and radio-map calculations faithful to the studio project.
"""
from __future__ import annotations

import io
import json
import time
import zipfile
from pathlib import Path

from .models import (
    BuildingFootprint,
    MaterialConfig,
    Receiver,
    SceneExportRequest,
    SolverOptions,
    Transmitter,
)
from .scene_build import (
    GROUND_BSDF_ID,
    GROUND_MATERIAL,
    build_scene_dir,
)
from .solver import _beam_target, _device_z

# Mirrors scene_build._scattering_pattern, but emits source instead of objects.
_SCATTERING_PATTERN_SRC = {
    "lambertian": ("LambertianPattern", "LambertianPattern()"),
    "directive": ("DirectivePattern", "DirectivePattern(alpha_r=4)"),
    "backscattering": ("BackscatteringPattern",
                       "BackscatteringPattern(alpha_r=4, alpha_i=4)"),
}


def _safe_name(value: str, index: int, prefix: str) -> str:
    """Unique, identifier-safe Sionna device name that still reads like the UI."""
    cleaned = "".join(
        character if character.isalnum() or character in "-_" else "_"
        for character in value
    ).strip("_")
    return f"{prefix}_{index:02d}_{cleaned}" if cleaned else f"{prefix}_{index:02d}"


def _position(enu, height: float, buildings: list[BuildingFootprint]) -> list[float]:
    """Device position in scene coordinates, roof-aware like the solver."""
    return [float(enu.x), float(enu.y), _device_z(enu, height, buildings)]


def _material_lines(materials: list[MaterialConfig]) -> tuple[list[str], list[str]]:
    """Return (extra imports, source lines) replaying scene_build._apply_materials."""
    if not materials:
        return [], ["# No material overrides: the ITU presets in scene.xml are used as-is."]

    imports: list[str] = []
    lines = [
        "# Radio-material overrides. Applied after scene.frequency so the ITU",
        "# presets are computed first and explicit values win (scene_build.py).",
    ]
    for cfg in materials:
        target_ids = [cfg.id]
        if cfg.id == GROUND_MATERIAL:
            target_ids.append(GROUND_BSDF_ID)
        for target_id in target_ids:
            lines.append(f"material = scene.radio_materials.get({target_id!r})")
            lines.append("if material is not None:")
            lines.append(
                f"    material.scattering_coefficient = "
                f"{float(cfg.scatteringCoefficient)!r}"
            )
            lines.append(
                f"    material.xpd_coefficient = {float(cfg.xpdCoefficient)!r}"
            )
            pattern = _SCATTERING_PATTERN_SRC.get(cfg.scatteringPattern)
            if pattern is not None:
                symbol, construction = pattern
                if symbol not in imports:
                    imports.append(symbol)
                lines.append(f"    material.scattering_pattern = {construction}")
            if cfg.relativePermittivity is not None:
                lines.append(
                    f"    material.relative_permittivity = "
                    f"{float(cfg.relativePermittivity)!r}"
                )
            if cfg.conductivity is not None:
                lines.append(
                    f"    material.conductivity = {float(cfg.conductivity)!r}"
                )
            if cfg.thickness is not None:
                lines.append(
                    f"    material.thickness = {float(cfg.thickness)!r}"
                )
    return imports, lines


def _device_specs(
    txs: list[Transmitter],
    rxs: list[Receiver],
    buildings: list[BuildingFootprint],
) -> tuple[list[dict], list[dict]]:
    """Serializable device definitions used by the generated runner."""
    tx_specs: list[dict] = []
    for index, tx in enumerate(txs):
        position = _position(tx.enu, tx.height, buildings)
        beam = _beam_target(position, tx.beamsteeringAzimuth, tx.beamsteeringElevation)
        tx_specs.append(
            {
                "id": tx.id,
                "name": _safe_name(tx.name or tx.id, index, "tx"),
                "position": position,
                "lookAt": beam,
                "powerDbm": float(tx.powerDbm),
                "antennaArraySize": list(tx.antennaArraySize),
            }
        )
    rx_specs: list[dict] = []
    for index, rx in enumerate(rxs):
        position = _position(rx.enu, rx.height, buildings)
        rx_specs.append(
            {
                "id": rx.id,
                "name": _safe_name(rx.name or rx.id, index, "rx"),
                "position": position,
                "antennaArraySize": list(rx.antennaArraySize),
            }
        )
    return tx_specs, rx_specs


def _array_groups(req: SceneExportRequest) -> list[dict]:
    """Exact compatible channel groups covering every requested Tx×Rx pair.

    Sionna has one scene-wide Tx array and one scene-wide Rx array. Devices are
    therefore grouped by array size on each side, and the Cartesian product of
    those groups covers every link without replacing or padding any array.
    """
    txs = req.transmitters()
    rxs = req.receivers()
    if not txs or not rxs:
        return []

    tx_groups: dict[tuple[int, int], list[int]] = {}
    rx_groups: dict[tuple[int, int], list[int]] = {}
    for index, tx in enumerate(txs):
        size = tuple(int(v) for v in tx.antennaArraySize)
        tx_groups.setdefault(size, []).append(index)
    for index, rx in enumerate(rxs):
        size = tuple(int(v) for v in rx.antennaArraySize)
        rx_groups.setdefault(size, []).append(index)

    count = len(tx_groups) * len(rx_groups)
    groups: list[dict] = []
    for tx_size, tx_indices in tx_groups.items():
        for rx_size, rx_indices in rx_groups.items():
            if count == 1:
                filename = "cir.npz"
            else:
                filename = (
                    f"channels/cir_tx_{tx_size[0]}x{tx_size[1]}"
                    f"_rx_{rx_size[0]}x{rx_size[1]}.npz"
                )
            groups.append(
                {
                    "file": filename,
                    "txArraySize": list(tx_size),
                    "rxArraySize": list(rx_size),
                    "txIndices": tx_indices,
                    "rxIndices": rx_indices,
                    "txIds": [txs[index].id for index in tx_indices],
                    "rxIds": [rxs[index].id for index in rx_indices],
                }
            )
    return groups


def _load_scene_script(req: SceneExportRequest) -> str:
    """Generate the standalone ``load_scene.py`` for this export."""
    opts: SolverOptions = req.options
    txs = req.transmitters()
    rxs = req.receivers()
    tx_specs, rx_specs = _device_specs(txs, rxs, req.buildings)
    groups = _array_groups(req)

    material_imports, material_lines = _material_lines(req.materials)
    rt_imports = [
        "PathSolver", "PlanarArray", "Receiver", "Transmitter",
        "load_scene", "subcarrier_frequencies",
    ] + material_imports

    # Defaults are used only for previewing a scene with no device on one side.
    # Every actual solve uses one of the exact compatible groups below.
    tx_size = tuple(txs[0].antennaArraySize) if txs else (8, 8)
    rx_size = tuple(rxs[0].antennaArraySize) if rxs else (1, 1)

    body = [
        '"""Standalone Sionna RT script generated by SionnaRTStudio.',
        "",
        "Reproduces every compatible studio ray-tracing solve from the exported",
        "Mitsuba scene. Heterogeneous arrays are split into exact array-compatible",
        "groups because Sionna has one scene-wide Tx array and one Rx array.",
        "Requires sionna-rt; a CUDA Mitsuba variant gives GPU tracing.",
        '"""',
        "import numpy as np",
        "from pathlib import Path",
        "",
        "from sionna.rt import (",
    ]
    body += [f"    {symbol}," for symbol in sorted(set(rt_imports))]
    body += [
        ")",
        "",
        "# ── Scene ───────────────────────────────────────────────────────────────",
        "# Works when run as a script or pasted into a notebook from the ZIP folder.",
        'BASE_DIR = Path(__file__).resolve().parent if "__file__" in globals() else Path.cwd()',
        'scene = load_scene(str(BASE_DIR / "scene.xml"))',
        f"scene.frequency = {float(req.freqGhz)!r}e9  # {float(req.freqGhz)!r} GHz",
        "",
    ]
    body += material_lines
    body += [
        "",
        "# ── Exact exported configuration ────────────────────────────────────────",
        f"TX_SPECS = {tx_specs!r}",
        f"RX_SPECS = {rx_specs!r}",
        f"CHANNEL_GROUPS = {groups!r}",
        "",
        "",
        "def _planar_array(size, pattern, polarization):",
        "    # Studio antennaArraySize is [horizontal, vertical].",
        "    return PlanarArray(",
        "        num_rows=int(size[1]),",
        "        num_cols=int(size[0]),",
        "        vertical_spacing=0.5,",
        "        horizontal_spacing=0.5,",
        "        pattern=pattern,",
        "        polarization=polarization,",
        "    )",
        "",
        "",
        "def _clear_devices():",
        "    for name in list(scene.transmitters.keys()):",
        "        scene.remove(name)",
        "    for name in list(scene.receivers.keys()):",
        "        scene.remove(name)",
        "",
        "",
        "def _add_devices(tx_indices, rx_indices):",
        "    for index in tx_indices:",
        "        spec = TX_SPECS[index]",
        "        transmitter = Transmitter(",
        "            name=spec['name'],",
        "            position=spec['position'],",
        "            power_dbm=spec['powerDbm'],",
        "        )",
        "        transmitter.look_at(spec['lookAt'])",
        "        scene.add(transmitter)",
        "    for index in rx_indices:",
        "        spec = RX_SPECS[index]",
        "        scene.add(Receiver(name=spec['name'], position=spec['position']))",
        "",
        "",
        "# ── Ray tracing ─────────────────────────────────────────────────────────",
        f"frequencies = subcarrier_frequencies({int(max(1, req.numSubcarriers))}, "
        f"{float(req.subcarrierSpacing)!r})",
        "",
        "",
        "def _solve_group(group):",
        "    _clear_devices()",
        "    scene.tx_array = _planar_array(",
        f"        group['txArraySize'], {opts.txPattern!r}, {opts.txPolarization!r}",
        "    )",
        "    scene.rx_array = _planar_array(",
        f"        group['rxArraySize'], {opts.rxPattern!r}, {opts.rxPolarization!r}",
        "    )",
        "    _add_devices(group['txIndices'], group['rxIndices'])",
        "",
        "    paths = PathSolver()(",
        "        scene,",
        f"        max_depth={int(max(0, req.maxDepth))},",
        f"        samples_per_src={int(opts.pathSamplesPerSource)},",
        f"        seed={int(opts.pathSeed)},",
        f"        los={bool(opts.los)},",
        f"        specular_reflection={bool(opts.specularReflection)},",
        f"        diffuse_reflection={bool(opts.diffuseReflection)},",
        f"        refraction={bool(opts.refraction)},",
        f"        diffraction={bool(opts.diffraction)},",
        f"        edge_diffraction={bool(opts.edgeDiffraction)},",
        "        synthetic_array=True,",
        "    )",
        "",
        "    # a: [num_rx, num_rx_ant, num_tx, num_tx_ant, paths, time]",
        f"    a, tau = paths.cir(normalize_delays={bool(req.normalizeDelays)}, "
        'out_type="numpy")',
        "    h = paths.cfr(",
        "        frequencies=frequencies,",
        f"        normalize_delays={bool(req.normalizeDelays)},",
        '        out_type="numpy",',
        "    )",
        "",
        "    output_path = BASE_DIR / group['file']",
        "    output_path.parent.mkdir(parents=True, exist_ok=True)",
        "    tx_indices = group['txIndices']",
        "    rx_indices = group['rxIndices']",
        "    np.savez_compressed(",
        "        output_path,",
        "        a=a,",
        "        tau=tau,",
        "        h=h,",
        "        frequencies=frequencies,",
        "        tx_ids=np.asarray([TX_SPECS[i]['id'] for i in tx_indices]),",
        "        rx_ids=np.asarray([RX_SPECS[i]['id'] for i in rx_indices]),",
        "        tx_positions=np.asarray([TX_SPECS[i]['position'] for i in tx_indices]),",
        "        rx_positions=np.asarray([RX_SPECS[i]['position'] for i in rx_indices]),",
        "        tx_power_dbm=np.asarray([TX_SPECS[i]['powerDbm'] for i in tx_indices]),",
        "        tx_array_size=np.asarray(group['txArraySize']),",
        "        rx_array_size=np.asarray(group['rxArraySize']),",
        "    )",
        "    print(f\"{group['file']}: a={a.shape}, tau={tau.shape}, h={h.shape}\")",
        "    return paths",
        "",
        "",
        "if CHANNEL_GROUPS:",
        "    # Uniform arrays produce cir.npz. Heterogeneous arrays produce one",
        "    # exact tensor per compatible array combination under channels/.",
        "    for channel_group in CHANNEL_GROUPS:",
        "        paths = _solve_group(channel_group)",
        "else:",
        "    # Geometry and any present devices remain inspectable, but no fake",
        "    # counterpart is invented and PathSolver is not called.",
        f"    scene.tx_array = _planar_array({list(tx_size)!r}, "
        f"{opts.txPattern!r}, {opts.txPolarization!r})",
        f"    scene.rx_array = _planar_array({list(rx_size)!r}, "
        f"{opts.rxPattern!r}, {opts.rxPolarization!r})",
        "    _clear_devices()",
        "    _add_devices(range(len(TX_SPECS)), range(len(RX_SPECS)))",
        '    print("No CIR/CFR generated: at least one Tx and one Rx are required.")',
        "",
    ]
    return "\n".join(body)


def _manifest(req: SceneExportRequest, mesh_members: list[str]) -> dict:
    """Machine-readable record of what produced this scene."""
    buildings = [b for b in req.buildings if b.category == "building"]
    array_groups = _array_groups(req)
    if not array_groups:
        channel_mode = "none"
    elif len(array_groups) == 1:
        channel_mode = "uniform"
    else:
        channel_mode = "grouped"
    return {
        "format": "SionnaRTStudio standalone Sionna RT scene",
        "schemaVersion": 2,
        "generatedAtUtc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "carrierFrequencyGhz": req.freqGhz,
        "maxDepth": req.maxDepth,
        "normalizeDelays": req.normalizeDelays,
        "numSubcarriers": req.numSubcarriers,
        "subcarrierSpacing": req.subcarrierSpacing,
        "solverOptions": req.options.model_dump(),
        "materials": [material.model_dump() for material in req.materials],
        "buildingCount": len(buildings),
        "meshFiles": mesh_members,
        "coordinateSystem": "ENU metres (x=East, y=North, z=Up); ground plane at z=0",
        "channelExportMode": channel_mode,
        "arrayGroups": array_groups,
        "transmitters": [
            {
                "id": tx.id,
                "name": tx.name,
                "position": _position(tx.enu, tx.height, req.buildings),
                "antennaArraySize": list(tx.antennaArraySize),
                "powerDbm": tx.powerDbm,
                "beamsteeringAzimuthDeg": tx.beamsteeringAzimuth,
                "beamsteeringElevationDeg": tx.beamsteeringElevation,
            }
            for tx in req.transmitters()
        ],
        "receivers": [
            {
                "id": rx.id,
                "name": rx.name,
                "position": _position(rx.enu, rx.height, req.buildings),
                "antennaArraySize": list(rx.antennaArraySize),
            }
            for rx in req.receivers()
        ],
    }


_README = """# SionnaRTStudio — standalone Sionna RT scene

This folder is the exact Mitsuba scene the studio ray-traces, plus a script that
replays the Python-side configuration Sionna does not store in the XML.

    scene.xml       Mitsuba scene, ITU radio-material BSDFs, relative mesh paths
    meshes/*.ply    ground plane + one extruded prism per building
    load_scene.py   frequency, material overrides, arrays, devices, PathSolver
    manifest.json   the settings this export was generated from
    channels/*.npz exact array-compatible tensors created by load_scene.py

## Use

    pip install sionna-rt
    python load_scene.py

Or in a notebook:

```python
from sionna.rt import load_scene
scene = load_scene("scene.xml")   # import sionna.rt first: it registers the
                                  # itu-radio-material BSDF plugin
```

For a uniform-array scene, `load_scene.py` writes `cir.npz` with the standard
Sionna tensors:

```python
a, tau = paths.cir(...)   # a: [num_rx, num_rx_ant, num_tx, num_tx_ant, num_paths, num_time_steps]
h = paths.cfr(frequencies=...)
```

When device array sizes differ, Sionna cannot put them into one dense tensor
because a scene has one shared Tx array and one shared Rx array. The script
therefore groups devices by exact Tx/Rx array size and writes one tensor per
compatible combination under `channels/`. Together, those files cover every
Tx×Rx pair without replacing or padding any antenna array. Each NPZ includes
`tx_ids`, `rx_ids`, positions, array sizes, and `tx_power_dbm`; `manifest.json`
maps every group to its output file.

## Notes

- Coordinates are ENU metres (x=East, y=North, z=Up), ground plane at z=0.
- Device heights are roof-aware: a device over a building footprint sits on it.
- Each transmitter is loaded with its configured `power_dbm`. This does not
  scale CIR/CFR coefficients, but it preserves later RSS/radio-map calculations.
- If either side has no devices, the scene remains loadable and inspectable but
  no fake device is added and no channel solve is attempted.
- `PathSolver` returns paths in a GPU-dependent order, so the path axis of `a`
  and `tau` may be permuted between runs. The path set and its coefficients are
  identical; sort by `tau` if you need a stable order.
"""


def scene_export_zip(req: SceneExportRequest) -> bytes:
    """Build the standalone-scene ZIP for this request."""
    scene_dir: Path = build_scene_dir(req.buildings, req.freqGhz, req.materials)
    xml_path = scene_dir / "scene.xml"
    if not xml_path.is_file():
        raise RuntimeError("Scene build produced no scene.xml")

    mesh_members = sorted(
        f"meshes/{path.name}" for path in (scene_dir / "meshes").glob("*.ply")
    )

    output = io.BytesIO()
    with zipfile.ZipFile(output, mode="w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("scene.xml", xml_path.read_bytes())
        for member in mesh_members:
            archive.writestr(member, (scene_dir / member).read_bytes())
        archive.writestr("load_scene.py", _load_scene_script(req))
        archive.writestr("manifest.json",
                         json.dumps(_manifest(req, mesh_members), indent=2))
        archive.writestr("README.md", _README)
    return output.getvalue()
