"""Continuity check — grade/exposure matching across a cut."""

from __future__ import annotations

import numpy as np

from circletake_gate import thresholds as T
from circletake_gate.checks import continuity


# ---------------------------------------------------------------------------
# Pure statistics
# ---------------------------------------------------------------------------


def test_band_for_delta_e():
    assert continuity.band_for_delta_e(0.4) == "invisible"
    assert continuity.band_for_delta_e(1.5) == "subtle"
    assert continuity.band_for_delta_e(3.0) == "warn"
    assert continuity.band_for_delta_e(7.0) == "fail"


def test_z_scores_use_within_take_variance():
    a = {"L": 50.0, "a": 0.0, "b": 0.0}
    b = {"L": 54.0, "a": 0.0, "b": 0.0}
    # A take that is itself stable -> a 4 L* step is huge.
    stable = continuity.z_scores(a, b, {"L": 0.5, "a": 0.5, "b": 0.5})
    assert stable["L"] == 8.0
    # A take that already swings 4 L* -> the same step is unremarkable.
    swingy = continuity.z_scores(a, b, {"L": 4.0, "a": 0.5, "b": 0.5})
    assert swingy["L"] == 1.0


def test_z_scores_have_a_noise_floor():
    a = {"L": 50.0, "a": 0.0, "b": 0.0}
    b = {"L": 51.0, "a": 0.0, "b": 0.0}
    z = continuity.z_scores(a, b, {"L": 0.0, "a": 0.0, "b": 0.0})
    assert np.isfinite(z["L"])  # must not divide by zero


def test_verdict_requires_significance_not_just_delta_e():
    z_big = {"L": 9.0, "a": 0.0, "b": 0.0}
    z_small = {"L": 0.4, "a": 0.0, "b": 0.0}
    # Content-confounded: a large delta that the take's own variance explains.
    assert continuity.verdict_for(7.0, z_small, 0.0) == "flag"
    assert continuity.verdict_for(7.0, z_big, 0.0) == "fail"
    assert continuity.verdict_for(3.0, z_small, 0.0) == "pass"
    assert continuity.verdict_for(3.0, z_big, 0.0) == "flag"
    assert continuity.verdict_for(0.5, z_big, 0.0) == "pass"


def test_verdict_flags_on_clipping_change():
    z = {"L": 0.1, "a": 0.0, "b": 0.0}
    assert continuity.verdict_for(0.2, z, 0.20) == "flag"


def test_lab_stats_and_delta_e_on_known_step():
    grey = np.full((16, 16, 3), 120, dtype=np.uint8)
    brighter = np.full((16, 16, 3), 170, dtype=np.uint8)
    s1 = continuity.lab_stats([grey] * 4)
    s2 = continuity.lab_stats([brighter] * 4)
    assert s2["L"] > s1["L"]
    de = continuity.delta_e00(s1, s2)
    assert de > T.DELTA_E_WARN  # a 50-code exposure step is a real mismatch


def test_lab_stats_empty():
    assert continuity.lab_stats([]) == {}


# ---------------------------------------------------------------------------
# End-to-end
# ---------------------------------------------------------------------------


def test_no_neighbors_skips(clips):
    r = continuity.run(clips["clean"], [])
    assert r["verdict"] == "skip"
    assert "no neighbouring shots" in r["reason"]


def test_exposure_step_between_shots_is_flagged(clips):
    r = continuity.run(
        clips["exposure_b"],
        [{"shotName": "12", "mediaPath": clips["exposure_a"], "position": "prev"}],
    )
    assert r["verdict"] in ("flag", "fail"), r["reason"]
    assert "grade mismatch" in r["reason"]
    assert "L*" in r["reason"]
    assert r["details"]["comparisons"][0]["deltaE00"] > T.DELTA_E_SUBTLE


def test_matching_shots_pass(clips):
    r = continuity.run(
        clips["exposure_a"],
        [{"shotName": "11", "mediaPath": clips["exposure_a"], "position": "prev"}],
    )
    assert r["verdict"] == "pass", r["reason"]
    assert r["details"]["comparisons"][0]["deltaE00"] < T.DELTA_E_INVISIBLE


def test_missing_neighbor_media_skips(clips, tmp_path):
    r = continuity.run(
        clips["clean"],
        [{"shotName": "9", "mediaPath": str(tmp_path / "gone.mp4"), "position": "prev"}],
    )
    assert r["verdict"] == "skip"


def test_neighbor_without_position_is_ignored(clips):
    r = continuity.run(clips["clean"], [{"shotName": "9", "mediaPath": clips["clean"]}])
    assert r["verdict"] == "skip"


def test_next_neighbor_compares_this_takes_tail(clips):
    r = continuity.run(
        clips["exposure_a"],
        [{"shotName": "13", "mediaPath": clips["exposure_b"], "position": "next"}],
    )
    assert r["verdict"] in ("flag", "fail"), r["reason"]
    assert r["details"]["comparisons"][0]["position"] == "next"
