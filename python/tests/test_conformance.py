"""Conformance check + technical metrics."""

from __future__ import annotations

import numpy as np
import pytest

from circletake_gate import thresholds as T
from circletake_gate.checks import conformance
from circletake_gate.probe import probe


# ---------------------------------------------------------------------------
# Pure technical metrics
# ---------------------------------------------------------------------------


def test_resample_long_edge_fixes_scale():
    img = np.zeros((480, 640, 3), dtype=np.uint8)
    out = conformance.resample_long_edge(img, 1024)
    assert max(out.shape[:2]) == 1024
    assert out.shape[1] == 1024  # width was the long edge


def test_sharpness_separates_sharp_from_blurred():
    import cv2

    rng = np.random.default_rng(0)
    sharp = rng.integers(0, 255, (256, 256)).astype(np.float64)
    blurred = cv2.GaussianBlur(sharp, (21, 21), 0)
    assert conformance.normalized_sharpness(sharp) > conformance.normalized_sharpness(blurred)


def test_sharpness_safe_on_black_frame():
    assert conformance.normalized_sharpness(np.zeros((64, 64))) == 0.0


def test_immerkaer_noise_tracks_injected_noise():
    rng = np.random.default_rng(1)
    flat = np.full((128, 128), 128.0, dtype=np.float32)
    clean = conformance.immerkaer_noise(flat)
    noisy = conformance.immerkaer_noise(flat + rng.normal(0, 10, flat.shape).astype(np.float32))
    assert clean < T.NOISE_CLEAN
    assert noisy > clean * 5
    # The estimator should land near the true sigma.
    assert 5.0 < noisy < 20.0


def test_immerkaer_noise_safe_on_tiny_input():
    assert conformance.immerkaer_noise(np.zeros((2, 2))) == 0.0


def test_blockiness_detects_block_edges():
    smooth = np.tile(np.linspace(0, 255, 128, dtype=np.float32), (128, 1))
    blocky = smooth.copy()
    for x in range(7, 128, 8):
        blocky[:, x] += 40  # discontinuity exactly on the 8px boundary
    assert conformance.blockiness(blocky) > conformance.blockiness(smooth)


def test_is_frozen_pair_bit_identical():
    rng = np.random.default_rng(2)
    a = rng.integers(0, 255, (32, 32, 3)).astype(np.uint8)
    bit, soft = conformance.is_frozen_pair(a, a.copy())
    assert bit and soft

    # A dithered static shot is NOT a freeze.
    b = np.clip(a.astype(np.int16) + rng.integers(-6, 7, a.shape), 0, 255).astype(np.uint8)
    bit2, _ = conformance.is_frozen_pair(a, b)
    assert not bit2


def test_is_frozen_pair_shape_mismatch_is_safe():
    assert conformance.is_frozen_pair(np.zeros((4, 4)), np.zeros((5, 5))) == (False, False)


def test_within_tolerance():
    assert conformance.within_tolerance(24.0, 24.0, 0.02)
    assert conformance.within_tolerance(23.976, 24.0, 0.02)
    assert not conformance.within_tolerance(30.0, 24.0, 0.02)
    assert conformance.within_tolerance(5.0, 0.0, 0.02)  # no expectation = pass


def test_clipping_fractions():
    f = np.zeros((10, 10, 3), dtype=np.uint8)
    f[0, :, :] = 255
    hi, lo = conformance.clipping(f)
    assert hi == pytest.approx(0.1)
    assert lo == pytest.approx(0.9)


# ---------------------------------------------------------------------------
# End-to-end
# ---------------------------------------------------------------------------


def test_clean_clip_conforms(clips):
    info = probe(clips["clean"])
    r = conformance.run(clips["clean"], info, {"durationSec": 3.0, "fps": 24.0})
    assert r["verdict"] == "pass", r["reason"]
    assert r["score"] >= T.PASS_FLOOR


def test_frozen_tail_is_flagged(clips):
    info = probe(clips["frozen"])
    r = conformance.run(clips["frozen"], info, None)
    assert r["verdict"] == "flag", r["reason"]
    assert "frozen frames at tail" in r["reason"]
    assert r["details"]["tailIdenticalPairs"] >= 1


def test_duration_mismatch_flags_then_fails(clips):
    info = probe(clips["clean"])  # ~3s
    flagged = conformance.run(clips["clean"], info, {"durationSec": 3.6})  # 20% off
    assert flagged["verdict"] == "flag", flagged["reason"]
    assert "expected" in flagged["reason"]

    failed = conformance.run(clips["clean"], info, {"durationSec": 6.0})  # 50% off
    assert failed["verdict"] == "fail", failed["reason"]
    assert failed["score"] <= T.OVERALL_FAIL_CAP


def test_duration_within_tolerance_passes(clips):
    info = probe(clips["clean"])
    r = conformance.run(clips["clean"], info, {"durationSec": 3.1})
    assert r["verdict"] == "pass", r["reason"]


def test_aspect_mismatch_fails(clips):
    info = probe(clips["clean"])  # 320x240 = 4:3
    r = conformance.run(clips["clean"], info, {"width": 1920, "height": 1080})
    assert r["verdict"] == "fail", r["reason"]
    assert "framing" in r["reason"]


def test_resolution_below_expected_flags(clips):
    info = probe(clips["clean"])  # 320x240
    r = conformance.run(clips["clean"], info, {"width": 640, "height": 480})
    assert r["verdict"] == "flag", r["reason"]
    assert "below the expected" in r["reason"]


def test_fps_mismatch_flags(clips):
    info = probe(clips["clean"])
    r = conformance.run(clips["clean"], info, {"fps": 30.0})
    assert r["verdict"] == "flag", r["reason"]
    assert "fps" in r["reason"]


def test_missing_file_fails_cleanly(tmp_path):
    r = conformance.run(
        str(tmp_path / "nope.mp4"),
        {"durationSec": 0, "fps": 0, "width": 0, "height": 0, "codec": "none"},
        None,
    )
    assert r["verdict"] == "fail"
    assert "decode" in r["reason"]


def test_reason_is_a_sentence_with_numbers(clips):
    info = probe(clips["clean"])
    reason = conformance.run(clips["clean"], info, None)["reason"]
    assert any(ch.isdigit() for ch in reason)
