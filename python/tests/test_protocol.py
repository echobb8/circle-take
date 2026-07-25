"""Worker protocol + CLI argument handling.

The host parses stdout with parseWorkerLine (src/shared/types.ts): one JSON
object per line, nothing else. These tests mirror that parser's contract.
"""

from __future__ import annotations

import json

import numpy as np
import pytest

from circletake_gate import ENGINE_VERSION, protocol
from circletake_gate.cli import build_parser, load_json_arg, _parse_checks


def parse_worker_line(line: str):
    """Python port of parseWorkerLine — the host's actual acceptance test."""
    s = line.strip()
    if not s.startswith("{"):
        return None
    try:
        m = json.loads(s)
    except json.JSONDecodeError:
        return None
    return m if m.get("type") in ("progress", "done", "error") else None


# ---------------------------------------------------------------------------
# Protocol
# ---------------------------------------------------------------------------


def test_progress_line_is_parseable(capsys):
    protocol.emit("temporal", 42.5, "running")
    out = capsys.readouterr().out
    assert out.endswith("\n") and out.count("\n") == 1
    m = parse_worker_line(out)
    assert m == {"type": "progress", "stage": "temporal", "pct": 42.5, "note": "running"}


def test_progress_note_is_optional(capsys):
    protocol.emit("probe", 1.0)
    m = parse_worker_line(capsys.readouterr().out)
    assert "note" not in m


def test_progress_pct_is_clamped(capsys):
    protocol.emit("x", 250.0)
    protocol.emit("x", -8.0)
    lines = capsys.readouterr().out.strip().split("\n")
    assert parse_worker_line(lines[0])["pct"] == 100.0
    assert parse_worker_line(lines[1])["pct"] == 0.0


def test_done_with_and_without_result(capsys):
    protocol.done({"overall": 91})
    protocol.done()
    lines = capsys.readouterr().out.strip().split("\n")
    assert parse_worker_line(lines[0]) == {"type": "done", "result": {"overall": 91}}
    assert parse_worker_line(lines[1]) == {"type": "done"}


def test_error_line(capsys):
    protocol.error("ffprobe not found")
    assert parse_worker_line(capsys.readouterr().out) == {
        "type": "error",
        "message": "ffprobe not found",
    }


def test_numpy_scalars_never_break_the_protocol(capsys):
    protocol.done({"score": np.float64(87.5), "n": np.int64(3), "series": np.array([1.0, 2.0])})
    m = parse_worker_line(capsys.readouterr().out)
    assert m["result"] == {"score": 87.5, "n": 3, "series": [1.0, 2.0]}


def test_log_goes_to_stderr_only(capsys):
    protocol.log("a warning")
    cap = capsys.readouterr()
    assert cap.out == ""
    assert "a warning" in cap.err


def test_multiline_content_stays_on_one_line(capsys):
    protocol.error("line one\nline two")
    out = capsys.readouterr().out
    assert out.count("\n") == 1
    assert parse_worker_line(out)["message"] == "line one\nline two"


def test_non_json_noise_is_rejected_by_the_parser():
    assert parse_worker_line("Downscale factor will be ignored") is None
    assert parse_worker_line('{"type":"unknown"}') is None
    assert parse_worker_line("{not json") is None
    assert parse_worker_line("") is None


# ---------------------------------------------------------------------------
# CLI argument handling
# ---------------------------------------------------------------------------


def test_load_json_arg_inline_object():
    assert load_json_arg('{"durationSec": 5}') == {"durationSec": 5}


def test_load_json_arg_inline_array():
    assert load_json_arg('[{"shotName":"12"}]') == [{"shotName": "12"}]


def test_load_json_arg_bare_file_path(tmp_path):
    p = tmp_path / "neighbors.json"
    p.write_text('[{"shotName": "12", "position": "prev"}]')
    assert load_json_arg(str(p))[0]["shotName"] == "12"


def test_load_json_arg_at_prefixed_path(tmp_path):
    p = tmp_path / "expected.json"
    p.write_text('{"fps": 24}')
    assert load_json_arg(f"@{p}") == {"fps": 24}


def test_load_json_arg_empty_and_none():
    assert load_json_arg(None) is None
    assert load_json_arg("   ") is None


def test_load_json_arg_rejects_garbage():
    with pytest.raises(ValueError):
        load_json_arg("not-json-and-not-a-file")


def test_parse_checks_defaults_to_all():
    assert _parse_checks(None) == [
        "identity", "temporal", "anatomy", "continuity", "conformance",
    ]


def test_parse_checks_subset_keeps_canonical_order():
    assert _parse_checks("conformance,temporal") == ["temporal", "conformance"]


def test_parse_checks_rejects_unknown():
    with pytest.raises(ValueError, match="unknown check"):
        _parse_checks("temporal,bogus")


# ---------------------------------------------------------------------------
# Parser wiring
# ---------------------------------------------------------------------------


def test_version_flag(capsys):
    with pytest.raises(SystemExit) as exc:
        build_parser().parse_args(["--version"])
    assert exc.value.code == 0
    assert ENGINE_VERSION in capsys.readouterr().out


def test_every_subcommand_exists():
    parser = build_parser()
    for cmd, extra in [
        ("probe", ["a.mp4"]),
        ("thumbs", ["a.mp4", "--out", "d"]),
        ("gate", ["a.mp4", "--report", "r.json", "--take-id", "t1"]),
        ("kit-build", ["k.json", "--images", "a.jpg"]),
        ("evidence", ["a.mp4", "--frames", "1,2", "--out", "d"]),
    ]:
        args = parser.parse_args([cmd] + extra)
        assert callable(args.func)


def test_gate_requires_take_id():
    with pytest.raises(SystemExit):
        build_parser().parse_args(["gate", "a.mp4", "--report", "r.json"])


def test_gate_optional_flags_parse():
    args = build_parser().parse_args([
        "gate", "a.mp4", "--report", "r.json", "--take-id", "t1",
        "--kit", "k.json", "--expected", '{"fps":24}',
        "--neighbors", "/tmp/n.json", "--checks", "temporal",
        "--cache-dir", "/tmp/cache", "--sample-fps", "2.5",
    ])
    assert args.kit == "k.json"
    assert args.sample_fps == 2.5
    assert args.checks == "temporal"


def test_help_renders(capsys):
    with pytest.raises(SystemExit):
        build_parser().parse_args(["--help"])
    out = capsys.readouterr().out
    for cmd in ("probe", "thumbs", "gate", "kit-build", "evidence"):
        assert cmd in out
