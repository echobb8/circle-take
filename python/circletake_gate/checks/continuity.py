"""Continuity — will this take cut against its neighbours?

Doctrine (RESEARCH-tech.md §Continuity): raw per-pixel or histogram ΔE across two
shots is content-confounded — different content scores WORSE than a real grade
mismatch — so it is never a standalone gate. The content-independence trick is to
z-score the cross-cut delta against the take's OWN within-take variance: a
difference only counts when it is larger than the variation the take already
contains frame to frame.

We compare the LAST 12 frames of the previous shot against the FIRST 12 of this
take (and symmetrically for the next shot), on 128x128 downsamples, using robust
statistics: median L*/a*/b*, L* IQR, and clipping percentages.
"""

from __future__ import annotations

import json
import os
from typing import Any

import numpy as np

from .. import thresholds as T
from .. import protocol
from ..video import Clip, color_stat_frame


# ---------------------------------------------------------------------------
# Pure statistics
# ---------------------------------------------------------------------------


def lab_stats(frames: list[np.ndarray]) -> dict[str, Any]:
    """Robust Lab statistics for a set of BGR frames (already 128x128).

    Returns per-frame medians (for variance estimation) plus the pooled summary.
    """
    from skimage.color import rgb2lab

    per_frame_l: list[float] = []
    per_frame_a: list[float] = []
    per_frame_b: list[float] = []
    per_frame_iqr: list[float] = []
    clip_hi: list[float] = []
    clip_lo: list[float] = []

    for f in frames:
        rgb = f[:, :, ::-1].astype(np.float64) / 255.0
        lab = rgb2lab(rgb)
        L = lab[..., 0]
        per_frame_l.append(float(np.median(L)))
        per_frame_a.append(float(np.median(lab[..., 1])))
        per_frame_b.append(float(np.median(lab[..., 2])))
        per_frame_iqr.append(float(np.percentile(L, 75) - np.percentile(L, 25)))
        clip_hi.append(float((f >= T.CONTINUITY_CLIP_HIGH).mean()))
        clip_lo.append(float((f <= T.CONTINUITY_CLIP_LOW).mean()))

    if not frames:
        return {}
    return {
        "L": float(np.median(per_frame_l)),
        "a": float(np.median(per_frame_a)),
        "b": float(np.median(per_frame_b)),
        "lIqr": float(np.median(per_frame_iqr)),
        "clipHigh": float(np.median(clip_hi)),
        "clipLow": float(np.median(clip_lo)),
        "lStd": float(np.std(per_frame_l)),
        "aStd": float(np.std(per_frame_a)),
        "bStd": float(np.std(per_frame_b)),
        "frames": len(frames),
    }


def delta_e00(s1: dict[str, Any], s2: dict[str, Any]) -> float:
    """CIEDE2000 between two Lab triples (the robust medians of each side)."""
    from skimage.color import deltaE_ciede2000

    lab1 = np.array([[[s1["L"], s1["a"], s1["b"]]]], dtype=np.float64)
    lab2 = np.array([[[s2["L"], s2["a"], s2["b"]]]], dtype=np.float64)
    return float(deltaE_ciede2000(lab1, lab2).ravel()[0])


def z_scores(s1: dict[str, Any], s2: dict[str, Any], within_std: dict[str, float]) -> dict[str, float]:
    """Cross-cut deltas expressed in multiples of within-take standard deviation.

    This is the content-independence trick (RT §Continuity): a 4 L* step across a
    cut is meaningless if the take itself swings 4 L* frame-to-frame, and damning
    if it does not.
    """
    out: dict[str, float] = {}
    for key in ("L", "a", "b"):
        sd = max(float(within_std.get(key, 0.0)), 0.25)  # floor: measurement noise
        out[key] = float((s2[key] - s1[key]) / sd)
    return out


def band_for_delta_e(de: float) -> str:
    """RT §Continuity bands: <1 invisible, 1-2 subtle, 2-5 warn, >5 fail."""
    if de < T.DELTA_E_INVISIBLE:
        return "invisible"
    if de < T.DELTA_E_SUBTLE:
        return "subtle"
    if de < T.DELTA_E_WARN:
        return "warn"
    return "fail"


def verdict_for(de: float, z: dict[str, float], clip_delta: float) -> str:
    """Combine the ΔE band with the z-score gate.

    A ΔE in the warn/fail band only escalates when the z-score confirms it is
    larger than the take's own variation — otherwise it is content, not grade.
    """
    band = band_for_delta_e(de)
    significant = max(abs(v) for v in z.values()) >= T.CONTINUITY_Z_K if z else False
    if band == "fail" and significant:
        return "fail"
    if band == "fail":
        return "flag"
    if band == "warn":
        return "flag" if significant else "pass"
    if clip_delta >= T.CONTINUITY_CLIP_DELTA_FLAG:
        return "flag"
    return "pass"


# ---------------------------------------------------------------------------
# Neighbour loading
# ---------------------------------------------------------------------------


def _head_frames(path: str, n: int) -> list[np.ndarray]:
    with Clip(path) as clip:
        out: list[np.ndarray] = []
        for _idx, _t, frame in clip.frames(stride=1):
            out.append(color_stat_frame(frame, T.COLOR_STAT_SIZE))
            if len(out) >= n:
                break
        return out


def _tail_frames(path: str, n: int) -> list[np.ndarray]:
    with Clip(path) as clip:
        return [color_stat_frame(f, T.COLOR_STAT_SIZE) for f in clip.tail_frames(n)]


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def run(media_path: str, neighbors: list[dict[str, Any]] | None) -> dict[str, Any]:
    """Compare this take's head/tail against its neighbouring shots."""
    if not neighbors:
        return {
            "verdict": "skip",
            "score": 100,
            "reason": "no neighbouring shots to cut against — continuity not scored",
            "details": {},
            "evidence_frames": [],
        }

    n = T.CONTINUITY_COMPARE_FRAMES
    try:
        own_head = _head_frames(media_path, n)
        own_tail = _tail_frames(media_path, n)
    except Exception as exc:
        return {
            "verdict": "skip",
            "score": 100,
            "reason": f"could not read this take for continuity ({exc})",
            "details": {},
            "evidence_frames": [],
        }
    if not own_head:
        return {
            "verdict": "skip",
            "score": 100,
            "reason": "no frames decoded — continuity not scored",
            "details": {},
            "evidence_frames": [],
        }

    head_stats = lab_stats(own_head)
    tail_stats = lab_stats(own_tail or own_head)
    within_std = {
        "L": max(head_stats.get("lStd", 0.0), tail_stats.get("lStd", 0.0)),
        "a": max(head_stats.get("aStd", 0.0), tail_stats.get("aStd", 0.0)),
        "b": max(head_stats.get("bStd", 0.0), tail_stats.get("bStd", 0.0)),
    }

    comparisons: list[dict[str, Any]] = []
    for nb in neighbors:
        path = nb.get("mediaPath")
        position = (nb.get("position") or "").lower()
        name = nb.get("shotName") or (os.path.basename(path) if path else "neighbour")
        if not path or not os.path.isfile(path):
            protocol.log(f"warning: neighbour media missing, skipped: {path}")
            continue
        try:
            if position == "prev":
                # LAST frames of the previous shot vs FIRST of this take.
                other = _tail_frames(path, n)
                mine = head_stats
            elif position == "next":
                other = _head_frames(path, n)
                mine = tail_stats
            else:
                protocol.log(f"warning: neighbour {name} has no position, skipped")
                continue
        except Exception as exc:
            protocol.log(f"warning: could not read neighbour {name}: {exc}")
            continue
        if not other:
            continue
        other_stats = lab_stats(other)
        de = delta_e00(other_stats, mine)
        z = z_scores(other_stats, mine, within_std)
        clip_delta = max(
            abs(mine["clipHigh"] - other_stats["clipHigh"]),
            abs(mine["clipLow"] - other_stats["clipLow"]),
        )
        v = verdict_for(de, z, clip_delta)
        comparisons.append(
            {
                "shotName": name,
                "position": position,
                "deltaE00": round(de, 3),
                "band": band_for_delta_e(de),
                "deltaL": round(mine["L"] - other_stats["L"], 3),
                "deltaA": round(mine["a"] - other_stats["a"], 3),
                "deltaB": round(mine["b"] - other_stats["b"], 3),
                "zL": round(z["L"], 2),
                "zA": round(z["a"], 2),
                "zB": round(z["b"], 2),
                "clipDelta": round(clip_delta, 4),
                "verdict": v,
            }
        )

    if not comparisons:
        return {
            "verdict": "skip",
            "score": 100,
            "reason": "neighbouring shot media unavailable — continuity not scored",
            "details": {"requested": len(neighbors)},
            "evidence_frames": [],
        }

    worst = max(comparisons, key=lambda c: c["deltaE00"])
    if any(c["verdict"] == "fail" for c in comparisons):
        verdict = "fail"
    elif any(c["verdict"] == "flag" for c in comparisons):
        verdict = "flag"
    else:
        verdict = "pass"

    de = worst["deltaE00"]
    score = int(round(float(np.clip(100.0 - 14.0 * de, 0.0, 100.0))))
    if verdict == "fail":
        score = min(score, T.OVERALL_FAIL_CAP)
    elif verdict == "flag":
        score = min(score, 78)

    # -- reason ---------------------------------------------------------------
    parts: list[str] = []
    for c in sorted(comparisons, key=lambda x: -x["deltaE00"]):
        if c["verdict"] == "pass":
            continue
        side = "tail" if c["position"] == "prev" else "head"
        direction = "+" if c["deltaL"] >= 0 else ""
        parts.append(
            f"exposure jumps {direction}{c['deltaL']:.1f} L* vs shot {c['shotName']} {side} "
            f"(ΔE00 {c['deltaE00']:.1f}) — will read as a grade mismatch at the cut"
        )
    if not parts:
        parts.append(
            f"matches its neighbours (worst ΔE00 {de:.1f} vs shot {worst['shotName']}, "
            "below the visible threshold)"
        )
    reason = "; ".join(parts[:2])

    evidence_frames = []
    if verdict != "pass":
        # The cut point itself is the evidence: frame 0 of this take.
        evidence_frames.append(
            {"frame": 0, "t": 0.0, "caption": f"cut point (ΔE00 {de:.1f} vs neighbour)"}
        )

    return {
        "verdict": verdict,
        "score": score,
        "reason": reason,
        "threshold": T.DELTA_E_WARN,
        "evidence_frames": evidence_frames,
        "details": {
            "comparisons": comparisons,
            "compareFrames": n,
            "statSize": T.COLOR_STAT_SIZE,
            "headStats": {k: round(v, 4) for k, v in head_stats.items() if isinstance(v, float)},
            "tailStats": {k: round(v, 4) for k, v in tail_stats.items() if isinstance(v, float)},
            "withinTakeStd": {k: round(v, 4) for k, v in within_std.items()},
        },
    }
