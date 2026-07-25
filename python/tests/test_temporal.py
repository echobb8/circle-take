"""Temporal check — the synthetic-defect eval required by SPEC."""

from __future__ import annotations

import numpy as np
import pytest

from circletake_gate import thresholds as T
from circletake_gate.checks import temporal


# ---------------------------------------------------------------------------
# Pure signal math
# ---------------------------------------------------------------------------


def test_highpass_kills_ramps_keeps_spikes():
    ramp = np.linspace(10.0, 20.0, 40)
    hp = temporal.highpass_2nd_diff(ramp)
    assert np.abs(hp[1:-1]).max() < 1e-9

    spiky = ramp.copy()
    spiky[20] += 5.0
    hp2 = temporal.highpass_2nd_diff(spiky)
    assert abs(hp2[20]) > 4.0


def test_highpass_length_and_padding():
    hp = temporal.highpass_2nd_diff(np.arange(10.0))
    assert hp.shape == (10,)
    assert hp[0] == 0.0 and hp[-1] == 0.0
    assert temporal.highpass_2nd_diff(np.array([1.0, 2.0])).shape == (2,)


def test_mad_threshold_robust_to_outliers():
    v = np.zeros(100)
    v[3] = 50.0
    thr = temporal.mad_threshold(v)
    assert thr < 50.0  # the outlier itself must exceed the threshold
    assert np.isfinite(thr)


def test_mad_threshold_degenerate_series():
    assert temporal.mad_threshold(np.zeros(10)) == np.inf
    assert temporal.mad_threshold(np.array([])) == np.inf


def test_periodicity_par_separates_periodic_from_ramp():
    n, fps = 96, 24.0
    t = np.arange(n) / fps
    periodic = 100.0 + 8.0 * np.sin(2 * np.pi * 6.0 * t)
    par_p, hz_p = temporal.periodicity_par(periodic, fps)
    assert par_p > T.FLICKER_PAR_MIN
    assert 4.0 < hz_p < 8.0

    ramp = np.linspace(100.0, 140.0, n)
    par_r, _ = temporal.periodicity_par(ramp, fps)
    assert par_r < par_p


def test_periodicity_par_short_series_is_safe():
    assert temporal.periodicity_par(np.array([1.0, 2.0]), 24.0) == (0.0, 0.0)
    assert temporal.periodicity_par(np.zeros(20), 0.0) == (0.0, 0.0)


def test_contiguous_runs():
    m = np.array([0, 1, 1, 0, 0, 1, 0], dtype=bool)
    assert temporal.contiguous_runs(m) == [(1, 2), (5, 5)]
    assert temporal.contiguous_runs(np.array([1, 1], dtype=bool)) == [(0, 1)]
    assert temporal.contiguous_runs(np.zeros(4, dtype=bool)) == []


def test_dynamic_degree_resolution_normalized():
    # thres = 6.0 * 240 / 256 = 5.625
    moving, thres, n = temporal.dynamic_degree(np.full(16, 9.0), 240)
    assert moving and n == 16
    assert thres == pytest.approx(5.625)

    still, _, n2 = temporal.dynamic_degree(np.full(16, 0.1), 240)
    assert not still and n2 == 0


def test_dynamic_degree_needs_quarter_of_pairs():
    mags = np.zeros(16)
    mags[:3] = 100.0  # 3 of 16 < round(4*16/16)=4
    assert not temporal.dynamic_degree(mags, 256)[0]
    mags[3] = 100.0
    assert temporal.dynamic_degree(mags, 256)[0]


def test_static_flicker_score_bands():
    assert temporal.static_flicker_score(np.array([])) == 1.0
    # 2/255 MAE -> ~0.992, a pass
    assert temporal.static_flicker_score(np.full(5, 2.0)) > T.STATIC_MAE_PASS
    # 6/255 -> ~0.976, a fail
    assert temporal.static_flicker_score(np.full(5, 6.0)) < T.STATIC_MAE_WARN


def test_fb_consistency_mask_perfect_zero_flow():
    zero = np.zeros((32, 32, 2), dtype=np.float32)
    mask, frac = temporal.fb_consistency_mask(zero, zero)
    assert frac == 1.0
    assert mask.all()


def test_fb_consistency_mask_rejects_inconsistent_flow():
    fwd = np.full((32, 32, 2), 5.0, dtype=np.float32)
    # A backward flow that does NOT undo the forward flow is inconsistent.
    bwd = np.full((32, 32, 2), 5.0, dtype=np.float32)
    _mask, frac = temporal.fb_consistency_mask(fwd, bwd)
    assert frac < 0.5


def test_warp_error_zero_on_identical_frames():
    g = np.random.default_rng(0).integers(0, 255, (64, 64)).astype(np.float32)
    zero = np.zeros((64, 64, 2), dtype=np.float32)
    mask = np.ones((64, 64), dtype=bool)
    assert temporal.warp_error(g, g, zero, mask) < T.WARP_NOISE_FLOOR


# ---------------------------------------------------------------------------
# End-to-end on synthetic clips
# ---------------------------------------------------------------------------


def test_clean_pan_passes(clips):
    r = temporal.run(clips["clean"])
    assert r["verdict"] == "pass", r["reason"]
    assert r["score"] >= T.PASS_FLOOR
    assert r["details"]["workingWidth"] == T.TEMPORAL_WORKING_WIDTH
    assert r["details"]["ratioMedian"] < T.RATIO_MORPH_MIN
    assert r["series"] and all("t" in p and "v" in p for p in r["series"])
    assert r["threshold"] == T.RATIO_MORPH_MIN


def test_flicker_is_detected(clips):
    r = temporal.run(clips["flicker"])
    assert r["verdict"] in ("flag", "fail"), r["reason"]
    d = r["details"]
    assert d["flickerEvents"], "injected 6 Hz flicker was not detected"
    assert d["flickerPeriodic"], f"PAR test failed to confirm periodicity (PAR={d['flickerPar']})"
    assert 4.0 < d["flickerPeakHz"] < 8.0
    assert "flicker" in r["reason"].lower()


def test_morph_is_caught(clips):
    r = temporal.run(clips["morph"])
    assert r["verdict"] == "fail", r["reason"]
    d = r["details"]
    assert d["morphEvents"], r["reason"]
    # ratio > 1.0 = motion compensation made things worse; only unrelated
    # content can do that.
    assert max(m["ratio"] for m in d["morphEvents"]) >= T.RATIO_MORPH_CONFIRM
    assert r["score"] <= T.OVERALL_FAIL_CAP
    assert r["evidence_frames"]
    assert any("morph" in e["caption"] for e in r["evidence_frames"])


def test_sustained_churn_fails(clips):
    r = temporal.run(clips["churn"])
    assert r["verdict"] == "fail", r["reason"]
    sustained = [c for c in r["details"]["churnWindows"] if c["sustained"]]
    assert sustained, "1s of elastic churn was not detected as a sustained window"
    assert sustained[0]["durationSec"] > T.CHURN_SUSTAIN_SEC
    assert "churn" in r["reason"]


def test_hysteresis_merges_oscillating_runs():
    # A plateau oscillating across 0.6 must be ONE run, not many fragments.
    v = np.array([0.02, 0.02, 0.52, 0.61, 0.57, 0.61, 0.56, 0.62, 0.49, 0.03, 0.02])
    single = temporal.contiguous_runs(v >= T.RATIO_MORPH_MIN)
    assert len(single) > 1  # the naive single-threshold failure mode
    runs = temporal.hysteresis_runs(v, T.RATIO_MORPH_MIN, T.RATIO_CHURN_SUSTAIN)
    assert runs == [(2, 8)]


def test_hysteresis_needs_an_entering_sample():
    # Never crosses the enter threshold -> not a run at all.
    v = np.array([0.5, 0.5, 0.5])
    assert temporal.hysteresis_runs(v, T.RATIO_MORPH_MIN, T.RATIO_CHURN_SUSTAIN) == []


def test_hysteresis_respects_gate():
    v = np.array([0.9, 0.9, 0.9])
    gate = np.array([False, False, False])
    assert temporal.hysteresis_runs(v, T.RATIO_MORPH_MIN, T.RATIO_CHURN_SUSTAIN, gate) == []


def test_slow_pan_is_not_reported_as_static_output(clips):
    # The dynamic-degree threshold demands ~8px of motion at 480px; a slow pan
    # moves less, and must NOT be called a frozen generation.
    d = temporal.run(clips["clean"])["details"]
    assert d["staticOutput"] is False
    assert "static output" not in temporal.run(clips["clean"])["reason"]


def test_invisible_luma_outlier_is_not_flicker(clips):
    # A sub-code-value outlier is invisible and must not be a flicker event.
    d = temporal.run(clips["frozen"])["details"]
    for ev in d["flickerEvents"]:
        assert ev["amplitude"] >= T.FLICKER_EVENT_MIN_LUMA


def test_reasons_carry_numbers_and_timestamps(clips):
    for key in ("clean", "flicker", "morph"):
        reason = temporal.run(clips[key])["reason"]
        assert reason and reason[0].isalpha()
        assert any(ch.isdigit() for ch in reason), f"{key}: reason has no numbers"


def test_short_clip_skips_not_crashes(tmp_path):
    import fixtures as fx

    p = fx.short_clip(str(tmp_path / "tiny.mp4"), frames=2)
    r = temporal.run(p)
    assert r["verdict"] in ("skip", "pass")


def test_valid_fraction_recorded(clips):
    d = temporal.run(clips["clean"])["details"]
    assert 0.0 <= d["validFractionMedian"] <= 1.0
    assert "untrustworthyPairs" in d
