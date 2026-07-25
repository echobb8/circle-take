"""Threshold sanity — the constants must be internally consistent and documented.

AGENTS.md #7: every gate constant lives here with a name and a docstring. These
tests enforce the ordering relationships the check code relies on, so a future
retune cannot silently invert a band.
"""

from __future__ import annotations

import math

from circletake_gate import thresholds as T


def test_warp_bands_are_ordered_above_the_noise_floor():
    assert T.WARP_NOISE_FLOOR < T.WARP_GREEN_MAX < T.WARP_AMBER_MAX
    assert T.FROZEN_DIFF_THRESHOLD == T.WARP_NOISE_FLOOR


def test_ratio_bands_are_ordered():
    assert 0 < T.RATIO_JUMP_MAX < T.RATIO_CHURN_SUSTAIN < T.RATIO_MORPH_MIN < T.RATIO_MORPH_CONFIRM
    # The pan baseline measured in RESEARCH-tech.md (0.206) must not be churn.
    assert 0.206 < T.RATIO_CHURN_SUSTAIN
    # The measured flicker/churn value (0.917) must be churn.
    assert 0.917 > T.RATIO_MORPH_MIN


def test_identity_bands_are_ordered():
    assert 0 < T.IDENTITY_HARD_FAIL < T.IDENTITY_WARN < T.IDENTITY_PASS < 1.0
    # RESEARCH-tech.md: OpenCV's 0.363 default is the hard floor, not the gate.
    assert T.IDENTITY_HARD_FAIL == 0.363
    # Measured same-identity floor under abuse was 0.755.
    assert T.IDENTITY_PASS <= 0.755


def test_identity_fractions_are_probabilities():
    for v in (
        T.IDENTITY_HEAD_TAIL_SKIP,
        T.IDENTITY_MULTIFACE_FRAME_FRACTION,
        T.IDENTITY_CLUSTER_COSINE_CUT,
        T.IDENTITY_MIN_SCOREABLE_FRACTION,
        T.IDENTITY_DRIFT_DELTA,
    ):
        assert 0.0 < v < 1.0


def test_delta_e_bands_are_ordered():
    assert 0 < T.DELTA_E_INVISIBLE < T.DELTA_E_SUBTLE < T.DELTA_E_WARN


def test_duration_tolerances_are_ordered():
    assert 0 < T.DURATION_FLAG_TOLERANCE < T.DURATION_FAIL_TOLERANCE < 1.0


def test_anatomy_bands_are_ordered():
    assert T.HAND_DROPOUT_FLAG < T.HAND_DROPOUT_FAIL < T.HAND_DROPOUT_EGREGIOUS
    assert T.BONE_LOG_RATIO_WARN < T.BONE_LOG_RATIO_FAIL < T.BONE_LOG_RATIO_MAX_WARN
    assert T.BONE_LENGTH_CV_FLAG < T.BONE_LENGTH_CV_FAIL
    assert T.JITTER_ACCEL_SUSPICIOUS < T.JITTER_ACCEL_STRONG
    assert T.PLANARITY_WARN < T.PLANARITY_FAIL
    assert T.HANDEDNESS_SCORE_FAIL < T.HANDEDNESS_SCORE_WARN < 1.0
    assert T.HANDEDNESS_FLIP_FLAG < T.HANDEDNESS_FLIP_FAIL


def test_bone_template_matches_the_edge_list():
    assert len(T.BONE_EDGES) == len(T.BONE_TEMPLATE) == 23
    # Every edge references a valid landmark index of the 21-point hand.
    assert all(0 <= a < 21 and 0 <= b < 21 for a, b in T.BONE_EDGES)
    # The palm bone (0,9) is the normalizer, so its canonical length is 1.0.
    assert T.BONE_TEMPLATE[T.BONE_EDGES.index((0, 9))] == 1.0
    assert all(v > 0 for v in T.BONE_TEMPLATE)


def test_joint_rom_ranges_are_valid():
    for name, (lo, hi) in T.JOINT_ROM_DEG.items():
        assert lo < hi, name
    # RAS §8 hard gates, +10 deg tolerance already applied.
    assert T.JOINT_ROM_DEG["pip_flex"] == (0.0, 120.0)


def test_static_mae_bands_are_ordered():
    assert 0 < T.STATIC_MAE_WARN < T.STATIC_MAE_PASS < 1.0


def test_flicker_settings_are_sane():
    assert T.FLICKER_HIGHPASS_KERNEL == (-0.5, 1.0, -0.5)
    assert sum(T.FLICKER_HIGHPASS_KERNEL) == 0.0  # a true high-pass has zero DC
    assert T.MAD_TO_SIGMA == 1.4826
    assert T.FLICKER_FREQ_MIN_HZ <= T.FLICKER_PEAK_BAND_HZ[0] < T.FLICKER_PEAK_BAND_HZ[1]


def test_sharpness_bands_are_ordered():
    assert T.SHARPNESS_NORMALIZED_SOFT < T.SHARPNESS_NORMALIZED_OK < T.SHARPNESS_NORMALIZED_SHARP
    assert 0 < T.SHARPNESS_COLLAPSE_RATIO < 1


def test_noise_and_blockiness_bands_are_ordered():
    assert T.NOISE_CLEAN < T.NOISE_GRAIN < T.NOISE_WARN
    assert T.BLOCKINESS_CLEAN < T.BLOCKINESS_WARN < T.BLOCKINESS_FAIL


def test_scoring_constants_mirror_the_typescript_contract():
    # These MUST equal OVERALL_FAIL_CAP / PASS_FLOOR in src/shared/types.ts.
    assert T.OVERALL_FAIL_CAP == 40
    assert T.PASS_FLOOR == 85


def test_working_resolution_constants():
    assert T.TEMPORAL_WORKING_WIDTH == 480  # RTS §2 fixed working width
    assert T.COLOR_STAT_SIZE == 128
    assert T.SHARPNESS_ANALYSIS_LONG_EDGE == 1024
    assert T.METRIC_MAX_HEIGHT == 720


def test_evidence_counts():
    assert 0 < T.MIN_EVIDENCE_FRAMES <= T.MAX_EVIDENCE_FRAMES <= 4


def test_every_public_constant_is_documented():
    """Every exported constant must carry a docstring citing its research."""
    import ast
    import inspect

    src = inspect.getsource(T)
    tree = ast.parse(src)
    documented: set[str] = set()
    body = tree.body
    for i, node in enumerate(body):
        target = None
        if isinstance(node, ast.Assign) and isinstance(node.targets[0], ast.Name):
            target = node.targets[0].id
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            target = node.target.id
        if target is None or target.startswith("_"):
            continue
        # Either a following string expression (docstring style) or a preceding
        # #: comment block counts as documentation.
        nxt = body[i + 1] if i + 1 < len(body) else None
        has_doc = isinstance(nxt, ast.Expr) and isinstance(nxt.value, ast.Constant) and isinstance(
            nxt.value.value, str
        )
        if has_doc:
            documented.add(target)

    comment_documented = {"BONE_EDGES", "BONE_TEMPLATE", "JOINT_ROM_DEG",
                          "POSTER_WIDTH", "STRIP_WIDTH", "STRIP_COUNT",
                          "EVIDENCE_WIDTH", "EVIDENCE_JPEG_QUALITY"}
    public = {
        n for n in dir(T)
        if not n.startswith("_") and not inspect.ismodule(getattr(T, n))
        and isinstance(getattr(T, n), (int, float, str, tuple, dict, bool))
    }
    undocumented = public - documented - comment_documented
    assert not undocumented, f"undocumented thresholds: {sorted(undocumented)}"
