"""3GPP A3-event handover over a mobility run's per-Tx RSS series.

The mobility solver reports, at every waypoint, each transmitter's received
power. The instantaneous best-server association (``servingTxId``) switches the
moment any neighbor edges ahead, which over-counts handovers. This module adds
the standard A3 event model on top of that series:

    neighbor RSS > serving RSS + hysteresis, held continuously for the
    time-to-trigger (TTT), triggers a handover to that neighbor.

Time between waypoints comes from the trajectory geometry and the receiver
speed, so TTT is honored in seconds, not samples. Pure Python/NumPy — it
post-processes solver output and never touches the GPU.
"""
from __future__ import annotations

import math

# The API's finite no-path sentinel (see solver._empty_metrics).
NO_PATH_DBM = -200.0


def step_durations(rx_positions: list[list[float]], speed_ms: float) -> list[float]:
    """Seconds elapsed arriving at each waypoint (index 0 -> 0.0)."""
    if speed_ms <= 0:
        return [0.0] * len(rx_positions)
    out = [0.0]
    for i in range(1, len(rx_positions)):
        out.append(math.dist(rx_positions[i - 1], rx_positions[i]) / speed_ms)
    return out


def a3_association(
    rss_dbm: list[list[float]],
    dt_s: list[float],
    hysteresis_db: float = 3.0,
    ttt_s: float = 0.16,
    ping_pong_window_s: float = 1.0,
) -> dict:
    """Run the A3 state machine over ``rss_dbm[step][tx]``.

    ``dt_s[i]`` is the time spent traveling into step ``i`` (0 for the first).
    Returns per-step serving indices (-1 = nothing reachable), handover events,
    and the instantaneous (hysteresis-free) switch count as the baseline.
    """
    num_steps = len(rss_dbm)
    if num_steps == 0:
        return {"servingIdx": [], "events": [], "instantaneousChanges": 0}
    num_tx = len(rss_dbm[0])

    def best(step: int) -> int:
        idx = max(range(num_tx), key=lambda t: rss_dbm[step][t])
        return idx if rss_dbm[step][idx] > NO_PATH_DBM else -1

    # Baseline: how often the instantaneous argmax flips (what the UI's
    # serving-cell readout does today).
    inst = [best(i) for i in range(num_steps)]
    instantaneous_changes = sum(
        1 for a, b in zip(inst, inst[1:]) if b != a and b != -1 and a != -1
    )

    serving = inst[0]
    timers = [0.0] * num_tx      # per-neighbor A3 dwell time
    serving_series: list[int] = []
    events: list[dict] = []
    now = 0.0
    last_ho_time: float | None = None
    last_ho_from = -1

    for i in range(num_steps):
        now += dt_s[i]
        if serving == -1:  # nothing reachable yet — latch on as soon as possible
            serving = best(i)
            timers = [0.0] * num_tx
            serving_series.append(serving)
            continue

        row = rss_dbm[i]
        qualified = [False] * num_tx  # A3 condition holds at THIS step
        for t in range(num_tx):
            if t == serving:
                timers[t] = 0.0
            elif row[t] > row[serving] + hysteresis_db and row[t] > NO_PATH_DBM:
                qualified[t] = True
                timers[t] += dt_s[i]
            else:
                timers[t] = 0.0

        # Hand over to the strongest neighbor whose condition still holds and
        # whose TTT has expired (with TTT=0 this is the bare hysteresis test).
        ready = [t for t in range(num_tx) if qualified[t] and timers[t] >= ttt_s]
        if ready:
            target = max(ready, key=lambda t: row[t])
            ping_pong = (
                target == last_ho_from
                and last_ho_time is not None
                and (now - last_ho_time) <= ping_pong_window_s
            )
            events.append({
                "stepIndex": i,
                "timeS": now,
                "fromIdx": serving,
                "toIdx": target,
                "pingPong": bool(ping_pong),
            })
            last_ho_time = now
            last_ho_from = serving
            serving = target
            timers = [0.0] * num_tx
        serving_series.append(serving)

    return {
        "servingIdx": serving_series,
        "events": events,
        "instantaneousChanges": instantaneous_changes,
    }
