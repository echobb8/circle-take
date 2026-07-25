"""The report must satisfy src/shared/types.ts exactly.

This is the cross-lane contract: the Electron main process reads these files and
denormalizes GateSummary from them without re-validating. A drift here is a
silent runtime break in the app, so it is asserted structurally rather than by
eyeballing one example.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys

import pytest

from circletake_gate import report as R

# The CLI subprocess must find the package the same way conftest does for
# in-process imports: python/ on PYTHONPATH.
_PKG_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CLI_ENV = {**os.environ, "PYTHONPATH": _PKG_ROOT + os.pathsep + os.environ.get("PYTHONPATH", "")}

VERDICTS = {"pass", "flag", "fail", "skip"}
STATUSES = {"pass", "flag", "fail", "error"}
CHECK_IDS = {"identity", "temporal", "anatomy", "continuity", "conformance"}

CHECK_KEYS = {"verdict", "score", "reason", "series", "threshold", "evidence", "details"}
REQUIRED_CHECK_KEYS = {"verdict", "score", "reason"}
REPORT_KEYS = {
    "takeId", "mediaPath", "engineVersion", "modelVersions", "ranAt",
    "overall", "status", "checks", "suggestedWindow",
}
REQUIRED_REPORT_KEYS = REPORT_KEYS - {"suggestedWindow"}


def validate_report(rep: dict) -> None:
    """Assert a GateReport matches the TypeScript interface."""
    assert REQUIRED_REPORT_KEYS <= set(rep), REQUIRED_REPORT_KEYS - set(rep)
    assert not set(rep) - REPORT_KEYS, set(rep) - REPORT_KEYS

    assert isinstance(rep["takeId"], str) and rep["takeId"]
    assert isinstance(rep["mediaPath"], str)
    assert isinstance(rep["engineVersion"], str)
    assert isinstance(rep["ranAt"], str)
    assert isinstance(rep["overall"], int) and 0 <= rep["overall"] <= 100
    assert rep["status"] in STATUSES
    assert isinstance(rep["modelVersions"], dict)
    assert all(isinstance(k, str) and isinstance(v, str) for k, v in rep["modelVersions"].items())

    assert isinstance(rep["checks"], dict)
    assert set(rep["checks"]) <= CHECK_IDS
    for cid, c in rep["checks"].items():
        assert REQUIRED_CHECK_KEYS <= set(c), (cid, set(c))
        assert not set(c) - CHECK_KEYS, (cid, set(c) - CHECK_KEYS)
        assert c["verdict"] in VERDICTS, cid
        assert isinstance(c["score"], int) and 0 <= c["score"] <= 100, cid
        assert isinstance(c["reason"], str) and c["reason"], cid
        if "series" in c:
            assert isinstance(c["series"], list)
            for p in c["series"]:
                assert set(p) == {"t", "v"}
                assert isinstance(p["t"], (int, float))
                assert isinstance(p["v"], (int, float))
        if "threshold" in c:
            assert isinstance(c["threshold"], (int, float))
        if "evidence" in c:
            assert isinstance(c["evidence"], list) and c["evidence"]
            for e in c["evidence"]:
                assert set(e) == {"frame", "t", "image", "caption"}
                assert isinstance(e["frame"], int)
                assert isinstance(e["t"], (int, float))
                assert isinstance(e["image"], str)
                assert e["image"].startswith(f"evidence/{rep['takeId']}/")
                assert not e["image"].startswith("/")  # project-relative only
                assert isinstance(e["caption"], str) and e["caption"]
        if "details" in c:
            assert isinstance(c["details"], dict)
            json.dumps(c["details"])  # must be JSON-serializable

    if "suggestedWindow" in rep:
        w = rep["suggestedWindow"]
        assert set(w) == {"inSec", "outSec", "reason"}
        assert isinstance(w["inSec"], (int, float))
        assert isinstance(w["outSec"], (int, float))
        assert w["outSec"] > w["inSec"]
        assert isinstance(w["reason"], str) and w["reason"]


def test_scoring_matches_the_typescript_source():
    """overall_score must reproduce overallScore() from src/shared/types.ts."""
    import pathlib
    import re

    ts = pathlib.Path(__file__).resolve().parents[2] / "src" / "shared" / "types.ts"
    src = ts.read_text()
    # The blend and the cap are the two numbers that must never drift apart.
    assert "0.6 * mean + 0.4 * min" in src
    assert re.search(r"OVERALL_FAIL_CAP\s*=\s*40", src)
    assert re.search(r"PASS_FLOOR\s*=\s*85", src)

    from circletake_gate import thresholds as T

    assert T.OVERALL_FAIL_CAP == 40
    assert T.PASS_FLOOR == 85

    checks = {"temporal": {"verdict": "pass", "score": 100, "reason": "x"},
              "identity": {"verdict": "pass", "score": 80, "reason": "x"}}
    assert R.overall_score(checks) == round(0.6 * 90 + 0.4 * 80)


def test_engine_version_meets_the_declared_minimum():
    import pathlib
    import re

    from circletake_gate import ENGINE_VERSION

    ts = (pathlib.Path(__file__).resolve().parents[2] / "src" / "shared" / "types.ts").read_text()
    m = re.search(r"GATE_ENGINE_MIN_VERSION\s*=\s*'([^']+)'", ts)
    assert m, "GATE_ENGINE_MIN_VERSION not found in types.ts"
    to_tuple = lambda v: tuple(int(x) for x in v.split("."))
    assert to_tuple(ENGINE_VERSION) >= to_tuple(m.group(1))


@pytest.mark.parametrize("fixture_key", ["clean", "morph", "flicker", "frozen"])
def test_generated_reports_validate(clips, tmp_path, fixture_key):
    """Run the real CLI (no model checks) and validate every emitted report."""
    report_path = tmp_path / "gates" / f"{fixture_key}.json"
    proc = subprocess.run(
        [
            sys.executable, "-m", "circletake_gate", "gate", clips[fixture_key],
            "--report", str(report_path), "--take-id", f"tk{fixture_key}",
            "--checks", "temporal,conformance",
            "--expected", '{"durationSec": 3.0, "fps": 24}',
        ],
        capture_output=True, text=True, timeout=600, env=CLI_ENV,
    )
    assert proc.returncode == 0, proc.stderr[-2000:]

    # stdout must be pure line-JSON.
    for line in proc.stdout.strip().split("\n"):
        assert json.loads(line)["type"] in ("progress", "done", "error")

    validate_report(json.loads(report_path.read_text()))


def test_clean_fixture_passes_the_gate_end_to_end(clips, tmp_path):
    report_path = tmp_path / "clean.json"
    proc = subprocess.run(
        [
            sys.executable, "-m", "circletake_gate", "gate", clips["clean"],
            "--report", str(report_path), "--take-id", "clean1",
            "--checks", "temporal,conformance",
        ],
        capture_output=True, text=True, timeout=600, env=CLI_ENV,
    )
    assert proc.returncode == 0, proc.stderr[-2000:]
    rep = json.loads(report_path.read_text())
    validate_report(rep)
    assert rep["status"] == "pass", rep["checks"]
    assert rep["overall"] >= 85


def test_defective_fixtures_do_not_pass(clips, tmp_path):
    for key in ("morph", "churn"):
        report_path = tmp_path / f"{key}.json"
        subprocess.run(
            [
                sys.executable, "-m", "circletake_gate", "gate", clips[key],
                "--report", str(report_path), "--take-id", key,
                "--checks", "temporal",
            ],
            capture_output=True, text=True, timeout=600, env=CLI_ENV, check=True,
        )
        rep = json.loads(report_path.read_text())
        validate_report(rep)
        assert rep["status"] == "fail", f"{key} was not caught"


def test_error_path_emits_an_error_message(tmp_path):
    proc = subprocess.run(
        [
            sys.executable, "-m", "circletake_gate", "gate",
            str(tmp_path / "does-not-exist.mp4"),
            "--report", str(tmp_path / "r.json"), "--take-id", "x",
        ],
        capture_output=True, text=True, timeout=120, env=CLI_ENV,
    )
    assert proc.returncode == 1
    last = json.loads(proc.stdout.strip().split("\n")[-1])
    assert last["type"] == "error"
    assert isinstance(last["message"], str) and last["message"]
