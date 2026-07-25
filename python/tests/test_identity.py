"""Identity check — pure math only. No model inference, no downloads.

Real-model behaviour is covered by the @pytest.mark.slow integration tests.
"""

from __future__ import annotations

import json

import numpy as np
import pytest

from circletake_gate import thresholds as T
from circletake_gate.checks import identity


def _unit(rng, dim=128):
    v = rng.normal(size=dim)
    return v / np.linalg.norm(v)


# ---------------------------------------------------------------------------
# Normalization / cosine
# ---------------------------------------------------------------------------


def test_l2_normalize_vector_and_matrix():
    v = np.array([3.0, 4.0])
    assert np.linalg.norm(identity.l2_normalize(v)) == pytest.approx(1.0)

    m = np.array([[3.0, 4.0], [0.0, 5.0]])
    out = identity.l2_normalize(m)
    assert np.allclose(np.linalg.norm(out, axis=1), 1.0)


def test_l2_normalize_zero_vector_is_safe():
    assert np.allclose(identity.l2_normalize(np.zeros(4)), 0.0)
    assert np.all(np.isfinite(identity.l2_normalize(np.zeros((2, 4)))))


def test_cosine_normalizes_unnormalized_input():
    # SFace features arrive UNNORMALIZED — cosine must handle that.
    a = np.array([1.0, 0.0, 0.0]) * 37.0
    b = np.array([1.0, 0.0, 0.0]) * 0.002
    assert identity.cosine(a, b) == pytest.approx(1.0)
    assert identity.cosine(np.array([1.0, 0.0]), np.array([0.0, 1.0])) == pytest.approx(0.0)


def test_spherical_mean_is_unit_and_central():
    rng = np.random.default_rng(0)
    base = _unit(rng)
    embs = np.array([base + 0.05 * _unit(rng) for _ in range(8)])
    ref = identity.spherical_mean(embs)
    assert np.linalg.norm(ref) == pytest.approx(1.0)
    assert identity.cosine(ref, base) > 0.95


def test_spherical_mean_single_vector():
    v = np.array([0.0, 3.0, 4.0])
    assert np.linalg.norm(identity.spherical_mean(v)) == pytest.approx(1.0)


# ---------------------------------------------------------------------------
# Gating statistics
# ---------------------------------------------------------------------------


def test_p10_gates_on_the_bad_tail_not_the_median():
    # 85% excellent, 15% a different person: the median hides it, p10 does not.
    # (At exactly 10% bad, linear interpolation puts p10 on the boundary itself,
    # so the bad tail must be a little larger than the percentile to be caught.)
    v = np.concatenate([np.full(85, 0.92), np.full(15, 0.20)])
    assert float(np.median(v)) > T.IDENTITY_PASS
    assert identity.p10(v) < T.IDENTITY_WARN


def test_p10_empty_is_zero():
    assert identity.p10(np.array([])) == 0.0


def test_worst_window_finds_the_sustained_dip():
    v = np.concatenate([np.full(20, 0.9), np.full(5, 0.3), np.full(20, 0.9)])
    assert identity.worst_window_mean(v, 5) == pytest.approx(0.3)


def test_worst_window_shorter_than_window():
    assert identity.worst_window_mean(np.array([0.5]), 5) == pytest.approx(0.5)


def test_detect_drift_only_reports_declines():
    falling = np.linspace(0.95, 0.60, 40)
    assert identity.detect_drift(falling) > T.IDENTITY_DRIFT_DELTA

    rising = np.linspace(0.60, 0.95, 40)
    assert identity.detect_drift(rising) < 0.05

    steady = np.full(40, 0.9)
    assert identity.detect_drift(steady) == pytest.approx(0.0)


def test_detect_drift_short_series_is_zero():
    assert identity.detect_drift(np.array([0.9, 0.2])) == 0.0


def test_rolling_median_smooths_single_outlier():
    v = np.array([0.9] * 10)
    v[5] = 0.1
    rm = identity.rolling_median(v, 5)
    assert rm.min() > 0.5


# ---------------------------------------------------------------------------
# Bands
# ---------------------------------------------------------------------------


def test_band_for_covers_every_boundary():
    assert identity.band_for(0.90) == "pass"
    assert identity.band_for(T.IDENTITY_PASS) == "pass"
    assert identity.band_for(0.65) == "warn"
    assert identity.band_for(T.IDENTITY_WARN) == "warn"
    assert identity.band_for(0.45) == "fail"
    assert identity.band_for(T.IDENTITY_HARD_FAIL) == "fail"
    assert identity.band_for(0.20) == "hard_fail"


def test_score_identity_verdicts():
    good, score_g, _ = identity.score_identity(np.full(20, 0.90), 1.0)
    assert good == "pass" and score_g >= T.PASS_FLOOR

    warn, _, _ = identity.score_identity(np.full(20, 0.65), 1.0)
    assert warn == "flag"

    bad, score_b, _ = identity.score_identity(np.full(20, 0.45), 1.0)
    assert bad == "fail" and score_b <= T.OVERALL_FAIL_CAP

    other, score_o, _ = identity.score_identity(np.full(20, 0.20), 1.0)
    assert other == "fail" and score_o < score_b


def test_score_identity_flags_drift_even_when_p10_passes():
    # Ends high enough that p10 still passes, but the trend is a decline.
    v = np.linspace(0.99, 0.78, 40)
    verdict, _score, metrics = identity.score_identity(v, 1.0)
    assert metrics["drift"] > T.IDENTITY_DRIFT_DELTA
    assert verdict == "flag"


def test_score_identity_empty_skips():
    verdict, _s, metrics = identity.score_identity(np.array([]), 0.0)
    assert verdict == "skip"
    assert metrics == {}


# ---------------------------------------------------------------------------
# Clustering
# ---------------------------------------------------------------------------


def test_cluster_embeddings_separates_two_people():
    rng = np.random.default_rng(3)
    a, b = _unit(rng), _unit(rng)
    embs = np.array(
        [identity.l2_normalize(a + 0.05 * _unit(rng)) for _ in range(6)]
        + [identity.l2_normalize(b + 0.05 * _unit(rng)) for _ in range(5)]
    )
    clusters = identity.cluster_embeddings(embs)
    assert len(clusters) == 2
    assert sorted(len(c) for c in clusters) == [5, 6]


def test_cluster_embeddings_single_identity_stays_one():
    rng = np.random.default_rng(4)
    base = _unit(rng)
    embs = np.array([identity.l2_normalize(base + 0.02 * _unit(rng)) for _ in range(7)])
    assert len(identity.cluster_embeddings(embs)) == 1


def test_cluster_embeddings_edge_cases():
    assert identity.cluster_embeddings(np.zeros((0, 4))) == []
    assert identity.cluster_embeddings(np.array([1.0, 0.0, 0.0])) == [[0]]


# ---------------------------------------------------------------------------
# Detection-row filtering
# ---------------------------------------------------------------------------


def test_qualifying_faces_drops_tiny_boxes():
    faces = np.zeros((3, 15), dtype=np.float32)
    faces[0, 2:4] = [100, 100]  # keep
    faces[1, 2:4] = [20, 20]    # too small
    faces[2, 2:4] = [64, 64]    # exactly at the floor: keep
    kept = identity.qualifying_faces(faces)
    assert kept.shape[0] == 2


def test_qualifying_faces_empty():
    assert identity.qualifying_faces(np.zeros((0, 15))).shape[0] == 0


def test_largest_face_picks_max_area():
    faces = np.zeros((2, 15), dtype=np.float32)
    faces[0, 2:4] = [80, 80]
    faces[1, 2:4] = [120, 120]
    assert identity.largest_face(faces)[2] == 120
    assert identity.largest_face(np.zeros((0, 15))) is None


# ---------------------------------------------------------------------------
# Kit I/O and skip behaviour
# ---------------------------------------------------------------------------


def test_load_kit_derives_missing_reference(tmp_path):
    rng = np.random.default_rng(5)
    embs = [list(_unit(rng)) for _ in range(3)]
    p = tmp_path / "embeddings.json"
    p.write_text(json.dumps({"model": "sface-2021dec", "dim": 128,
                             "images": [{"file": f"{i}.jpg", "embedding": e}
                                        for i, e in enumerate(embs)]}))
    kit = identity.load_kit(str(p))
    assert len(kit["reference"]) == 128
    assert np.linalg.norm(kit["reference"]) == pytest.approx(1.0)


def test_load_kit_rejects_empty(tmp_path):
    p = tmp_path / "empty.json"
    p.write_text(json.dumps({"model": "sface-2021dec", "images": []}))
    with pytest.raises(ValueError):
        identity.load_kit(str(p))


def test_no_kit_skips_without_touching_models(clips):
    r = identity.run(clips["clean"], None)
    assert r["verdict"] == "skip"
    assert r["score"] == 100
    assert "no character kit" in r["reason"]


def test_missing_kit_file_skips(clips, tmp_path):
    r = identity.run(clips["clean"], str(tmp_path / "nope.json"))
    assert r["verdict"] == "skip"
    assert "not found" in r["reason"]
