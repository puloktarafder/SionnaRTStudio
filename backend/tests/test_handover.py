"""Unit tests for the A3 hysteresis/TTT handover state machine (no GPU).

Run with:  .venv/bin/python -m unittest discover backend/tests
"""
import unittest

from backend.handover import NO_PATH_DBM, a3_association, step_durations


def _run(rss, dt=0.1, hyst=3.0, ttt=0.16, window=1.0):
    return a3_association(rss, [0.0] + [dt] * (len(rss) - 1),
                          hysteresis_db=hyst, ttt_s=ttt,
                          ping_pong_window_s=window)


class TestStepDurations(unittest.TestCase):
    def test_distance_over_speed(self):
        d = step_durations([[0, 0, 0], [10, 0, 0], [10, 5, 0]], speed_ms=5.0)
        self.assertEqual(d, [0.0, 2.0, 1.0])

    def test_zero_speed(self):
        self.assertEqual(step_durations([[0, 0, 0], [1, 0, 0]], 0.0), [0.0, 0.0])


class TestA3(unittest.TestCase):
    def test_clean_crossover_hands_over_once(self):
        # Tx0 fades, Tx1 rises; the margin exceeds 3 dB from step 3 on.
        # TTT 0.16 s at 0.1 s/step needs 2 consecutive qualifying steps.
        rss = [[-60, -80], [-64, -72], [-68, -66], [-72, -62], [-76, -58], [-80, -54]]
        r = _run(rss)
        self.assertEqual(len(r["events"]), 1)
        self.assertEqual(r["events"][0]["toIdx"], 1)
        self.assertEqual(r["events"][0]["stepIndex"], 4)  # 2nd step past the margin
        self.assertEqual(r["servingIdx"], [0, 0, 0, 0, 1, 1])

    def test_hysteresis_suppresses_flapping(self):
        # Neighbors trade a 1 dB lead every step: the instantaneous server flips
        # constantly but never clears a 3 dB hysteresis.
        rss = [[-60, -61], [-61, -60], [-60, -61], [-61, -60], [-60, -61]]
        r = _run(rss)
        self.assertEqual(len(r["events"]), 0)
        self.assertEqual(r["instantaneousChanges"], 4)
        self.assertEqual(r["servingIdx"], [0] * 5)

    def test_ttt_requires_sustained_margin(self):
        # The 10 dB spike lasts one 0.1 s step — shorter than TTT 0.16 s.
        rss = [[-60, -80], [-60, -50], [-60, -80], [-60, -80]]
        r = _run(rss)
        self.assertEqual(len(r["events"]), 0)

    def test_zero_ttt_hands_over_immediately(self):
        rss = [[-60, -80], [-60, -50], [-60, -80]]
        r = _run(rss, ttt=0.0)
        self.assertEqual(len(r["events"]), 2)          # over and straight back
        self.assertEqual(r["events"][0]["stepIndex"], 1)
        self.assertTrue(r["events"][1]["pingPong"])    # returned within 1 s

    def test_ping_pong_flagged_only_within_window(self):
        rss = [[-60, -80], [-60, -50], [-60, -80]]
        r = _run(rss, ttt=0.0, window=0.05)            # return takes 0.1 s > window
        self.assertEqual(len(r["events"]), 2)
        self.assertFalse(r["events"][1]["pingPong"])

    def test_unreachable_start_latches_when_coverage_appears(self):
        rss = [[NO_PATH_DBM, NO_PATH_DBM], [NO_PATH_DBM, -70], [-75, -70]]
        r = _run(rss)
        self.assertEqual(r["servingIdx"], [-1, 1, 1])  # latches to first coverage
        self.assertEqual(r["instantaneousChanges"], 0) # -1 transitions don't count

    def test_three_tx_hands_over_to_strongest_qualifier(self):
        # Both neighbors clear the margin; Tx2 is stronger at expiry.
        rss = [[-60, -80, -80], [-60, -50, -45], [-60, -50, -45]]
        r = _run(rss)
        self.assertEqual(len(r["events"]), 1)
        self.assertEqual(r["events"][0]["toIdx"], 2)

    def test_empty_series(self):
        r = a3_association([], [], 3.0, 0.16, 1.0)
        self.assertEqual(r["servingIdx"], [])
        self.assertEqual(r["events"], [])


if __name__ == "__main__":
    unittest.main()
