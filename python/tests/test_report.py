"""Report assembly, scoring blend, and suggestedWindow math."""

from __future__ import annotations

import json

import pytest

from circletake_gate import ENGINE_VERSION
from circletake_gate import thresholds as T
from circletake_gate import report as R


def check(verdict: str, score: int, reason: str = "because") -> dict:
    return {"verdict": verdict, "score": score, "reason": reason}


def series(values: list[float], dt: float = 0.1) -> list[dict]:
    return [{"t": round(i * dt, 3), "v": v} for i, v in enumerate(values)]


# ---------------------------------------------------------------------------
# Scoring — must mirror src/shared/types.ts exactly
# ---------------------------------------------------------------------------


def test_overall_is_min_emphasis_blend():
    checks = {"temporal": check("pass", 100), "identity": check("pass", 80)}
    # mean 90, min 80 -> 0.6*90 + 0.4*80 = 86
    assert R.overall_score(checks) == 86


def test_overall_fail_caps_at_40():
    checks = {"temporal": check("fail", 30), "identity": check("pass", 100)}
    assert R.overall_score(checks) <= T.OVERALL_FAIL_CAP


def test_all_pass_reaches_the_pass_floor():
    checks = {c: check("pass", 100) for c in ("temporal", "identity", "conformance")}
    assert R.overall_score(checks) >= T.PASS_FLOOR


def test_skips_are_excluded_from_the_blend():
    with_skip = {
        "temporal": check("pass", 90),
        "identity": check("skip", 100),
        "anatomy": check("skip", 100),
    }
    assert R.overall_score(with_skip) == R.overall_score({"temporal": check("pass", 90)})


def test_all_skipped_is_zero():
    assert R.overall_score({"identity": check("skip", 100)}) == 0
    assert R.overall_score({}) == 0


def test_status_precedence():
    assert R.status_from_checks({"a": check("pass", 100)}) == "pass"
    assert R.status_from_checks(
        {"temporal": check("flag", 70), "identity": check("pass", 100)}
    ) == "flag"
    assert R.status_from_checks(
        {"temporal": check("flag", 70), "identity": check("fail", 10)}
    ) == "fail"
    assert R.status_from_checks({"identity": check("skip", 100)}) == "pass"


# ---------------------------------------------------------------------------
# suggestedWindow
# ---------------------------------------------------------------------------


def test_window_finds_the_longest_clean_span():
    # Dirty 0.0-0.5s, clean 0.6-2.5s.
    values = [0.9] * 6 + [0.1] * 20
    w = R.suggest_window(series(values), 0.6, None, 0.75, duration=2.6)
    assert w is not None
    assert w["inSec"] == pytest.approx(0.6, abs=0.05)
    assert w["outSec"] == pytest.approx(2.5, abs=0.05)
    assert "cleanest continuous span" in w["reason"]


def test_window_omitted_when_the_whole_clip_is_clean():
    assert R.suggest_window(series([0.1] * 30), 0.6, None, 0.75, duration=3.0) is None


def test_window_omitted_when_nothing_qualifies():
    assert R.suggest_window(series([0.9] * 30), 0.6, None, 0.75, duration=3.0) is None


def test_window_omitted_when_the_clean_span_is_too_short():
    # Only 0.5s clean — below SUGGESTED_WINDOW_MIN_SEC.
    values = [0.9] * 10 + [0.1] * 5 + [0.9] * 10
    assert R.suggest_window(series(values), 0.6, None, 0.75, duration=2.5) is None


def test_window_respects_identity_series():
    temporal = series([0.1] * 40)  # temporally clean throughout (0.0-3.9s)
    # Identity is the wrong person until 1.5s, then locks on.
    ident = [{"t": 0.0, "v": 0.20}, {"t": 1.5, "v": 0.95}]
    w = R.suggest_window(temporal, 0.6, ident, T.IDENTITY_PASS, duration=4.0)
    assert w is not None
    assert w["inSec"] >= 1.4
    assert w["outSec"] == pytest.approx(3.9, abs=0.05)


def test_window_picks_the_longest_of_several():
    values = [0.1] * 5 + [0.9] * 2 + [0.1] * 22 + [0.9] * 2
    w = R.suggest_window(series(values), 0.6, None, 0.75, duration=3.1)
    assert w is not None
    assert w["outSec"] - w["inSec"] == pytest.approx(2.1, abs=0.15)


def test_window_none_without_a_temporal_series():
    assert R.suggest_window(None, 0.6, None, 0.75, duration=3.0) is None
    assert R.suggest_window([], 0.6, None, 0.75, duration=3.0) is None


# ---------------------------------------------------------------------------
# Report shape — must match src/shared/types.ts GateReport
# ---------------------------------------------------------------------------


def test_report_shape_matches_the_contract(tmp_path):
    checks = {
        "temporal": {
            "verdict": "flag",
            "score": 70,
            "reason": "luma flicker at 0.9s",
            "series": series([0.1, 0.2]),
            "threshold": 0.6,
            "details": {"framePairs": 2},
            "evidence_frames": [],
        },
        "identity": {"verdict": "skip", "score": 100, "reason": "no kit"},
    }
    rep = R.build_report(
        take_id="t1",
        media_path=str(tmp_path / "a.mp4"),
        checks=checks,
        model_versions={"yunet": "2023mar", "sface": "2021dec", "mediapipe": "0.10.35"},
        duration=3.0,
    )

    assert set(rep) >= {
        "takeId", "mediaPath", "engineVersion", "modelVersions",
        "ranAt", "overall", "status", "checks",
    }
    assert rep["takeId"] == "t1"
    assert rep["engineVersion"] == ENGINE_VERSION
    assert rep["status"] == "flag"
    assert rep["ranAt"].endswith("Z")
    assert rep["modelVersions"]["mediapipe"] == "0.10.35"

    t = rep["checks"]["temporal"]
    assert set(t) == {"verdict", "score", "reason", "series", "threshold", "details"}
    assert all(set(p) == {"t", "v"} for p in t["series"])
    # Engine-internal keys must never reach the report.
    assert "evidence_frames" not in t


def test_report_omits_absent_optional_fields(tmp_path):
    rep = R.build_report(
        take_id="t2",
        media_path=str(tmp_path / "a.mp4"),
        checks={"conformance": check("pass", 100)},
        model_versions={},
        duration=3.0,
    )
    assert "suggestedWindow" not in rep
    assert set(rep["checks"]["conformance"]) == {"verdict", "score", "reason"}


def test_report_includes_suggested_window(tmp_path):
    checks = {
        "temporal": {
            "verdict": "flag",
            "score": 70,
            "reason": "churn early",
            "series": series([0.9] * 6 + [0.1] * 20),
            "threshold": 0.6,
        }
    }
    rep = R.build_report("t3", str(tmp_path / "a.mp4"), checks, {}, duration=2.6)
    assert "suggestedWindow" in rep
    assert set(rep["suggestedWindow"]) == {"inSec", "outSec", "reason"}


def test_write_report_is_valid_json(tmp_path):
    rep = R.build_report("t4", str(tmp_path / "a.mp4"), {"conformance": check("pass", 100)}, {}, 1.0)
    out = tmp_path / "gates" / "t4.json"
    R.write_report(rep, str(out))
    assert out.is_file()
    assert json.loads(out.read_text())["takeId"] == "t4"
    assert not (tmp_path / "gates" / "t4.json.tmp").exists()


def test_evidence_paths_are_project_relative():
    assert R._project_relative("/abs/evidence/t1/f000012.jpg", "t1") == "evidence/t1/f000012.jpg"
    assert R._project_relative("/somewhere/else/f9.jpg", "abc") == "evidence/abc/f9.jpg"
