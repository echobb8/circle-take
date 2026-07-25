"""Real-model integration tests. Skipped by default — run with --runslow.

These DOWNLOAD the pinned models and run real inference. The synthetic fixtures
contain no faces and no hands, so the asserted behaviour is that identity and
anatomy SKIP cleanly (never fail, never crash) while temporal still catches the
injected defects.
"""

from __future__ import annotations

import json
import subprocess
import sys

import pytest

from circletake_gate import ENGINE_VERSION
from circletake_gate import models

pytestmark = pytest.mark.slow


@pytest.fixture(scope="module")
def cache_dir(tmp_path_factory):
    return str(tmp_path_factory.mktemp("models"))


def test_pinned_models_download_and_verify(cache_dir):
    for spec in (models.YUNET, models.SFACE):
        path = models.ensure_model(spec, cache_dir)
        assert models.sha256_file(path) == spec.sha256
        import os

        assert os.path.getsize(path) == spec.size


def test_hand_landmarker_downloads_or_degrades(cache_dir):
    path, warning = models.ensure_rolling_model(models.HAND_LANDMARKER, cache_dir)
    # Either it verified, or it degraded with an explanation — never a crash.
    assert path is not None or warning


def test_identity_skips_on_face_free_footage(clips, cache_dir, tmp_path):
    from circletake_gate.checks import identity

    # A syntactically valid kit; the clip simply has no faces.
    kit = tmp_path / "kit.json"
    kit.write_text(json.dumps({
        "model": "sface-2021dec", "dim": 128,
        "images": [{"file": "a.jpg", "embedding": [0.0] * 127 + [1.0]}],
    }))
    r = identity.run(clips["clean"], str(kit), cache_dir)
    assert r["verdict"] == "skip"
    assert "no scoreable face" in r["reason"]


def test_anatomy_skips_on_hand_free_footage(clips, cache_dir):
    from circletake_gate.checks import anatomy

    r = anatomy.run(clips["clean"], cache_dir)
    assert r["verdict"] == "skip"
    assert r["score"] == 100


def test_full_gate_end_to_end(clips, cache_dir, tmp_path):
    """The real CLI, real models, real report — on the morph fixture."""
    report_path = tmp_path / "gates" / "t1.json"
    proc = subprocess.run(
        [
            sys.executable, "-m", "circletake_gate", "gate", clips["morph"],
            "--report", str(report_path), "--take-id", "t1",
            "--cache-dir", cache_dir,
            "--expected", '{"durationSec": 3.0, "fps": 24}',
        ],
        capture_output=True, text=True, timeout=900,
    )
    assert proc.returncode == 0, proc.stderr[-2000:]

    # Every stdout line must be protocol-parseable.
    messages = []
    for line in proc.stdout.strip().split("\n"):
        m = json.loads(line)
        assert m["type"] in ("progress", "done", "error")
        messages.append(m)
    assert messages[-1]["type"] == "done"

    report = json.loads(report_path.read_text())
    assert report["takeId"] == "t1"
    assert report["engineVersion"] == ENGINE_VERSION
    assert report["status"] == "fail"  # the injected morph
    assert report["overall"] <= 40
    assert report["checks"]["temporal"]["verdict"] == "fail"
    assert report["checks"]["identity"]["verdict"] == "skip"
    assert report["checks"]["anatomy"]["verdict"] == "skip"
    # Evidence JPEGs must exist and be referenced project-relatively.
    for ev in report["checks"]["temporal"].get("evidence", []):
        assert ev["image"].startswith("evidence/t1/")
