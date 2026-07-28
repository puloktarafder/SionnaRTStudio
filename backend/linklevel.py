"""Link-level channel KPIs from the ray-traced CFR — no PHY dependencies.

Turns one link's ``paths.cfr()`` output into Shannon-capacity KPIs, pure NumPy:

* open-loop capacity  ``log2 det(I + rho/Nt · H Hᴴ)``  (equal power, no CSIT)
* beamformed capacity ``log2(1 + rho · sigma_max²(H))`` (single-stream MRT/MRC)
* uniform-precoding capacity — the SNR the app's own sum/sqrt(Nt) beamformer
  actually delivers, so the gap to MRT is the achievable beamforming gain
* spatial eigenstructure (effective rank / condition number), coherence
  bandwidth, and a link-budget effective SNR.

``rho`` is the transmit-reference SNR (Tx power over thermal noise across the
OFDM band), applied to the *physical* un-normalized channel, so every capacity
number is consistent with the link budget shown elsewhere in the app. The
per-subcarrier H preserves both physical scene-array axes; spatial metrics use
the frequency-averaged transmit covariance so rank-deficient few-path channels
remain meaningful.
"""
from __future__ import annotations

import math

import numpy as np

BOLTZMANN = 1.380649e-23
# Same reference temperature the radio-map SINR noise floor uses (solver.py).
NOISE_TEMPERATURE_K = 293.0

# Receive-SNR sweep (uniform-precoding reference) for the capacity curve [dB].
SNR_CURVE_DB = [float(s) for s in range(-10, 41, 2)]
MAX_SPECTRUM_POINTS = 256
MAX_EIGENVALUES = 8
# Covariance eigenvalues below lambda_max * this are numerical zeros (a
# few-path channel is genuinely rank-deficient), not part of the condition number.
EIG_FLOOR_REL = 1e-9


def noise_power_dbm(bandwidth_hz: float, noise_figure_db: float) -> float:
    """Thermal noise over the OFDM band, receiver noise figure folded in."""
    return (10.0 * math.log10(BOLTZMANN * NOISE_TEMPERATURE_K * bandwidth_hz * 1e3)
            + float(noise_figure_db))


def _capacity_at(h: np.ndarray, h_bf: np.ndarray, rho: float, n_tx_ant: int) -> tuple[float, float, float]:
    """Mean-over-subcarriers (open-loop, beamformed, uniform) capacity [bit/s/Hz].

    ``h`` is (n_rx_ant, n_tx_ant, num_sc); ``h_bf`` the uniform-precoded
    (n_rx_ant, num_sc). ``rho`` is the transmit-reference SNR (linear).
    """
    # Per-subcarrier Gram matrix G(f) = H(f) H(f)ᴴ — (num_sc, n_rx, n_rx), small.
    g = np.einsum("atf,btf->fab", h, h.conj())
    n_rx = h.shape[0]
    eye = np.eye(n_rx)
    _, logdet = np.linalg.slogdet(eye[None, :, :] + (rho / n_tx_ant) * g)
    open_loop = float(np.mean(logdet) / math.log(2.0))

    # sigma_max²(H(f)) = lambda_max(G(f)): full power on the strongest eigenmode.
    lam_max = np.linalg.eigvalsh(g)[:, -1].clip(min=0.0)
    beamformed = float(np.mean(np.log2(1.0 + rho * lam_max)))

    # What the app's sum/sqrt(Nt) precoder delivers (MRC over Rx antennas).
    uni = (np.abs(h_bf) ** 2).sum(axis=0)
    uniform = float(np.mean(np.log2(1.0 + rho * uni)))
    return open_loop, beamformed, uniform


def _spatial_structure(h: np.ndarray) -> tuple[float | None, float | None, list[float]]:
    """Effective rank, condition number [dB], eigenvalues [dB rel. strongest]
    of the frequency-averaged transmit covariance R = mean_f H(f)ᴴ H(f)."""
    num_sc = h.shape[-1]
    r = np.einsum("rtf,rsf->ts", h.conj(), h) / num_sc
    lam = np.linalg.eigvalsh(r)[::-1].clip(min=0.0)
    if lam.size == 0 or lam[0] <= 0.0:
        return None, None, []
    sig = lam[lam > lam[0] * EIG_FLOOR_REL]
    p = sig / sig.sum()
    effective_rank = float(np.exp(-(p * np.log(p)).sum()))
    condition_db = float(10.0 * math.log10(sig[0] / sig[-1]))
    eig_db = [float(10.0 * math.log10(v / lam[0])) for v in sig[:MAX_EIGENVALUES]]
    return effective_rank, condition_db, eig_db


def _coherence_bandwidth(h_bf: np.ndarray, spacing_hz: float) -> float | None:
    """Smallest lag where the vector-CFR autocorrelation drops below 0.5.

    ``h_bf`` retains the physical receive-port axis. Correlations are summed
    across those ports, which is the multi-element generalization of the former
    single-Rx-port calculation. ``None`` means flat over the measured band.
    """
    h = np.atleast_2d(np.asarray(h_bf, dtype=complex))
    num_sc = h.shape[-1]
    if num_sc < 2 or not np.any(np.abs(h) > 0):
        return None
    # Unbiased autocorrelation: divide each lag by its overlap count, else the
    # shrinking window makes even a flat channel decay linearly with lag.
    overlap = np.arange(num_sc, 0, -1)
    r = sum(
        np.correlate(port, port, mode="full")[num_sc - 1:] / overlap
        for port in h
    )
    r0 = np.abs(r[0])
    if r0 <= 0:
        return None
    below = np.nonzero(np.abs(r) / r0 < 0.5)[0]
    if below.size == 0:
        return None
    return float(below[0] * spacing_hz)


def compute_link_kpis(
    h,
    frequencies,
    n_tx_ant: int,
    tx_power_dbm: float,
    subcarrier_spacing: float,
    num_subcarriers: int,
    noise_figure_db: float,
    snr_override_db: float | None = None,
) -> dict:
    """All Tier-1 link KPIs from a single link's CFR (``solve_cir`` output).

    ``h`` is the raw ``paths.cfr()`` array for one Tx→Rx link; its singleton
    device/time axes fold to (n_rx_ant, n_tx_ant, num_sc) in C order.
    """
    num_sc = max(1, int(num_subcarriers))
    n_tx = max(1, int(n_tx_ant))
    arr = np.asarray(h, dtype=complex).reshape(-1)
    n_rx_ant = max(1, arr.size // (n_tx * num_sc))
    hm = arr.reshape(n_rx_ant, n_tx, num_sc)
    freqs = np.asarray(frequencies, dtype=float).reshape(-1)[:num_sc]

    bandwidth_hz = num_sc * float(subcarrier_spacing)
    noise_dbm = noise_power_dbm(bandwidth_hz, noise_figure_db)

    # Uniform precoding (the app's beamformer) → link-budget receive power.
    h_bf = hm.sum(axis=1) / math.sqrt(n_tx)          # (n_rx_ant, num_sc)
    mean_gain_uniform = float((np.abs(h_bf) ** 2).sum(axis=0).mean())

    base = {
        "numTxAnt": n_tx,
        "numRxAnt": n_rx_ant,
        "numSubcarriers": num_sc,
        "bandwidthHz": bandwidth_hz,
        "noisePowerDbm": noise_dbm,
        "snrSource": "override" if snr_override_db is not None else "link_budget",
    }
    if mean_gain_uniform <= 0.0:  # no paths reached the receiver
        return {
            **base,
            "reachable": False,
            "rxPowerDbm": None, "effectiveSnrDb": None,
            "capacityOpenLoopBitsHz": 0.0, "capacityBeamformedBitsHz": 0.0,
            "capacityUniformBitsHz": 0.0, "throughputMbps": 0.0,
            "beamformingGainDb": None, "conditionNumberDb": None,
            "effectiveRank": None, "spatialEigenvaluesDb": [],
            "coherenceBw50Hz": None,
            "curve": {"snrDb": [], "openLoop": [], "beamformed": []},
            "spectrum": {"frequencyHz": [], "gainDb": [], "capacity": []},
        }

    rx_power_dbm = float(tx_power_dbm) + 10.0 * math.log10(mean_gain_uniform)
    link_budget_snr_db = rx_power_dbm - noise_dbm
    operating_snr_db = (float(snr_override_db) if snr_override_db is not None
                        else link_budget_snr_db)
    # Transmit-reference SNR whose uniform-precoded receive SNR equals the
    # operating point — capacities then use the physical H with no double count.
    rho = 10.0 ** (operating_snr_db / 10.0) / mean_gain_uniform

    open_loop, beamformed, uniform = _capacity_at(hm, h_bf, rho, n_tx)

    # MRT-vs-uniform array gain: how far the steered uniform beam is from ideal.
    g = np.einsum("atf,btf->fab", hm, hm.conj())
    lam_max_mean = float(np.mean(np.linalg.eigvalsh(g)[:, -1].clip(min=0.0)))
    beamforming_gain_db = 10.0 * math.log10(max(lam_max_mean, 1e-30) / mean_gain_uniform)

    effective_rank, condition_db, eig_db = _spatial_structure(hm)
    coherence = _coherence_bandwidth(h_bf, float(subcarrier_spacing))

    curve_ol: list[float] = []
    curve_bf: list[float] = []
    for snr_db in SNR_CURVE_DB:
        rho_s = 10.0 ** (snr_db / 10.0) / mean_gain_uniform
        ol, bf, _ = _capacity_at(hm, h_bf, rho_s, n_tx)
        curve_ol.append(ol)
        curve_bf.append(bf)

    # Per-subcarrier series at the operating point, decimated for the UI chart.
    per_sc_gain = (np.abs(h_bf) ** 2).sum(axis=0)
    n_rx = hm.shape[0]
    _, logdet = np.linalg.slogdet(np.eye(n_rx)[None, :, :] + (rho / n_tx) * g)
    per_sc_capacity = logdet / math.log(2.0)
    stride = max(1, math.ceil(num_sc / MAX_SPECTRUM_POINTS))
    with np.errstate(divide="ignore"):
        gain_db = 10.0 * np.log10(per_sc_gain[::stride])
    gain_db = np.maximum(gain_db, -300.0)

    return {
        **base,
        "reachable": True,
        "rxPowerDbm": rx_power_dbm,
        "effectiveSnrDb": operating_snr_db,
        "capacityOpenLoopBitsHz": open_loop,
        "capacityBeamformedBitsHz": beamformed,
        "capacityUniformBitsHz": uniform,
        "throughputMbps": open_loop * bandwidth_hz / 1e6,
        "beamformingGainDb": beamforming_gain_db,
        "conditionNumberDb": condition_db,
        "effectiveRank": effective_rank,
        "spatialEigenvaluesDb": eig_db,
        "coherenceBw50Hz": coherence,
        "curve": {"snrDb": list(SNR_CURVE_DB), "openLoop": curve_ol, "beamformed": curve_bf},
        "spectrum": {
            "frequencyHz": [float(v) for v in freqs[::stride]],
            "gainDb": [float(v) for v in gain_db],
            "capacity": [float(v) for v in per_sc_capacity[::stride]],
        },
    }
