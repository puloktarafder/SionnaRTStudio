"""Unit tests for the pure-math pieces of the solver (no GPU / Sionna needed).

Run with:  .venv/bin/python -m unittest discover backend/tests
"""
import math
import unittest

import numpy as np

from backend.models import CIRRequest, ENUVector, PropagationPath, Receiver, Transmitter
from backend.scene_build import _geometry_hash
from backend.models import BuildingFootprint, MaterialConfig
from backend.solver import (
    _az_el,
    _beam_target,
    _beamform,
    _channel_metrics,
    _coverage_stats,
    _default_threshold,
    _empty_metrics,
    _mobility_step,
    _notebook_tau_shape,
    _path_type,
    _rx_path_power,
    _TxSpec,
    _uniform_array_size,
)


def _path(power_dbm: float, delay_ns: float, ptype: str = "LOS") -> PropagationPath:
    return PropagationPath(
        id="p", points=[ENUVector(x=0, y=0, z=0), ENUVector(x=1, y=0, z=0)],
        type=ptype, order=0 if ptype == "LOS" else 1, distance=1.0,
        pathLossDb=0.0, receivedPowerDbm=power_dbm, delayNs=delay_ns,
    )


class TestAzEl(unittest.TestCase):
    def test_zenith_maps_to_elevation(self):
        # theta is the zenith angle: 0 rad = straight up = +90 deg elevation.
        _, el = _az_el(0.0, 0.0)
        self.assertAlmostEqual(el, 90.0)
        _, el = _az_el(math.pi / 2, 0.0)
        self.assertAlmostEqual(el, 0.0)

    def test_azimuth_convention_clockwise_from_north(self):
        # Sionna phi is measured from East, CCW. App: from North, CW.
        az, _ = _az_el(math.pi / 2, 0.0)            # pointing East
        self.assertAlmostEqual(az, 90.0)
        az, _ = _az_el(math.pi / 2, math.pi / 2)    # pointing North
        self.assertAlmostEqual(az, 0.0)
        az, _ = _az_el(math.pi / 2, math.pi)        # pointing West
        self.assertAlmostEqual(az, -90.0)

    def test_nan_angles_return_none(self):
        self.assertEqual(_az_el(float("nan"), 0.0), (None, None))


class TestBeamTarget(unittest.TestCase):
    def test_north_and_east(self):
        # az=0 → North (+y), az=90 → East (+x); elevation raises z.
        t = _beam_target([0, 0, 10], 0.0, 0.0)
        self.assertAlmostEqual(t[0], 0.0, places=6)
        self.assertGreater(t[1], 0.0)
        self.assertAlmostEqual(t[2], 10.0, places=6)
        t = _beam_target([0, 0, 10], 90.0, 0.0)
        self.assertGreater(t[0], 0.0)
        self.assertAlmostEqual(t[1], 0.0, places=4)
        t = _beam_target([0, 0, 10], 0.0, 90.0)
        self.assertAlmostEqual(t[2], 110.0, places=4)


class TestBeamform(unittest.TestCase):
    def test_coherent_sum_gain(self):
        # 4 antennas, 2 paths, all-ones coefficients (antenna-major layout):
        # coherent sum / sqrt(4) = 2.0 per path (i.e. +6 dB array gain in power).
        a = np.ones(4 * 2, dtype=complex)
        out = _beamform(a, 4, 2)
        self.assertEqual(out.shape, (1, 2))
        np.testing.assert_allclose(out[0], [2.0, 2.0])

    def test_single_antenna_identity(self):
        a = np.array([1 + 1j, 2 - 1j])
        np.testing.assert_allclose(_beamform(a, 1, 2), a[None, :])

    def test_preserves_receive_port_axis(self):
        # 3 Rx ports × 2 Tx ports × 2 paths. Tx ports combine coherently, while
        # each physical Rx port remains separate.
        a = np.ones((3, 2, 2), dtype=complex)
        out = _beamform(a, 2, 2)
        self.assertEqual(out.shape, (3, 2))
        np.testing.assert_allclose(out, math.sqrt(2))

    def test_rejects_incompatible_shape(self):
        with self.assertRaises(ValueError):
            _beamform(np.ones(5), 2, 2)


class TestReceivePortPower(unittest.TestCase):
    def test_sum_of_physical_port_powers(self):
        # Two equal receive ports yield 2× signal power (+3.0103 dB), without
        # any separately injected analytic array gain.
        a = np.array([[1.0, 2.0], [1.0j, -2.0j]])
        power, reference = _rx_path_power(a)
        np.testing.assert_allclose(power, [2.0, 8.0])
        np.testing.assert_allclose(np.abs(reference), [1.0, 2.0])

    def test_single_port_identity(self):
        a = np.array([1 + 1j, 2 - 1j])
        power, reference = _rx_path_power(a)
        np.testing.assert_allclose(power, np.abs(a) ** 2)
        np.testing.assert_allclose(reference, a)


class TestCirDeviceSelection(unittest.TestCase):
    @staticmethod
    def _tx(device_id: str, size=(2, 1)):
        return Transmitter(
            id=device_id, enu=ENUVector(x=0, y=0, z=0),
            antennaArraySize=size,
        )

    @staticmethod
    def _rx(device_id: str, size=(1, 1)):
        return Receiver(
            id=device_id, enu=ENUVector(x=1, y=0, z=0),
            antennaArraySize=size,
        )

    def test_request_accepts_multi_device_and_legacy_forms(self):
        txs = [self._tx("tx1"), self._tx("tx2")]
        rxs = [self._rx("rx1"), self._rx("rx2")]
        multi = CIRRequest(txs=txs, rxs=rxs, buildings=[])
        self.assertEqual([tx.id for tx in multi.transmitters()], ["tx1", "tx2"])
        self.assertEqual([rx.id for rx in multi.receivers()], ["rx1", "rx2"])

        legacy = CIRRequest(tx=txs[0], rx=rxs[0], buildings=[])
        self.assertEqual(legacy.transmitters()[0].id, "tx1")
        self.assertEqual(legacy.receivers()[0].id, "rx1")

    def test_request_rejects_missing_devices(self):
        request = CIRRequest(buildings=[])
        with self.assertRaisesRegex(ValueError, "txs.*tx"):
            request.transmitters()
        with self.assertRaisesRegex(ValueError, "rxs.*rx"):
            request.receivers()

    def test_multi_device_csv_is_rejected(self):
        request = CIRRequest(
            txs=[self._tx("tx1"), self._tx("tx2")],
            rxs=[self._rx("rx1")],
            buildings=[],
            format="cir_csv",
        )
        with self.assertRaisesRegex(ValueError, "CSV export supports one"):
            request.validate_format_scope()
        request.format = "cir_npz"
        request.validate_format_scope()

    def test_uniform_array_validation(self):
        self.assertEqual(
            _uniform_array_size([self._tx("tx1"), self._tx("tx2")], "Transmitter"),
            (2, 1),
        )
        with self.assertRaisesRegex(ValueError, "matching antennaArraySize"):
            _uniform_array_size(
                [self._tx("tx1", (2, 1)), self._tx("tx2", (4, 1))],
                "Transmitter",
            )

    def test_synthetic_tau_broadcast_matches_notebook_axes(self):
        a = np.zeros((2, 3, 4, 5, 7, 1), dtype=complex)
        tau_geometric = np.arange(2 * 4 * 7).reshape(2, 4, 7)
        tau = _notebook_tau_shape(a, tau_geometric)
        self.assertEqual(tau.shape, a.shape[:-1])
        np.testing.assert_array_equal(tau[:, 0, :, 0, :], tau_geometric)
        np.testing.assert_array_equal(tau[:, -1, :, -1, :], tau_geometric)


class TestChannelMetrics(unittest.TestCase):
    def test_empty(self):
        m = _channel_metrics([])
        self.assertEqual(m.numPaths, 0)
        self.assertEqual(m.losStatus, "NLOS")
        self.assertEqual(m, _empty_metrics())

    def test_total_power_is_linear_sum(self):
        # Two equal -60 dBm paths → total = -60 + 10*log10(2) ≈ -56.99 dBm.
        m = _channel_metrics([_path(-60, 100), _path(-60, 200, "Reflection")])
        self.assertAlmostEqual(m.totalRxPowerDbm, -60 + 10 * math.log10(2), places=6)
        self.assertEqual(m.numPaths, 2)
        self.assertEqual(m.losStatus, "LOS")
        self.assertEqual(m.strongestPathPowerDbm, -60)

    def test_rms_delay_spread(self):
        # Equal powers at 100 ns and 200 ns → mean 150, RMS spread 50 ns.
        m = _channel_metrics([_path(-60, 100), _path(-60, 200, "Reflection")])
        self.assertAlmostEqual(m.rmsDelaySpreadNs, 50.0, places=6)

    def test_nlos_when_no_los_path(self):
        m = _channel_metrics([_path(-70, 100, "Reflection")])
        self.assertEqual(m.losStatus, "NLOS")


class TestMobilityAggregation(unittest.TestCase):
    def setUp(self):
        self.specs = [
            _TxSpec(pos=[0, 0, 10], beam=None, power_dbm=30, id="tx1", name="Tx 1"),
            _TxSpec(pos=[10, 0, 10], beam=None, power_dbm=30, id="tx2", name="Tx 2"),
        ]

    def test_sum_is_noncoherent_power_and_has_no_joint_delay_spread(self):
        # Widely separated delay origins would create a huge but meaningless
        # cross-Tx delay spread if independent cells were merged as one channel.
        step = _mobility_step(
            0, [1, 2, 1.5], self.specs,
            [([_path(-60, 0)], 100.0), ([_path(-60, 1_000_000)], 200.0)],
            "sum",
        )
        self.assertAlmostEqual(step.receivedPowerDbm, -60 + 10 * math.log10(2), places=6)
        self.assertFalse(step.rmsDelaySpreadValid)
        self.assertEqual(step.rmsDelaySpreadNs, 0.0)
        self.assertEqual(step.numPaths, 2)
        self.assertIsNone(step.servingTxId)
        self.assertEqual([metric.rmsDelaySpreadNs for metric in step.perTx], [0.0, 0.0])

    def test_best_server_preserves_serving_link_metrics(self):
        step = _mobility_step(
            0, [1, 2, 1.5], self.specs,
            [([_path(-70, 0)], 100.0), ([_path(-60, 10)], 200.0)],
            "best_server",
        )
        self.assertEqual(step.servingTxId, "tx2")
        self.assertTrue(step.rmsDelaySpreadValid)
        self.assertAlmostEqual(step.receivedPowerDbm, -60.0)
        self.assertEqual(step.maxDopplerHz, 200.0)

    def test_sum_does_not_add_no_path_sentinels(self):
        empty_step = _mobility_step(
            0, [1, 2, 1.5], self.specs,
            [([], 0.0), ([], 0.0)],
            "sum",
        )
        self.assertEqual(empty_step.receivedPowerDbm, -200.0)
        self.assertEqual(empty_step.numPaths, 0)
        self.assertEqual(empty_step.losStatus, "NLOS")
        self.assertFalse(empty_step.rmsDelaySpreadValid)

        weak_reachable_step = _mobility_step(
            0, [1, 2, 1.5], self.specs,
            [([_path(-250, 0)], 0.0), ([], 0.0)],
            "sum",
        )
        self.assertAlmostEqual(weak_reachable_step.receivedPowerDbm, -250.0)
        self.assertEqual(weak_reachable_step.numPaths, 1)


class TestPathType(unittest.TestCase):
    def test_classification(self):
        self.assertEqual(_path_type(0, []), "LOS")
        self.assertEqual(_path_type(1, [1]), "Reflection")       # specular only
        self.assertEqual(_path_type(2, [1, 8]), "Diffraction")   # any diffraction
        self.assertEqual(_path_type(2, [1, 2]), "NLOS")          # mixed / diffuse


class TestCoverageStats(unittest.TestCase):
    def test_default_thresholds(self):
        self.assertEqual(_default_threshold("power", None), -90.0)
        self.assertEqual(_default_threshold("sinr", None), 0.0)
        self.assertEqual(_default_threshold("power", -75.0), -75.0)

    def test_served_percent_ignores_non_finite(self):
        vals = np.array([-80.0, -100.0, -np.inf, np.nan])
        s = _coverage_stats(vals, "power", -90.0)
        self.assertAlmostEqual(s.servedPercent, 50.0)  # of the 2 finite cells
        self.assertEqual(s.minVal, -100.0)
        self.assertEqual(s.maxVal, -80.0)

    def test_empty_grid(self):
        s = _coverage_stats(np.array([]), "sinr", 0.0)
        self.assertEqual(s.servedPercent, 0.0)
        self.assertEqual(s.unit, "dB")


class TestGeometryHash(unittest.TestCase):
    def _building(self, height: float = 10.0, material: str = "itu_concrete"):
        return BuildingFootprint(
            id="b1", category="building", height=height, material=material,
            enuPoints=[ENUVector(x=0, y=0, z=0), ENUVector(x=10, y=0, z=0),
                       ENUVector(x=10, y=10, z=0)],
        )

    def test_stable_for_identical_input(self):
        self.assertEqual(_geometry_hash([self._building()], 28.0),
                         _geometry_hash([self._building()], 28.0))

    def test_changes_with_geometry_frequency_and_materials(self):
        base = _geometry_hash([self._building()], 28.0)
        self.assertNotEqual(base, _geometry_hash([self._building(height=12.0)], 28.0))
        self.assertNotEqual(base, _geometry_hash([self._building()], 3.5))
        override = [MaterialConfig(id="itu_concrete", scatteringCoefficient=0.4)]
        self.assertNotEqual(base, _geometry_hash([self._building()], 28.0, override))


if __name__ == "__main__":
    unittest.main()
