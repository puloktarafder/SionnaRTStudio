"""Build a Sionna RT scene from the frontend's building footprints.

Footprints arrive as ENU polygons (x=E, y=N, meters) + height. We extrude each
`building` into a watertight prism, add a ground plane, write a Mitsuba scene XML
with ITU radio-material BSDFs, and `load_scene` it. Scenes are cached by a hash of
the geometry+frequency so a Solve and a following Heatmap reuse one build.

Transmission/refraction caveat: Sionna RT models each surface as a single flat
slab and folds the wall thickness into the reflection/transmission coefficients
(see the Radio Materials docs). Our prisms are closed, so a ray transmitted
*through* a building crosses two such slabs (entry + exit wall), each consuming a
ray-tracing bounce. That is reasonable for reflection and LOS occlusion, but the
``refraction`` toggle is an approximation for thick/solid structures — deep
penetration is also bounded by ``max_depth``.
"""
from __future__ import annotations

import hashlib
import json
import tempfile
import xml.etree.ElementTree as ET
from collections import OrderedDict
from pathlib import Path

import numpy as np
import trimesh

from .models import BuildingFootprint, MaterialConfig

SCENE_VERSION = "3.0.0"
GROUND_MARGIN_M = 300.0  # how far the ground plane extends past the buildings
_CACHE_MAX = 4

# Frontend material id -> Sionna ITU radio-material short name.
MATERIAL_MAP = {
    "itu_concrete": "concrete",
    "itu_brick": "brick",
    "itu_glass": "glass",
    "itu_metal": "metal",
    "itu_wood": "wood",
    "itu_dry_ground": "medium_dry_ground",
    "itu_medium_dry_ground": "medium_dry_ground",
    "itu_wet_ground": "wet_ground",
}
# Concrete stays defined across 2.4–100 GHz; the ITU *ground* materials are only
# defined at low frequencies and break at mmWave (e.g. 28 GHz), so we use concrete
# for the ground plane.
GROUND_MATERIAL = "itu_concrete"
# The ground gets its own BSDF id purely so it is visually separable. Sionna's
# previewer colors geometry by radio material (`shape.bsdf().color`), so sharing
# one material with the concrete buildings merged ground and buildings into a
# single flat grey mass. The ITU type stays GROUND_MATERIAL's, and any
# GROUND_MATERIAL override is applied to it too, so the EM response is unchanged.
# Must not collide with a scene-object name: Sionna strips the "mesh-" prefix
# from shape ids, so the ground shape becomes the object "ground".
GROUND_BSDF_ID = "ground_plane"
GROUND_COLOR = (0.28, 0.30, 0.32)  # asphalt-ish, clearly darker than ITU concrete

# Raw OSM tags (e.g. building:material=brick) lack the `itu_` prefix. Map the
# common values onto our ITU ids so they aren't silently lost to concrete. The
# frontend normalizes too; this is a backend safety net for direct API callers.
OSM_MATERIAL_ALIASES = {
    "concrete": "itu_concrete",
    "cement": "itu_concrete",
    "stone": "itu_concrete",
    "brick": "itu_brick",
    "brickwork": "itu_brick",
    "glass": "itu_glass",
    "metal": "itu_metal",
    "steel": "itu_metal",
    "wood": "itu_wood",
    "timber": "itu_wood",
}


def _itu_value(material: str) -> str:
    return MATERIAL_MAP.get(material, "concrete")


def _resolve_material(raw: str | None) -> str:
    """Resolve a building material id to a known ITU id.

    Accepts our `itu_*` ids directly, maps common raw OSM tags via
    OSM_MATERIAL_ALIASES, and falls back to concrete for anything unknown.
    """
    if not raw:
        return "itu_concrete"
    if raw in MATERIAL_MAP:
        return raw
    return OSM_MATERIAL_ALIASES.get(raw.strip().lower(), "itu_concrete")


def _building_prism(footprint: BuildingFootprint) -> trimesh.Trimesh | None:
    """Extrude an ENU footprint into a Z-up prism (matches scene z-up axes)."""
    from shapely.geometry import Polygon
    from shapely.validation import make_valid

    pts = [(p.x, p.y) for p in footprint.enuPoints]
    if len(pts) < 3:
        return None
    try:
        poly = Polygon(pts)
        if not poly.is_valid:
            poly = make_valid(poly)
        if poly.geom_type == "MultiPolygon":
            poly = max(poly.geoms, key=lambda g: g.area)
        if poly.geom_type != "Polygon" or poly.is_empty or poly.area < 0.5:
            return None
        mesh = trimesh.creation.extrude_polygon(poly, max(float(footprint.height), 1.0))
        return mesh if len(mesh.faces) else None
    except Exception as exc:
        # Loud on purpose: a silent failure here drops the building from the RT
        # scene, so rays pass through it (no occlusion). Most common cause is a
        # missing trimesh triangulation engine (see requirements: mapbox_earcut).
        import sys
        print(f"[scene_build] WARNING: failed to extrude building "
              f"{footprint.id!r}: {exc}", file=sys.stderr)
        return None


def _ground_plane(buildings: list[BuildingFootprint]) -> trimesh.Trimesh:
    xs, ys = [0.0], [0.0]
    for b in buildings:
        for p in b.enuPoints:
            xs.append(p.x)
            ys.append(p.y)
    minx, maxx = min(xs) - GROUND_MARGIN_M, max(xs) + GROUND_MARGIN_M
    miny, maxy = min(ys) - GROUND_MARGIN_M, max(ys) + GROUND_MARGIN_M
    vertices = np.array(
        [[minx, miny, 0.0], [maxx, miny, 0.0], [maxx, maxy, 0.0], [minx, maxy, 0.0]],
        dtype=np.float64,
    )
    faces = np.array([[0, 1, 2], [0, 2, 3]], dtype=np.int64)
    return trimesh.Trimesh(vertices=vertices, faces=faces, process=False)


def _geometry_hash(
    buildings: list[BuildingFootprint],
    freq_ghz: float,
    materials: list[MaterialConfig] | None = None,
) -> str:
    payload = [
        {
            "p": [(round(p.x, 3), round(p.y, 3)) for p in b.enuPoints],
            "h": round(b.height, 3),
            "m": b.material,
            "c": b.category,
        }
        for b in buildings
    ]
    # Material/scattering overrides change the EM response, so they must key the
    # cache — otherwise an edit would silently reuse a stale scene build.
    mat_payload = sorted(
        [
            cfg.id,
            round(cfg.scatteringCoefficient, 4),
            round(cfg.xpdCoefficient, 4),
            cfg.scatteringPattern,
            cfg.relativePermittivity,
            cfg.conductivity,
            cfg.thickness,
        ]
        for cfg in (materials or [])
    )
    blob = json.dumps([round(freq_ghz, 6), payload, mat_payload], sort_keys=True).encode()
    return hashlib.sha1(blob).hexdigest()[:16]


def _scattering_pattern(name: str):
    """Map a scattering-pattern name to a Sionna pattern instance (or None)."""
    from sionna.rt import (
        BackscatteringPattern,
        DirectivePattern,
        LambertianPattern,
    )

    if name == "lambertian":
        return LambertianPattern()
    if name == "directive":
        return DirectivePattern(alpha_r=4)
    if name == "backscattering":
        return BackscatteringPattern(alpha_r=4, alpha_i=4)
    return None


def _apply_materials(scene, materials: list[MaterialConfig]) -> None:
    """Apply per-material scattering + EM overrides onto a freshly loaded scene.

    The scene's radio materials are keyed by the frontend material id (the BSDF
    id written into the XML, e.g. ``itu_concrete``), so the config id maps 1:1.
    Applied after ``scene.frequency`` is set so ITU values are computed first and
    any explicit permittivity/conductivity override takes effect last.

    The ground plane carries its own BSDF id for visual separation only, so a
    GROUND_MATERIAL override is applied to it as well — otherwise splitting the
    material would silently change the ground's electromagnetic response.
    """
    import sys

    if not materials:
        return
    rms = scene.radio_materials
    for cfg in materials:
        target_ids = [cfg.id]
        if cfg.id == GROUND_MATERIAL:
            target_ids.append(GROUND_BSDF_ID)
        for target_id in target_ids:
            rm = rms.get(target_id) if isinstance(rms, dict) else None
            if rm is None:
                continue
            try:
                rm.scattering_coefficient = float(cfg.scatteringCoefficient)
                rm.xpd_coefficient = float(cfg.xpdCoefficient)
                pattern = _scattering_pattern(cfg.scatteringPattern)
                if pattern is not None:
                    rm.scattering_pattern = pattern
                if cfg.relativePermittivity is not None:
                    rm.relative_permittivity = float(cfg.relativePermittivity)
                if cfg.conductivity is not None:
                    rm.conductivity = float(cfg.conductivity)
                if cfg.thickness is not None:
                    rm.thickness = float(cfg.thickness)
            except Exception as exc:
                print(f"[scene_build] WARNING: failed to apply material "
                      f"{target_id!r}: {exc}", file=sys.stderr)


def _write_scene_xml(
    scene_dir: Path, meshes: list[tuple[str, str, str]], materials: set[str]
) -> Path:
    """meshes = list of (ply_filename, material_id, shape_id)."""
    root = ET.Element("scene", {"version": SCENE_VERSION})
    ET.SubElement(root, "integrator", {"type": "path"})
    emitter = ET.SubElement(root, "emitter", {"type": "constant"})
    ET.SubElement(emitter, "rgb", {"name": "radiance", "value": "0.7 0.7 0.7"})

    for material_id in sorted(materials):
        bsdf = ET.SubElement(root, "bsdf", {"type": "itu-radio-material", "id": material_id})
        ET.SubElement(bsdf, "string", {"name": "type", "value": _itu_value(material_id)})

    ground_bsdf = ET.SubElement(
        root, "bsdf", {"type": "itu-radio-material", "id": GROUND_BSDF_ID}
    )
    ET.SubElement(ground_bsdf, "string",
                  {"name": "type", "value": _itu_value(GROUND_MATERIAL)})
    ET.SubElement(ground_bsdf, "rgb",
                  {"name": "color",
                   "value": " ".join(f"{c:.3f}" for c in GROUND_COLOR)})

    for ply_name, material_id, shape_id in meshes:
        shape = ET.SubElement(root, "shape", {"type": "ply", "id": shape_id})
        ET.SubElement(shape, "string", {"name": "filename", "value": ply_name})
        # Our PLY exporter writes vertex normals, which Mitsuba interpolates —
        # shading a faceted prism like a smooth blob. Sionna's own scenes all set
        # this. Ray tracing is unaffected (the solver uses geometric normals).
        ET.SubElement(shape, "boolean", {"name": "face_normals", "value": "true"})
        ET.SubElement(shape, "ref", {"id": material_id})

    xml_path = scene_dir / "scene.xml"
    ET.ElementTree(root).write(xml_path, encoding="utf-8", xml_declaration=True)
    return xml_path


class _BuiltScene:
    def __init__(self, scene, tmpdir: tempfile.TemporaryDirectory):
        self.scene = scene
        self._tmpdir = tmpdir  # keep alive so the mesh files survive

    @property
    def scene_dir(self) -> Path:
        """Directory holding ``scene.xml`` and ``meshes/*.ply``."""
        return Path(self._tmpdir.name)


_scene_cache: "OrderedDict[str, _BuiltScene]" = OrderedDict()


def _build(
    buildings: list[BuildingFootprint],
    freq_ghz: float,
    material_configs: list[MaterialConfig] | None = None,
) -> _BuiltScene:
    """Return the cached scene holder, building (and caching) it if needed."""
    from sionna.rt import PlanarArray, load_scene

    key = _geometry_hash(buildings, freq_ghz, material_configs)
    cached = _scene_cache.get(key)
    if cached is not None:
        _scene_cache.move_to_end(key)
        return cached

    tmpdir = tempfile.TemporaryDirectory(prefix="srts_scene_")
    scene_dir = Path(tmpdir.name)
    mesh_dir = scene_dir / "meshes"
    mesh_dir.mkdir()

    mesh_refs: list[tuple[str, str, str]] = []
    materials: set[str] = set()

    # Ground first so reflections off it are available.
    ground = _ground_plane(buildings)
    ground.export(mesh_dir / "ground.ply", file_type="ply")
    mesh_refs.append(("meshes/ground.ply", GROUND_BSDF_ID, "mesh-ground"))

    for i, b in enumerate(buildings):
        if b.category != "building":
            continue  # roads/parks/water are visual-only, like the TS solver
        prism = _building_prism(b)
        if prism is None:
            continue
        name = f"meshes/b{i}.ply"
        prism.export(mesh_dir / f"b{i}.ply", file_type="ply")
        material_id = _resolve_material(b.material)
        materials.add(material_id)
        mesh_refs.append((name, material_id, f"mesh-b{i}"))

    xml_path = _write_scene_xml(scene_dir, mesh_refs, materials)

    scene = load_scene(str(xml_path))
    scene.frequency = float(freq_ghz) * 1e9
    # Apply scattering / EM overrides after frequency is set (ITU values first).
    _apply_materials(scene, material_configs or [])
    # Safe defaults for callers that only build a scene. PathSolver entry points
    # replace both arrays from each request before tracing; RadioMapSolver
    # replaces the Tx array and uses its own ideal map-receiver model.
    iso = PlanarArray(num_rows=1, num_cols=1, vertical_spacing=0.5,
                      horizontal_spacing=0.5, pattern="iso", polarization="V")
    scene.tx_array = iso
    scene.rx_array = iso

    built = _BuiltScene(scene, tmpdir)
    _scene_cache[key] = built
    while len(_scene_cache) > _CACHE_MAX:
        _scene_cache.popitem(last=False)
    return built


def build_scene(
    buildings: list[BuildingFootprint],
    freq_ghz: float,
    material_configs: list[MaterialConfig] | None = None,
):
    """Return a Sionna RT Scene built from the building footprints (cached)."""
    return _build(buildings, freq_ghz, material_configs).scene


def build_scene_dir(
    buildings: list[BuildingFootprint],
    freq_ghz: float,
    material_configs: list[MaterialConfig] | None = None,
) -> Path:
    """Return the Mitsuba scene directory (``scene.xml`` + ``meshes/*.ply``).

    The directory is a self-contained, relocatable Mitsuba scene: every shape in
    the XML references its mesh by a relative path, so copying the tree gives a
    folder that ``sionna.rt.load_scene`` opens anywhere.

    Lifetime: the directory is owned by the scene cache and is deleted once the
    entry is evicted (``_CACHE_MAX``). Callers must copy what they need right
    away — the export endpoint does so while holding the solver lock, which is
    also what keeps a concurrent build from evicting the entry mid-copy.
    """
    return _build(buildings, freq_ghz, material_configs).scene_dir
