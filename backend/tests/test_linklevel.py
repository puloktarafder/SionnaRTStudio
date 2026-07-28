"""Unit tests for the link-level KPI math (no GPU / Sionna needed).

Run with:  .venv/bin/python -m unittest discover backend/tests
"""
import math
import unittest

import numpy as np

from backend.linklevel import (
    BOLTZMANN,
    NOISE_TEMPERATURE_K,
    _coherence_bandwidth,
    compute_link_kpis,
    noise_power_dbm,
)


def _kpis(h, n_tx_ant, num_sc, **kw):
    """compute_link_kpis with the boilerplate filled in (30 kHz spacing)."""
    spacing = 30_000.0
    freqs = (np.arange(num_sc) - num_sc / 2) * spacing
    defaults = dict(tx_power_dbm=30.0, subcarrier_spacing=spacing,
                    num_subcarriers=num_sc, noise_figure_db=7.0)
    defaults.update(kw)
    return compute_link_kpis(h, freqs, n_tx_ant, **defaults)


class TestNoiseFloor(unittest.TestCase):
    def test_thermal_noise_plus_nf(self):
        # kTB over 100 MHz at 293 K ≈ -103.9 dBm; +7 dB NF.
        expected = 10 * math.log10(BOLTZMANN * NOISE_TEMPERATURE_K * 100e6 * 1e3) + 7.0
        self.assertAlmostEqual(noise_power_dbm(100e6, 7.0), expected, places=9)


class TestFlatSisoChannel(unittest.TestCase):
    """h(f) = 1 for all subcarriers, one Tx antenna: every capacity definition
    collapses to log2(1 + SNR) and the channel is flat."""

    def setUp(self):
        self.num_sc = 64
        h = np.ones((1, 1, 1, 1, self.num_sc, 1), dtype=complex)  # raw cfr layout
        self.k = _kpis(h, n_tx_ant=1, num_sc=self.num_sc, snr_override_db=10.0)

    def test_capacities_match_closed_form(self):
        expected = math.log2(1 + 10.0)  # SNR 10 dB
        for key in ("capacityOpenLoopBitsHz", "capacityBeamformedBitsHz",
                    "capacityUniformBitsHz"):
            self.assertAlmostEqual(self.k[key], expected, places=9, msg=key)

    def test_throughput_is_capacity_times_bandwidth(self):
        bw = self.num_sc * 30_000.0
        self.assertAlmostEqual(self.k["throughputMbps"],
                               self.k["capacityOpenLoopBitsHz"] * bw / 1e6, places=9)

    def test_flat_channel_has_no_coherence_rolloff(self):
        self.assertIsNone(self.k["coherenceBw50Hz"])

    def test_snr_override_reported(self):
        self.assertEqual(self.k["snrSource"], "override")
        self.assertAlmostEqual(self.k["effectiveSnrDb"], 10.0)


class TestMisoBeamforming(unittest.TestCase):
    """4 Tx antennas, equal-phase unit coefficients: the uniform sum/sqrt(Nt)
    precoder is already MRT-optimal, so uniform == beamformed == log2(1+SNR·Nt)
    and open loop (no CSIT) is log2(1+SNR)."""

    def setUp(self):
        self.nt, self.num_sc = 4, 32
        h = np.ones((1, 1, 1, self.nt, self.num_sc, 1), dtype=complex)
        # Override sets the RECEIVE SNR of the uniform precoder to 10 dB.
        self.k = _kpis(h, n_tx_ant=self.nt, num_sc=self.num_sc, snr_override_db=10.0)

    def test_uniform_equals_mrt_when_phases_align(self):
        self.assertAlmostEqual(self.k["capacityUniformBitsHz"],
                               self.k["capacityBeamformedBitsHz"], places=9)
        self.assertAlmostEqual(self.k["capacityUniformBitsHz"],
                               math.log2(1 + 10.0), places=9)
        self.assertAlmostEqual(self.k["beamformingGainDb"], 0.0, places=9)

    def test_open_loop_loses_array_gain(self):
        # Receive SNR 10 dB includes the Nt=4 coherent array gain; isotropic
        # input strips it: rho = snr/Nt and rho/Nt·||h||² = snr/Nt (||h||² = Nt),
        # i.e. 10 dB − 6.02 dB at the detector.
        self.assertAlmostEqual(self.k["capacityOpenLoopBitsHz"],
                               math.log2(1 + 10.0 / self.nt), places=9)

    def test_rank_one_channel(self):
        self.assertAlmostEqual(self.k["effectiveRank"], 1.0, places=6)
        self.assertEqual(self.k["conditionNumberDb"], 0.0)


class TestPhysicalReceiveArray(unittest.TestCase):
    def test_receive_ports_are_preserved_and_power_sums(self):
        # Two equal physical Rx ports and one Tx port: link-budget receive power
        # is 3.0103 dB above one port, and the response advertises numRxAnt=2.
        num_sc = 32
        h = np.ones((1, 2, 1, 1, num_sc, 1), dtype=complex)
        k = _kpis(h, n_tx_ant=1, num_sc=num_sc)
        noise = noise_power_dbm(num_sc * 30_000.0, 7.0)
        self.assertEqual(k["numRxAnt"], 2)
        self.assertAlmostEqual(k["rxPowerDbm"], 30.0 + 10 * math.log10(2), places=9)
        self.assertAlmostEqual(
            k["effectiveSnrDb"], k["rxPowerDbm"] - noise, places=9
        )

    def test_vector_coherence_uses_all_receive_ports(self):
        num_sc = 64
        h = np.vstack([
            np.ones(num_sc, dtype=complex),
            np.ones(num_sc, dtype=complex) * 1j,
        ])
        self.assertIsNone(_coherence_bandwidth(h, 30_000.0))


class TestMisdirectedBeam(unittest.TestCase):
    def test_alternating_phases_recover_full_mrt_gain(self):
        # h = [+1, -1]: the uniform (equal-phase) precoder nulls itself out is
        # avoided by construction ((1-1)/sqrt(2) = 0) — use [1, -1] on 2 ants:
        # uniform gain |1-1|²/2 = 0 → unreachable via uniform, but MRT gets
        # ||h||² = 2. Use a small leak so the link budget stays finite.
        nt, num_sc = 2, 16
        h = np.zeros((1, 1, 1, nt, num_sc, 1), dtype=complex)
        h[..., 0, :, 0] = 1.0
        h[..., 1, :, 0] = -0.9
        k = _kpis(h, n_tx_ant=nt, num_sc=num_sc, snr_override_db=10.0)
        # MRT beats the misdirected uniform beam by ||h||²·Nt/|Σh|² = 1.81·2/0.01
        expected_gain_db = 10 * math.log10((1 + 0.81) / (0.1 ** 2 / 2))
        self.assertAlmostEqual(k["beamformingGainDb"], expected_gain_db, places=6)
        self.assertGreater(k["capacityBeamformedBitsHz"], k["capacityUniformBitsHz"])


class TestTwoTapChannel(unittest.TestCase):
    def test_coherence_bandwidth_of_two_equal_taps(self):
        # h(f) = 1 + e^{-j2πfΔτ}: |R(Δf)|/R(0) = |cos(πΔfΔτ)| < 0.5 first at
        # Δf = 1/(3Δτ). Δτ = 1 µs, spacing 30 kHz → expect ≈ 333.3 kHz.
        spacing, num_sc = 30_000.0, 1024
        dtau = 1e-6
        f = (np.arange(num_sc) - num_sc / 2) * spacing
        s = (1.0 + np.exp(-2j * np.pi * f * dtau)).reshape(1, num_sc)
        bc = _coherence_bandwidth(s, spacing)
        self.assertIsNotNone(bc)
        self.assertAlmostEqual(bc, 1 / (3 * dtau), delta=2 * spacing)

    def test_frequency_selective_capacity_below_flat(self):
        # Jensen: mean_f log2(1+SNR|h(f)|²) < log2(1+SNR·mean|h|²) when |h|
        # varies. Same mean gain as the flat channel, lower capacity.
        spacing, num_sc = 30_000.0, 512
        f = (np.arange(num_sc) - num_sc / 2) * spacing
        hf = 1.0 + np.exp(-2j * np.pi * f * 1e-6)
        # Normalize to unit mean power so the link budgets match the flat case.
        hf = hf / np.sqrt(np.mean(np.abs(hf) ** 2))
        h_sel = hf.reshape(1, 1, 1, 1, num_sc, 1)
        h_flat = np.ones((1, 1, 1, 1, num_sc, 1), dtype=complex)
        k_sel = _kpis(h_sel, 1, num_sc, snr_override_db=10.0)
        k_flat = _kpis(h_flat, 1, num_sc, snr_override_db=10.0)
        self.assertLess(k_sel["capacityUniformBitsHz"], k_flat["capacityUniformBitsHz"])


class TestLinkBudgetSnr(unittest.TestCase):
    def test_effective_snr_from_link_budget(self):
        # |h|² = 1e-10 (−100 dB path gain), Ptx = 30 dBm over 64×30 kHz.
        num_sc = 64
        h = np.full((1, 1, 1, 1, num_sc, 1), 1e-5, dtype=complex)
        k = _kpis(h, 1, num_sc, tx_power_dbm=30.0)
        noise = noise_power_dbm(num_sc * 30_000.0, 7.0)
        self.assertEqual(k["snrSource"], "link_budget")
        self.assertAlmostEqual(k["rxPowerDbm"], 30.0 - 100.0, places=6)
        self.assertAlmostEqual(k["effectiveSnrDb"], -70.0 - noise, places=6)

    def test_unreachable_link(self):
        k = _kpis(np.zeros((1, 1, 1, 1, 16, 1), dtype=complex), 1, 16)
        self.assertFalse(k["reachable"])
        self.assertIsNone(k["rxPowerDbm"])
        self.assertEqual(k["capacityOpenLoopBitsHz"], 0.0)


class TestCurveAndSpectrum(unittest.TestCase):
    def setUp(self):
        num_sc = 512
        f = (np.arange(num_sc) - num_sc / 2) * 30_000.0
        hf = 1.0 + 0.5 * np.exp(-2j * np.pi * f * 2e-7)
        self.k = _kpis(hf.reshape(1, 1, 1, 1, num_sc, 1), 1, num_sc,
                       snr_override_db=10.0)

    def test_curve_monotonic_and_bf_dominates(self):
        ol = self.k["curve"]["openLoop"]
        bf = self.k["curve"]["beamformed"]
        self.assertEqual(len(ol), len(self.k["curve"]["snrDb"]))
        self.assertTrue(all(b >= a for a, b in zip(ol, ol[1:])))
        self.assertTrue(all(b >= o - 1e-9 for o, b in zip(ol, bf)))

    def test_spectrum_is_decimated(self):
        n = len(self.k["spectrum"]["frequencyHz"])
        self.assertLessEqual(n, 256)
        self.assertEqual(n, len(self.k["spectrum"]["gainDb"]))
        self.assertEqual(n, len(self.k["spectrum"]["capacity"]))


if __name__ == "__main__":
    unittest.main()
