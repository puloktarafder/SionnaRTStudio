"""Full PHY link-level chain: ray-traced CIR → 5G NR PUSCH BER/BLER sweep.

Tier 2 of the link-level feature. The ray-traced channel of the active link is
replayed through Sionna PHY's standard-compliant NR PUSCH chain — transport
block segmentation + LDPC, QAM, DMRS-based LS channel estimation, LMMSE
equalization — and swept over Eb/N0 to produce BER/BLER waterfall curves.

The RT link is base-station array → configurable UE receive array. Sionna's NR
module implements PUSCH (uplink), so the chain runs the RECIPROCAL link: one UE
stream is uniformly precoded over the UE array and the base-station array
receives over the transposed per-element channel (reciprocity holds per antenna
pair). The CFR is normalized to unit average energy, so the sweep's Eb/N0 axis
is relative to the mean received symbol energy — the curve isolates the
channel's frequency/spatial selectivity from its absolute path loss.

The ``sionna`` PHY package (torch-based) is OPTIONAL: ``phy_available()`` is a
cheap probe used by /api/health, and the heavy imports happen only inside a
running job. The PHY is pinned to the CPU so the GPU stays exclusive to
Mitsuba/DrJit ray tracing (backend/requirements-phy.txt to install).
"""
from __future__ import annotations

import importlib.util
from typing import Callable


def phy_available() -> bool:
    """True when the optional Sionna PHY package is importable (no import cost)."""
    try:
        return importlib.util.find_spec("sionna.phy") is not None
    except Exception:
        return False


def run_pusch_ber_sweep(
    cir: dict,
    *,
    mcs_index: int,
    num_prb: int,
    snr_points_db: list[float],
    slots_per_point: int,
    seed: int,
    progress: Callable[[float, str], None] = lambda f, m: None,
) -> dict:
    """Sweep Eb/N0 over the ray-traced channel through the NR PUSCH chain.

    ``cir`` is ``solve_cir`` output (``a``, ``tau`` and the OFDM grid metadata).
    Runs entirely on the CPU; call WITHOUT holding the RT solver lock.
    """
    import numpy as np
    import sionna.phy
    sionna.phy.config.device = "cpu"   # GPU stays exclusive to the RT solver
    sionna.phy.config.seed = int(seed)  # reproducible noise/payloads
    import torch
    from sionna.phy.channel import (ApplyOFDMChannel, cir_to_ofdm_channel,
                                    subcarrier_frequencies)
    from sionna.phy.nr import PUSCHConfig, PUSCHReceiver, PUSCHTransmitter
    from sionna.phy.utils import ebnodb2no

    a = np.asarray(cir["a"])
    tau = np.asarray(cir["tau"], dtype=float)
    if a.ndim != 6:
        raise ValueError(f"Expected 6-D CIR coefficients, got shape {a.shape}")
    num_paths = int(a.shape[-2])
    if num_paths == 0:
        raise ValueError("No ray-traced path reaches the receiver — "
                         "there is no channel to sweep")

    progress(0.02, "Configuring PUSCH chain")
    pc = PUSCHConfig()
    pc.carrier.n_size_grid = int(num_prb)
    pc.carrier.subcarrier_spacing = int(round(float(cir["subcarrier_spacing"]) / 1e3))
    pc.tb.mcs_index = int(mcs_index)
    tx_blk = PUSCHTransmitter(pc, device="cpu")
    rx_blk = PUSCHReceiver(tx_blk, return_tb_crc_status=True, device="cpu")
    apply_ch = ApplyOFDMChannel(device="cpu")

    num_sc = 12 * pc.carrier.n_size_grid
    num_sym = pc.carrier.num_symbols_per_slot
    freqs = subcarrier_frequencies(num_sc, pc.carrier.subcarrier_spacing * 1e3)

    # Reciprocal uplink: RT a is [num_rx=1, num_rx_ant, num_tx=1, num_tx_ant,
    # paths, time] for the downlink. Swapping device/array axes makes the UE
    # array the transmitter and the base-station array the receiver. PUSCH is
    # configured for one stream, so apply a unit-norm uniform UE precoder while
    # retaining the physical array response in the effective channel.
    num_ue_array_ports = int(a.shape[1])
    a_ul_ports = np.transpose(a, (2, 3, 0, 1, 4, 5))[None, ...]
    a_ul = a_ul_ports.sum(axis=4, keepdims=True) / np.sqrt(num_ue_array_ports)
    tau_ul = np.transpose(tau.reshape(1, 1, num_paths), (1, 0, 2))[None, ...]
    a_t = torch.as_tensor(a_ul, dtype=torch.complex64)
    tau_t = torch.as_tensor(tau_ul, dtype=torch.float32)

    # Unit-mean-energy CFR: the sweep measures the channel's selectivity, not
    # its absolute path loss (which the Tier-1 link budget already reports).
    h = cir_to_ofdm_channel(freqs, a_t, tau_t, normalize=True)
    if h.shape[-2] == 1:  # static link: tile the single time step over the slot
        h = h.expand(*h.shape[:-2], num_sym, h.shape[-1])

    bits_per_symbol = int(torch.as_tensor(pc.tb.num_bits_per_symbol).reshape(-1)[0])
    coderate = float(torch.as_tensor(pc.tb.target_coderate).reshape(-1)[0])

    points: list[dict] = []
    total = len(snr_points_db)
    for k, ebno_db in enumerate(snr_points_db):
        progress(0.05 + 0.95 * k / total, f"Eb/N0 {ebno_db:g} dB ({k + 1}/{total})")
        no = torch.as_tensor(ebnodb2no(float(ebno_db), bits_per_symbol, coderate))
        x, b = tx_blk(int(slots_per_point))
        hb = h.expand(int(slots_per_point), *h.shape[1:])
        y = apply_ch(x, hb, no)
        b_hat, crc = rx_blk(y, no)
        bit_errors = int((b != b_hat).sum())
        bits = int(b.numel())
        blocks = int(crc.numel())
        block_errors = int((~crc.bool()).sum())
        points.append({
            "ebNoDb": float(ebno_db),
            "ber": bit_errors / bits,
            "bler": block_errors / blocks,
            "bitErrors": bit_errors, "bits": bits,
            "blockErrors": block_errors, "blocks": blocks,
        })

    progress(1.0, "Done")
    return {
        "points": points,
        "mcsIndex": int(mcs_index),
        "modulationOrder": bits_per_symbol,
        "targetCoderate": coderate,
        "numPrb": int(num_prb),
        "numSubcarriers": num_sc,
        "subcarrierSpacingHz": pc.carrier.subcarrier_spacing * 1e3,
        "numRxAnt": int(a_ul.shape[2]),   # base-station elements (uplink Rx)
        "numTxAnt": 1,                    # one effective PUSCH stream
        "numUeArrayPorts": num_ue_array_ports,
        "numPaths": num_paths,
        "slotsPerPoint": int(slots_per_point),
        "transportBlockBits": int(torch.as_tensor(pc.tb_size).reshape(-1)[0]),
        "seed": int(seed),
    }
