"""Anatomy check — pure geometry on synthetic landmark arrays.

No MediaPipe inference, no model downloads. These tests build hands by hand from
the canonical bone template so every metric has a known ground truth.
"""

from __future__ import annotations

import math

import numpy as np
import pytest

from circletake_gate import thresholds as T
from circletake_gate.checks import anatomy


def canonical_hand() -> np.ndarray:
    """A synthetic 21x3 world-landmark hand matching the canonical template.

    Built as a flat hand in the z=0 plane: wrist at the origin, the four fingers
    laid out as straight chains whose segment lengths come from BONE_TEMPLATE.
    """
    pts = np.zeros((21, 3), dtype=np.float64)
    tmpl = dict(zip(T.BONE_EDGES, T.BONE_TEMPLATE))

    # Palm: wrist -> each MCP, spread along x, extending in y.
    mcp_x = {5: -0.30, 9: -0.02, 13: 0.26, 17: 0.52}
    for mcp, x in mcp_x.items():
        length = tmpl[(0, mcp)]
        y = math.sqrt(max(1e-9, length**2 - x**2))
        pts[mcp] = [x, y, 0.0]

    # Fingers: straight chains continuing in +y.
    for mcp, pip, dip, tip in anatomy.FINGER_CHAINS:
        cur = pts[mcp].copy()
        for a, b in ((mcp, pip), (pip, dip), (dip, tip)):
            cur = cur + np.array([0.0, tmpl[(a, b)], 0.0])
            pts[b] = cur

    # Thumb: a chain angled away from the palm.
    cur = pts[0].copy()
    direction = np.array([-0.75, 0.66, 0.0])
    direction = direction / np.linalg.norm(direction)
    for a, b in ((0, 1), (1, 2), (2, 3), (3, 4)):
        cur = cur + direction * tmpl[(a, b)]
        pts[b] = cur
    return pts


# ---------------------------------------------------------------------------
# Palm scale / bone lengths
# ---------------------------------------------------------------------------


def test_palm_scale_is_wrist_to_middle_mcp():
    h = canonical_hand()
    assert anatomy.palm_scale(h) == pytest.approx(np.linalg.norm(h[9] - h[0]))
    assert anatomy.palm_scale(h) == pytest.approx(1.0, abs=0.02)


def test_palm_scale_degenerate_is_zero():
    assert anatomy.palm_scale(np.zeros((21, 3))) == 0.0


def test_bone_lengths_has_one_entry_per_template_bone():
    assert anatomy.bone_lengths(canonical_hand()).shape == (len(T.BONE_TEMPLATE),)
    assert len(T.BONE_EDGES) == len(T.BONE_TEMPLATE) == 23


def test_canonical_hand_has_near_zero_log_ratio_error():
    mean, mx = anatomy.bone_log_ratio(canonical_hand())
    assert mean < T.BONE_LOG_RATIO_WARN
    assert mx < T.BONE_LOG_RATIO_MAX_WARN


def test_scaling_a_hand_does_not_change_its_log_ratio():
    # The metric is palm-normalized, so a hand twice as far away scores the same.
    h = canonical_hand()
    assert anatomy.bone_log_ratio(h * 2.5)[0] == pytest.approx(
        anatomy.bone_log_ratio(h)[0], abs=1e-9
    )


def test_deformed_bones_raise_the_log_ratio():
    h = canonical_hand()
    h[8] = h[7] + (h[8] - h[7]) * 3.0  # index fingertip bone 3x too long
    mean, mx = anatomy.bone_log_ratio(h)
    assert mean > anatomy.bone_log_ratio(canonical_hand())[0]
    assert mx > T.BONE_LOG_RATIO_MAX_WARN


def test_bone_log_ratio_degenerate_hand_is_infinite():
    assert anatomy.bone_log_ratio(np.zeros((21, 3))) == (math.inf, math.inf)


def test_bone_length_cv_zero_for_rigid_hand():
    seq = [canonical_hand() for _ in range(10)]
    assert anatomy.bone_length_cv(seq) == pytest.approx(0.0, abs=1e-9)


def test_bone_length_cv_detects_changing_bones():
    rng = np.random.default_rng(0)
    seq = []
    for _ in range(10):
        h = canonical_hand()
        h[1:] += rng.normal(0, 0.15, (20, 3))  # bones change every frame
        seq.append(h)
    assert anatomy.bone_length_cv(seq) > T.BONE_LENGTH_CV_FLAG


def test_bone_length_cv_needs_two_frames():
    assert anatomy.bone_length_cv([canonical_hand()]) == 0.0


# ---------------------------------------------------------------------------
# Planarity
# ---------------------------------------------------------------------------


def test_flat_fingers_are_planar():
    pl = anatomy.finger_planarity(canonical_hand())
    assert len(pl) == 4
    assert max(pl) < T.PLANARITY_WARN


def test_curled_finger_is_still_planar():
    # The real-world case: a bent finger stays in ONE plane, so bending must not
    # be mistaken for a deformity.
    h = canonical_hand()
    mcp, pip, dip, tip = anatomy.FINGER_CHAINS[0]
    origin = h[pip].copy()
    for idx, angle in ((dip, math.radians(60)), (tip, math.radians(110))):
        v = h[idx] - origin
        y, z = v[1], v[2]
        h[idx] = origin + np.array(
            [v[0], y * math.cos(angle) - z * math.sin(angle), y * math.sin(angle) + z * math.cos(angle)]
        )
    assert anatomy.finger_planarity(h)[0] < T.PLANARITY_WARN


def test_out_of_plane_finger_is_detected():
    # A single perturbation of a straight chain is still planar (3 collinear
    # points plus one off the line define a plane), so genuine non-planarity
    # needs two independent out-of-line displacements.
    h = canonical_hand()
    h[6, 2] += 0.25  # index PIP out in z
    h[7, 0] += 0.25  # index DIP out in x
    assert max(anatomy.finger_planarity(h)) > T.PLANARITY_WARN


# ---------------------------------------------------------------------------
# Joint ROM
# ---------------------------------------------------------------------------


def test_straight_hand_has_no_rom_violations():
    assert anatomy.rom_violations(canonical_hand()) == 0


def test_hyperextended_joint_is_counted():
    h = canonical_hand()
    # Fold the index fingertip back on itself: ~180 deg of flexion.
    h[8] = h[7] - (h[7] - h[6]) * 1.2
    assert anatomy.rom_violations(h) > 0


def test_joint_angles_returns_every_class():
    a = anatomy.joint_angles(canonical_hand())
    assert set(a) == {"mcp_flex", "pip_flex", "dip_flex", "mcp_abduction"}
    assert len(a["pip_flex"]) == 4


def test_dip_pip_coupling_is_not_used():
    # RAS §8: the DIP ~= 2/3 PIP heuristic is a measured false-positive
    # generator and must not appear in the metric set.
    assert "dip_pip_coupling" not in anatomy.joint_angles(canonical_hand())


# ---------------------------------------------------------------------------
# Acceleration (jitter)
# ---------------------------------------------------------------------------


def test_acceleration_zero_for_linear_motion():
    # Constant velocity has zero acceleration — a smooth pan must not flag.
    seq = [canonical_hand() + np.array([0.05 * i, 0.0, 0.0]) for i in range(6)]
    accel = anatomy.acceleration_series(seq)
    assert accel.size == 4
    assert np.max(accel) == pytest.approx(0.0, abs=1e-9)


def test_acceleration_detects_jitter():
    rng = np.random.default_rng(1)
    seq = [canonical_hand() + rng.normal(0, 0.05, (21, 3)) for _ in range(12)]
    accel = anatomy.acceleration_series(seq)
    assert float(np.median(accel)) > T.JITTER_ACCEL_SUSPICIOUS


def test_acceleration_needs_three_frames():
    assert anatomy.acceleration_series([canonical_hand()] * 2).size == 0


def test_acceleration_is_palm_scale_normalized():
    rng = np.random.default_rng(2)
    base = [canonical_hand() + rng.normal(0, 0.03, (21, 3)) for _ in range(8)]
    far = [h * 4.0 for h in base]
    assert float(np.median(anatomy.acceleration_series(base))) == pytest.approx(
        float(np.median(anatomy.acceleration_series(far))), rel=1e-6
    )


# ---------------------------------------------------------------------------
# Association
# ---------------------------------------------------------------------------


def test_association_matches_nearest_wrist():
    tracks = [{"wrist": (0.2, 0.5)}, {"wrist": (0.8, 0.5)}]
    # Detections arrive in the OPPOSITE order — MediaPipe does not keep ordering.
    dets = [{"wrist": (0.81, 0.51)}, {"wrist": (0.21, 0.49)}]
    assert anatomy.associate_by_wrist(tracks, dets) == [1, 0]


def test_association_rejects_far_detections():
    tracks = [{"wrist": (0.1, 0.1)}]
    dets = [{"wrist": (0.9, 0.9)}]
    assert anatomy.associate_by_wrist(tracks, dets) == [None]


def test_association_is_one_to_one():
    tracks = [{"wrist": (0.5, 0.5)}]
    dets = [{"wrist": (0.51, 0.5)}, {"wrist": (0.52, 0.5)}]
    out = anatomy.associate_by_wrist(tracks, dets)
    assert out.count(0) == 1 and out.count(None) == 1


def test_association_empty_inputs():
    assert anatomy.associate_by_wrist([], [{"wrist": (0.5, 0.5)}]) == [None]
    assert anatomy.associate_by_wrist([{"wrist": (0.5, 0.5)}], []) == []


# ---------------------------------------------------------------------------
# Degradation
# ---------------------------------------------------------------------------


def test_no_hands_in_frame_skips(clips):
    # The synthetic clips are face- and hand-free: the asserted behaviour is a
    # clean 'skip', never a fail. This runs without downloading anything only
    # when the model is already cached; otherwise it still must not raise.
    r = anatomy.run(clips["clean"], cache_dir="/nonexistent/circletake-test-cache")
    assert r["verdict"] == "skip"
    assert r["score"] == 100
    assert r["reason"]
