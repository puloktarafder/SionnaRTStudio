"""Tests for the standalone Sionna RT scene export (no GPU / Sionna needed).

Only the generated ``load_scene.py`` and manifest are exercised here; zipping the
Mitsuba scene itself needs a real scene build.

Run with:  .venv/bin/python -m unittest discover backend/tests
"""
import tempfile
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path

from backend.scene_build import (
    GROUND_BSDF_ID,
    GROUND_COLOR,
    GROUND_MATERIAL,
    _write_scene_xml,
)
from backend.models import (
    BuildingFootprint,
    ENUVector,
    MaterialConfig,
    Receiver,
    SceneExportRequest,
    SolverOptions,
    Transmitter,
)
from backend.scene_export import _array_groups, _load_scene_script, _manifest


def _building(height: float = 20.0) -> BuildingFootprint:
    return BuildingFootprint(
        id="b1",
        enuPoints=[
            ENUVector(x=0.0, y=0.0, z=0.0),
            ENUVector(x=10.0, y=0.0, z=0.0),
            ENUVector(x=10.0, y=10.0, z=0.0),
            ENUVector(x=0.0, y=10.0, z=0.0),
        ],
        height=height,
        category="building",
    )


def _request(**overrides) -> SceneExportRequest:
    payload = {
        "txs": [Transmitter(
            id="tx1", name="Site A", enu=ENUVector(x=5.0, y=5.0, z=0.0),
            height=6.0, powerDbm=33.0, antennaArraySize=(4, 2),
            beamsteeringAzimuth=90.0, beamsteeringElevation=-5.0,
        )],
        "rxs": [Receiver(
            id="rx1", name="UE 1", enu=ENUVector(x=60.0, y=40.0, z=0.0),
            height=1.5, antennaArraySize=(2, 2),
        )],
        "buildings": [_building()],
        "freqGhz": 28.0,
        "maxDepth": 4,
    }
    payload.update(overrides)
    return SceneExportRequest(**payload)


class TestGeneratedScript(unittest.TestCase):
    def test_script_is_valid_python(self):
        compile(_load_scene_script(_request()), "load_scene.py", "exec")

    def test_loads_the_relative_scene_and_sets_frequency(self):
        script = _load_scene_script(_request(freqGhz=3.5))
        self.assertIn('load_scene(str(BASE_DIR / "scene.xml"))', script)
        self.assertIn("scene.frequency = 3.5e9", script)

    def test_planar_array_maps_horizontal_to_columns(self):
        """antennaArraySize is [horizontal, vertical] — cols then rows."""
        script = _load_scene_script(_request(
            options=SolverOptions(txPattern="tr38901", txPolarization="VH",
                                  rxPattern="iso", rxPolarization="V"),
        ))
        self.assertIn("num_rows=int(size[1])", script)
        self.assertIn("num_cols=int(size[0])", script)
        self.assertIn("group['txArraySize'], 'tr38901', 'VH'", script)
        self.assertIn("group['rxArraySize'], 'iso', 'V'", script)
        self.assertIn("'txArraySize': [4, 2]", script)
        self.assertIn("'rxArraySize': [2, 2]", script)

    def test_devices_use_roof_aware_heights(self):
        """A Tx over a 20 m building sits on its roof; an Rx outside does not."""
        script = _load_scene_script(_request())
        self.assertIn("'position': [5.0, 5.0, 26.0]", script)
        self.assertIn("'position': [60.0, 40.0, 1.5]", script)

    def test_transmitter_is_oriented_along_the_steered_beam(self):
        script = _load_scene_script(_request())
        self.assertIn("transmitter.look_at(", script)
        # Azimuth 90 deg is due East, so the target is +x of the transmitter.
        self.assertIn("'lookAt': [104.6", script)

    def test_transmit_power_is_active_and_saved_as_metadata(self):
        script = _load_scene_script(_request())
        self.assertIn("'powerDbm': 33.0", script)
        self.assertIn("power_dbm=spec['powerDbm']", script)
        self.assertIn("tx_power_dbm=np.asarray(", script)

    def test_path_solver_switches_are_carried_over(self):
        script = _load_scene_script(_request(
            maxDepth=7,
            options=SolverOptions(diffraction=True, edgeDiffraction=True,
                                  diffuseReflection=True, refraction=True,
                                  pathSamplesPerSource=250_000, pathSeed=7),
        ))
        for expected in ("max_depth=7", "samples_per_src=250000", "seed=7",
                         "diffraction=True", "edge_diffraction=True",
                         "diffuse_reflection=True", "refraction=True",
                         "synthetic_array=True"):
            self.assertIn(expected, script)

    def test_emits_cir_and_cfr_on_the_requested_grid(self):
        script = _load_scene_script(_request(
            numSubcarriers=128, subcarrierSpacing=15_000.0, normalizeDelays=False,
        ))
        self.assertIn("subcarrier_frequencies(128, 15000.0)", script)
        self.assertIn('paths.cir(normalize_delays=False, out_type="numpy")', script)
        self.assertIn("paths.cfr(", script)

    def test_material_overrides_are_replayed(self):
        script = _load_scene_script(_request(materials=[MaterialConfig(
            id="itu_brick", scatteringCoefficient=0.3, xpdCoefficient=0.1,
            scatteringPattern="directive", relativePermittivity=4.5,
            conductivity=0.02, thickness=0.25,
        )]))
        self.assertIn("scene.radio_materials.get('itu_brick')", script)
        self.assertIn("material.scattering_coefficient = 0.3", script)
        self.assertIn("material.xpd_coefficient = 0.1", script)
        self.assertIn("material.scattering_pattern = DirectivePattern(alpha_r=4)", script)
        self.assertIn("material.relative_permittivity = 4.5", script)
        self.assertIn("material.conductivity = 0.02", script)
        self.assertIn("material.thickness = 0.25", script)
        self.assertIn("    DirectivePattern,", script)  # import pulled in

    def test_concrete_override_is_also_applied_to_ground(self):
        script = _load_scene_script(_request(materials=[MaterialConfig(
            id=GROUND_MATERIAL, scatteringCoefficient=0.4,
            relativePermittivity=6.0, conductivity=0.03,
        )]))
        self.assertIn(
            f"scene.radio_materials.get({GROUND_MATERIAL!r})", script
        )
        self.assertIn(
            f"scene.radio_materials.get({GROUND_BSDF_ID!r})", script
        )

    def test_device_names_are_unique_and_identifier_safe(self):
        script = _load_scene_script(_request(txs=[
            Transmitter(id="a", name="Site A/1", enu=ENUVector(x=0.0, y=0.0, z=0.0)),
            Transmitter(id="b", name="Site A/1", enu=ENUVector(x=1.0, y=1.0, z=0.0)),
        ]))
        self.assertIn("'name': 'tx_00_Site_A_1'", script)
        self.assertIn("'name': 'tx_01_Site_A_1'", script)

    def test_geometry_only_export_still_produces_a_runnable_script(self):
        """Geometry-only export loads cleanly without inventing fake devices."""
        script = _load_scene_script(_request(txs=None, rxs=None))
        compile(script, "load_scene.py", "exec")
        self.assertIn("CHANNEL_GROUPS = []", script)
        self.assertNotIn("tx_placeholder", script)
        self.assertNotIn("rx_placeholder", script)
        self.assertIn("No CIR/CFR generated", script)

    def test_one_sided_device_scene_skips_solver_without_fake_counterpart(self):
        script = _load_scene_script(_request(rxs=None))
        compile(script, "load_scene.py", "exec")
        self.assertIn("CHANNEL_GROUPS = []", script)
        self.assertIn("'id': 'tx1'", script)
        self.assertNotIn("rx_placeholder", script)


class TestArrayGroups(unittest.TestCase):
    def test_uniform_arrays_produce_one_dense_tensor(self):
        groups = _array_groups(_request())
        self.assertEqual(len(groups), 1)
        self.assertEqual(groups[0]["file"], "cir.npz")
        self.assertEqual(groups[0]["txIds"], ["tx1"])
        self.assertEqual(groups[0]["rxIds"], ["rx1"])

    def test_mixed_arrays_cover_every_pair_without_substitution(self):
        req = _request(
            txs=[
                Transmitter(id="tx4", enu=ENUVector(x=0, y=0, z=0),
                            antennaArraySize=(4, 2)),
                Transmitter(id="tx2", enu=ENUVector(x=1, y=0, z=0),
                            antennaArraySize=(2, 1)),
            ],
            rxs=[
                Receiver(id="rx2", enu=ENUVector(x=10, y=0, z=0),
                         antennaArraySize=(2, 1)),
                Receiver(id="rx1", enu=ENUVector(x=11, y=0, z=0),
                         antennaArraySize=(1, 1)),
            ],
        )
        groups = _array_groups(req)
        self.assertEqual(len(groups), 4)
        covered = {
            (tx_id, rx_id)
            for group in groups
            for tx_id in group["txIds"]
            for rx_id in group["rxIds"]
        }
        self.assertEqual(
            covered,
            {("tx4", "rx2"), ("tx4", "rx1"),
             ("tx2", "rx2"), ("tx2", "rx1")},
        )
        self.assertEqual(
            {tuple(group["txArraySize"]) for group in groups},
            {(4, 2), (2, 1)},
        )
        self.assertEqual(
            {tuple(group["rxArraySize"]) for group in groups},
            {(2, 1), (1, 1)},
        )
        self.assertTrue(
            all(group["file"].startswith("channels/") for group in groups)
        )


class TestManifest(unittest.TestCase):
    def test_records_devices_solver_and_geometry(self):
        manifest = _manifest(_request(), ["meshes/ground.ply", "meshes/b0.ply"])
        self.assertEqual(manifest["carrierFrequencyGhz"], 28.0)
        self.assertEqual(manifest["maxDepth"], 4)
        self.assertEqual(manifest["buildingCount"], 1)
        self.assertEqual(manifest["meshFiles"], ["meshes/ground.ply", "meshes/b0.ply"])
        self.assertEqual(manifest["transmitters"][0]["position"], [5.0, 5.0, 26.0])
        self.assertEqual(manifest["transmitters"][0]["antennaArraySize"], [4, 2])
        self.assertEqual(manifest["transmitters"][0]["powerDbm"], 33.0)
        self.assertEqual(manifest["receivers"][0]["position"], [60.0, 40.0, 1.5])
        self.assertEqual(manifest["schemaVersion"], 2)
        self.assertEqual(manifest["channelExportMode"], "uniform")
        self.assertEqual(manifest["arrayGroups"][0]["file"], "cir.npz")

    def test_counts_only_buildings_not_visual_features(self):
        road = _building()
        road.id = "r1"
        road.category = "infrastructure"
        manifest = _manifest(_request(buildings=[_building(), road]), [])
        self.assertEqual(manifest["buildingCount"], 1)


class TestSceneXml(unittest.TestCase):
    """The scene XML must be previewable, not just traceable.

    Sionna's previewer colors geometry by ``shape.bsdf().color``, so the ground
    needs its own material to be distinguishable from concrete buildings, and
    flat faces need ``face_normals`` or Mitsuba smooths the extruded prisms.
    """

    def _root(self) -> ET.Element:
        scene_dir = Path(tempfile.mkdtemp(prefix="xml_test_"))
        meshes = [
            ("meshes/ground.ply", GROUND_BSDF_ID, "mesh-ground"),
            ("meshes/b0.ply", "itu_concrete", "mesh-b0"),
            ("meshes/b1.ply", "itu_brick", "mesh-b1"),
        ]
        path = _write_scene_xml(scene_dir, meshes, {"itu_concrete", "itu_brick"})
        return ET.parse(path).getroot()

    def test_every_shape_uses_flat_face_normals(self):
        shapes = self._root().findall("shape")
        self.assertEqual(len(shapes), 3)
        for shape in shapes:
            flags = {b.get("name"): b.get("value") for b in shape.findall("boolean")}
            self.assertEqual(flags.get("face_normals"), "true")

    def test_shapes_are_named(self):
        ids = [shape.get("id") for shape in self._root().findall("shape")]
        self.assertEqual(ids, ["mesh-ground", "mesh-b0", "mesh-b1"])

    def test_ground_has_its_own_colored_material(self):
        root = self._root()
        bsdfs = {b.get("id"): b for b in root.findall("bsdf")}
        self.assertIn(GROUND_BSDF_ID, bsdfs)
        ground = bsdfs[GROUND_BSDF_ID]
        # Same ITU type as the shared ground material: visual split only.
        types = {s.get("name"): s.get("value") for s in ground.findall("string")}
        concrete = {s.get("name"): s.get("value")
                    for s in bsdfs[GROUND_MATERIAL].findall("string")}
        self.assertEqual(types["type"], concrete["type"])
        color = ground.find("rgb")
        self.assertIsNotNone(color)
        self.assertEqual(
            [float(v) for v in color.get("value").split()],
            [round(c, 3) for c in GROUND_COLOR],
        )

    def test_ground_material_id_cannot_collide_with_a_scene_object_name(self):
        """Sionna strips the ``mesh-`` prefix, so shape ids become object names."""
        shape_ids = [shape.get("id") for shape in self._root().findall("shape")]
        object_names = {sid.removeprefix("mesh-") for sid in shape_ids}
        self.assertNotIn(GROUND_BSDF_ID, object_names)

    def test_buildings_keep_their_own_materials(self):
        refs = [shape.find("ref").get("id") for shape in self._root().findall("shape")]
        self.assertEqual(refs, [GROUND_BSDF_ID, "itu_concrete", "itu_brick"])


class TestDeviceHelpers(unittest.TestCase):
    def test_single_device_form_is_accepted(self):
        req = SceneExportRequest(
            tx=Transmitter(id="tx", name="Tx", enu=ENUVector(x=0.0, y=0.0, z=0.0)),
            rx=Receiver(id="rx", name="Rx", enu=ENUVector(x=50.0, y=0.0, z=0.0)),
            buildings=[_building()],
        )
        self.assertEqual(len(req.transmitters()), 1)
        self.assertEqual(len(req.receivers()), 1)

    def test_no_devices_is_allowed(self):
        req = SceneExportRequest(buildings=[_building()])
        self.assertEqual(req.transmitters(), [])
        self.assertEqual(req.receivers(), [])


if __name__ == "__main__":
    unittest.main()
