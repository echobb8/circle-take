"""``python -m circletake_gate <command>`` — the gate worker CLI.

Every command writes ONLY line-JSON to stdout (protocol.py). Diagnostics go to
stderr. Exit code 0 on success, 1 after emitting an ``error`` message.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any

from . import ENGINE_VERSION, protocol
from . import thresholds as T

CHECK_IDS = ("identity", "temporal", "anatomy", "continuity", "conformance")


# ---------------------------------------------------------------------------
# Argument helpers
# ---------------------------------------------------------------------------


def load_json_arg(value: str | None) -> Any:
    """Parse a JSON argument given inline, as ``@path``, or as a bare file path.

    The host passes ``--expected`` as an inline JSON string and ``--neighbors``
    as a bare file path, so both forms must work on both flags. Detection: a
    value starting with '{' or '[' is inline JSON; '@' prefixes an explicit
    path; anything else is treated as a path.
    """
    if value is None:
        return None
    v = value.strip()
    if not v:
        return None
    if v.startswith("@"):
        path = v[1:]
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    if v.startswith("{") or v.startswith("["):
        return json.loads(v)
    if os.path.isfile(v):
        with open(v, encoding="utf-8") as fh:
            return json.load(fh)
    raise ValueError(
        f"could not interpret {value!r} as inline JSON or a readable file path"
    )


def _parse_checks(value: str | None) -> list[str]:
    """Parse --checks into a validated ordered list."""
    if not value:
        return list(CHECK_IDS)
    wanted = [c.strip().lower() for c in value.split(",") if c.strip()]
    bad = [c for c in wanted if c not in CHECK_IDS]
    if bad:
        raise ValueError(
            f"unknown check(s): {', '.join(bad)}. Valid: {', '.join(CHECK_IDS)}"
        )
    return [c for c in CHECK_IDS if c in wanted]


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------


def cmd_probe(args: argparse.Namespace) -> int:
    from .probe import probe

    protocol.emit("probe", 10.0, "reading container")
    info = probe(args.media)
    protocol.emit("probe", 100.0, "done")
    protocol.done(info)
    return 0


def cmd_thumbs(args: argparse.Namespace) -> int:
    from .thumbs import make_thumbs

    protocol.emit("thumbs", 5.0, "extracting poster")
    result = make_thumbs(args.media, args.out, args.count)
    protocol.emit("thumbs", 100.0, "done")
    protocol.done(result)
    return 0


def cmd_evidence(args: argparse.Namespace) -> int:
    from .thumbs import extract_frames

    frames = [int(x) for x in str(args.frames).split(",") if x.strip()]
    protocol.emit("evidence", 10.0, f"extracting {len(frames)} frame(s)")
    result = extract_frames(args.media, frames, args.out)
    protocol.emit("evidence", 100.0, "done")
    protocol.done({"frames": result})
    return 0


def cmd_kit_build(args: argparse.Namespace) -> int:
    from .kit import build_kit

    protocol.emit("kit", 2.0, "loading face models")
    result = build_kit(args.images, args.out, args.cache_dir)
    protocol.emit("kit", 100.0, "done")
    protocol.done(result)
    return 0


def cmd_gate(args: argparse.Namespace) -> int:
    from .probe import probe
    from .report import build_report, write_evidence, write_report

    checks_wanted = _parse_checks(args.checks)
    expected = load_json_arg(args.expected) or {}
    neighbors = load_json_arg(args.neighbors) or []
    if expected and not isinstance(expected, dict):
        raise ValueError("--expected must be a JSON object")
    if neighbors and not isinstance(neighbors, list):
        raise ValueError("--neighbors must be a JSON array")

    media = os.path.abspath(args.media)
    protocol.emit("probe", 2.0, "reading container")
    probe_info = probe(media)
    duration = float(probe_info.get("durationSec") or 0.0)
    fps = float(probe_info.get("fps") or 0.0)

    results: dict[str, dict[str, Any]] = {}
    model_versions: dict[str, str] = {}

    # Progress budget: conformance and continuity are cheap, temporal dominates,
    # identity/anatomy are model-bound.
    weights = {
        "conformance": 10.0,
        "temporal": 45.0,
        "identity": 22.0,
        "anatomy": 18.0,
        "continuity": 5.0,
    }
    active = [c for c in CHECK_IDS if c in checks_wanted]
    total_weight = sum(weights[c] for c in active) or 1.0
    progress = 5.0

    for cid in active:
        span = 90.0 * weights[cid] / total_weight
        protocol.emit(cid, progress, f"running {cid}")
        try:
            if cid == "conformance":
                from .checks import conformance

                results[cid] = conformance.run(media, probe_info, expected)
            elif cid == "temporal":
                from .checks import temporal

                results[cid] = temporal.run(media)
            elif cid == "identity":
                from .checks import identity

                results[cid] = identity.run(
                    media, args.kit, args.cache_dir, args.sample_fps
                )
                if results[cid].get("verdict") != "skip":
                    model_versions["yunet"] = "2023mar"
                    model_versions["sface"] = "2021dec"
            elif cid == "anatomy":
                from .checks import anatomy

                results[cid] = anatomy.run(media, args.cache_dir, args.sample_fps)
                # 'unavailable' must mean the RUNTIME is missing, not that the
                # shot happened to contain no hands.
                model_versions["mediapipe"] = (
                    "0.10.35"
                    if results[cid].get("details", {}).get("mediapipeAvailable")
                    else "unavailable"
                )
            elif cid == "continuity":
                from .checks import continuity

                results[cid] = continuity.run(media, neighbors)
        except Exception as exc:
            # One check must never take the whole gate down.
            protocol.log(f"warning: check {cid} raised: {exc}")
            results[cid] = {
                "verdict": "skip",
                "score": 100,
                "reason": f"{cid} check could not run ({exc})",
                "details": {"error": str(exc)},
                "evidence_frames": [],
            }
        progress += span
        protocol.emit(cid, min(95.0, progress), results[cid].get("reason", "")[:120])

    # Model versions the report must always carry.
    model_versions.setdefault("yunet", "2023mar" if "identity" in active else "unused")
    model_versions.setdefault("sface", "2021dec" if "identity" in active else "unused")
    model_versions.setdefault("mediapipe", "unavailable")

    report_path = os.path.abspath(args.report)
    evidence_dir = args.evidence_dir or os.path.join(
        os.path.dirname(os.path.dirname(report_path)), "evidence", args.take_id
    )
    protocol.emit("evidence", 96.0, "extracting worst frames")
    write_evidence(media, args.take_id, results, evidence_dir, fps)

    report = build_report(
        take_id=args.take_id,
        media_path=media,
        checks=results,
        model_versions=model_versions,
        duration=duration,
    )
    write_report(report, report_path)
    protocol.emit("report", 100.0, "done")
    protocol.done(
        {
            "report": report_path,
            "overall": report["overall"],
            "status": report["status"],
            "evidenceDir": evidence_dir,
        }
    )
    return 0


# ---------------------------------------------------------------------------
# Parser
# ---------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="circletake_gate",
        description=(
            "Circle Take gate engine — local QC scoring for AI-generated video takes. "
            "All output is line-JSON on stdout."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Examples:\n"
            "  python -m circletake_gate probe take.mp4\n"
            "  python -m circletake_gate thumbs take.mp4 --out thumbs/t1 --count 8\n"
            "  python -m circletake_gate gate take.mp4 --report gates/t1.json --take-id t1\n"
            "  python -m circletake_gate kit-build kits/c1/embeddings.json --images a.jpg b.jpg\n"
            "  python -m circletake_gate evidence take.mp4 --frames 12,88 --out evidence/t1\n"
        ),
    )
    parser.add_argument("--version", action="version", version=f"circletake_gate {ENGINE_VERSION}")
    sub = parser.add_subparsers(dest="command", metavar="<command>")

    p_probe = sub.add_parser("probe", help="duration / fps / size / codec via ffprobe")
    p_probe.add_argument("media", help="path to the media file")
    p_probe.set_defaults(func=cmd_probe)

    p_thumbs = sub.add_parser("thumbs", help="poster.jpg + filmstrip JPEGs")
    p_thumbs.add_argument("media", help="path to the media file")
    p_thumbs.add_argument("--out", required=True, help="output directory")
    p_thumbs.add_argument(
        "--count", type=int, default=T.STRIP_COUNT, help=f"filmstrip frames (default {T.STRIP_COUNT})"
    )
    p_thumbs.set_defaults(func=cmd_thumbs)

    p_gate = sub.add_parser("gate", help="run the QC checks and write a gate report")
    p_gate.add_argument("media", help="path to the media file")
    p_gate.add_argument("--report", required=True, help="output path for the gate report JSON")
    p_gate.add_argument("--take-id", required=True, help="take id (used in the report and evidence paths)")
    p_gate.add_argument("--kit", help="character kit embeddings.json for the identity check")
    p_gate.add_argument(
        "--expected",
        help="expected format as inline JSON or a path to a JSON file "
        '(e.g. \'{"durationSec":5,"fps":24,"width":1920,"height":1080}\')',
    )
    p_gate.add_argument(
        "--neighbors",
        help="neighbouring shots as inline JSON or a path to a JSON file "
        '(e.g. \'[{"shotName":"12","mediaPath":"/a.mp4","position":"prev"}]\')',
    )
    p_gate.add_argument(
        "--checks",
        help=f"comma-separated subset of: {','.join(CHECK_IDS)} (default: all)",
    )
    p_gate.add_argument("--cache-dir", help="model cache directory (default: platform cache dir)")
    p_gate.add_argument("--evidence-dir", help="where to write evidence JPEGs (default: <report>/../../evidence/<takeId>)")
    p_gate.add_argument(
        "--sample-fps",
        type=float,
        default=T.DEFAULT_SAMPLE_FPS,
        help=f"sampling rate for model checks (default {T.DEFAULT_SAMPLE_FPS})",
    )
    p_gate.set_defaults(func=cmd_gate)

    p_kit = sub.add_parser("kit-build", help="build character-kit face embeddings")
    p_kit.add_argument("out", help="output embeddings.json path")
    p_kit.add_argument("--images", nargs="+", required=True, help="reference still image paths")
    p_kit.add_argument("--cache-dir", help="model cache directory")
    p_kit.set_defaults(func=cmd_kit_build)

    p_ev = sub.add_parser("evidence", help="extract specific frames as JPEGs")
    p_ev.add_argument("media", help="path to the media file")
    p_ev.add_argument("--frames", required=True, help="comma-separated frame indices, e.g. 12,88")
    p_ev.add_argument("--out", required=True, help="output directory")
    p_ev.set_defaults(func=cmd_evidence)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if not getattr(args, "func", None):
        parser.print_help(sys.stderr)
        return 2
    try:
        return int(args.func(args) or 0)
    except KeyboardInterrupt:  # pragma: no cover - interactive
        protocol.error("cancelled")
        return 1
    except Exception as exc:
        protocol.error(str(exc))
        protocol.log(f"fatal: {type(exc).__name__}: {exc}")
        return 1


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
