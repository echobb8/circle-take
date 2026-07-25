"""GateReport assembly — must match src/shared/types.ts exactly (camelCase keys).

The scoring blend here is a deliberate mirror of ``overallScore`` /
``statusFromChecks`` in src/shared/types.ts: 0.6*mean + 0.4*min over non-skip
checks, with any fail capping the overall at OVERALL_FAIL_CAP. The two
implementations MUST stay in sync — the app denormalizes GateSummary from this
report and recomputes nothing.
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from typing import Any

import numpy as np

from . import ENGINE_VERSION
from . import thresholds as T
from . import protocol
from .thumbs import extract_frames

CHECK_ORDER = ("identity", "temporal", "anatomy", "continuity", "conformance")


# ---------------------------------------------------------------------------
# Scoring (pure — mirrors src/shared/types.ts)
# ---------------------------------------------------------------------------


def overall_score(checks: dict[str, dict[str, Any]]) -> int:
    """0.6*mean + 0.4*min over non-skip checks; a fail caps at OVERALL_FAIL_CAP."""
    active = [c for cid in CHECK_ORDER if (c := checks.get(cid)) and c.get("verdict") != "skip"]
    if not active:
        return 0
    scores = [float(c.get("score", 0)) for c in active]
    mean = sum(scores) / len(scores)
    lowest = min(scores)
    overall = round(0.6 * mean + 0.4 * lowest)
    if any(c.get("verdict") == "fail" for c in active):
        overall = min(overall, T.OVERALL_FAIL_CAP)
    return int(overall)


def status_from_checks(checks: dict[str, dict[str, Any]]) -> str:
    """fail > flag > pass, with skips excluded."""
    active = [c for cid in CHECK_ORDER if (c := checks.get(cid)) and c.get("verdict") != "skip"]
    if any(c.get("verdict") == "fail" for c in active):
        return "fail"
    if any(c.get("verdict") == "flag" for c in active):
        return "flag"
    return "pass"


# ---------------------------------------------------------------------------
# Suggested select window
# ---------------------------------------------------------------------------


def suggest_window(
    temporal_series: list[dict[str, float]] | None,
    temporal_threshold: float,
    identity_series: list[dict[str, float]] | None,
    identity_threshold: float,
    duration: float,
    min_len: float = T.SUGGESTED_WINDOW_MIN_SEC,
) -> dict[str, Any] | None:
    """Longest continuous span that is clean on temporal AND (if run) identity.

    Returns ``{'inSec', 'outSec', 'reason'}`` or None when either nothing
    qualifies or the whole clip is already clean (nothing to suggest).

    "Clean" means the temporal warp ratio sits below its flag threshold and, when
    identity ran, the cosine similarity sits above its pass threshold.
    """
    if not temporal_series:
        return None
    times = [float(p["t"]) for p in temporal_series]
    ok = [float(p["v"]) < temporal_threshold for p in temporal_series]

    if identity_series:
        # Identity is sampled more sparsely; hold the last known value forward.
        id_t = [float(p["t"]) for p in identity_series]
        id_v = [float(p["v"]) for p in identity_series]
        for i, t in enumerate(times):
            j = int(np.searchsorted(id_t, t, side="right")) - 1
            if 0 <= j < len(id_v) and id_v[j] < identity_threshold:
                ok[i] = False

    # Longest run of consecutive True.
    best_start = best_end = -1
    cur_start = None
    for i, good in enumerate(ok):
        if good and cur_start is None:
            cur_start = i
        elif not good and cur_start is not None:
            if best_start < 0 or (i - 1 - cur_start) > (best_end - best_start):
                best_start, best_end = cur_start, i - 1
            cur_start = None
    if cur_start is not None:
        i = len(ok)
        if best_start < 0 or (i - 1 - cur_start) > (best_end - best_start):
            best_start, best_end = cur_start, i - 1
    if best_start < 0:
        return None

    in_sec = max(0.0, times[best_start])
    out_sec = times[best_end]
    if duration > 0:
        out_sec = min(duration, out_sec)
    span = out_sec - in_sec
    if span < min_len:
        return None
    # Whole clip already clean — the director needs no suggestion.
    if duration > 0 and span >= duration * T.SUGGESTED_WINDOW_CLEAN_FRACTION:
        return None

    return {
        "inSec": round(float(in_sec), 3),
        "outSec": round(float(out_sec), 3),
        "reason": f"cleanest continuous span ({span:.1f}s of {duration:.1f}s)",
    }


# ---------------------------------------------------------------------------
# Evidence
# ---------------------------------------------------------------------------


def _project_relative(path: str, take_id: str) -> str:
    """Report evidence paths relative to the .ctake project root.

    The app resolves these through the ``ctake://`` protocol, so the shape must
    be exactly ``evidence/<takeId>/<file>`` regardless of where the report lives.
    """
    return f"evidence/{take_id}/{os.path.basename(path)}"


def write_evidence(
    media_path: str,
    take_id: str,
    checks: dict[str, dict[str, Any]],
    evidence_dir: str,
    fps: float,
) -> None:
    """Extract every check's requested frames and rewrite them as EvidenceFrame."""
    wanted: dict[int, None] = {}
    for check in checks.values():
        for ev in check.get("evidence_frames") or []:
            wanted[int(ev["frame"])] = None
    if not wanted:
        return
    frames = sorted(wanted)
    try:
        extracted = extract_frames(media_path, frames, evidence_dir, fps=fps)
    except Exception as exc:
        protocol.log(f"warning: evidence extraction failed: {exc}")
        return
    by_frame = {int(e["frame"]): e for e in extracted}

    for check in checks.values():
        out: list[dict[str, Any]] = []
        for ev in check.pop("evidence_frames", []) or []:
            got = by_frame.get(int(ev["frame"]))
            if not got:
                continue
            out.append(
                {
                    "frame": int(ev["frame"]),
                    "t": float(ev.get("t", got["t"])),
                    "image": _project_relative(str(got["image"]), take_id),
                    "caption": str(ev["caption"]),
                }
            )
        if out:
            check["evidence"] = out


# ---------------------------------------------------------------------------
# Assembly
# ---------------------------------------------------------------------------


def build_report(
    take_id: str,
    media_path: str,
    checks: dict[str, dict[str, Any]],
    model_versions: dict[str, str],
    duration: float,
    ran_at: str | None = None,
) -> dict[str, Any]:
    """Assemble the GateReport dict (camelCase, matching src/shared/types.ts)."""
    clean: dict[str, dict[str, Any]] = {}
    for cid in CHECK_ORDER:
        c = checks.get(cid)
        if not c:
            continue
        entry: dict[str, Any] = {
            "verdict": str(c["verdict"]),
            "score": int(c["score"]),
            "reason": str(c["reason"]),
        }
        if c.get("series"):
            entry["series"] = c["series"]
        if c.get("threshold") is not None:
            entry["threshold"] = float(c["threshold"])
        if c.get("evidence"):
            entry["evidence"] = c["evidence"]
        if c.get("details"):
            entry["details"] = c["details"]
        clean[cid] = entry

    temporal = clean.get("temporal") or {}
    identity = clean.get("identity") or {}
    window = suggest_window(
        temporal.get("series"),
        float(temporal.get("threshold") or T.RATIO_MORPH_MIN),
        identity.get("series") if identity.get("verdict") != "skip" else None,
        float(identity.get("threshold") or T.IDENTITY_PASS),
        duration,
    )

    report: dict[str, Any] = {
        "takeId": take_id,
        "mediaPath": os.path.abspath(media_path),
        "engineVersion": ENGINE_VERSION,
        "modelVersions": model_versions,
        "ranAt": ran_at or datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "overall": overall_score(clean),
        "status": status_from_checks(clean),
        "checks": clean,
    }
    if window:
        report["suggestedWindow"] = window
    return report


def write_report(report: dict[str, Any], out_path: str) -> None:
    """Write the report JSON atomically (tmp + rename)."""
    out_dir = os.path.dirname(os.path.abspath(out_path))
    os.makedirs(out_dir, exist_ok=True)
    tmp = out_path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(report, fh, indent=2, ensure_ascii=False)
    os.replace(tmp, out_path)
