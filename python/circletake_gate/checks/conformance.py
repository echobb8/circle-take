"""Conformance — is this file even deliverable?

Duration/fps/aspect/resolution against the shot's expectation, plus the failure
modes that make a take unusable regardless of its artistic merit: a file that
will not decode, frozen or black head/tails, and (advisory) collapsed sharpness,
sensor noise, macroblocking, and exposure clipping.

Technical-metric doctrine (RESEARCH-anatomy-supplement.md §Technical):

* variance-of-Laplacian is violently resolution-dependent — and downscaling
  RAISES it — so every frame is resampled to a fixed 1024 px long edge first and
  the result is contrast-normalized by mean(gray)^2.
* varLap alone cannot separate sharp from noisy, so it is always paired with the
  Immerkaer noise estimate on the flattest tile.
* A decoder/generation freeze produces BIT-IDENTICAL frames; a legitimately
  static shot still carries dither. ``np.array_equal`` is the discriminator.
* Clipping NEVER fails on its own — a white studio background legitimately clips
  more than half its samples.
"""

from __future__ import annotations

import math
from typing import Any

import cv2
import numpy as np

from .. import thresholds as T
from ..video import Clip, to_gray


# ---------------------------------------------------------------------------
# Pure technical metrics
# ---------------------------------------------------------------------------


def resample_long_edge(frame: np.ndarray, long_edge: int) -> np.ndarray:
    """Resample so the long edge equals ``long_edge`` (INTER_AREA), preserving
    aspect. Mandatory before varLap (RAS §Technical.1)."""
    h, w = frame.shape[:2]
    if max(h, w) == 0:
        return frame
    scale = long_edge / float(max(h, w))
    if abs(scale - 1.0) < 1e-6:
        return frame
    interp = cv2.INTER_AREA if scale < 1.0 else cv2.INTER_LINEAR
    return cv2.resize(
        frame, (max(1, int(round(w * scale))), max(1, int(round(h * scale)))), interpolation=interp
    )


def normalized_sharpness(gray: np.ndarray) -> float:
    """Contrast-normalized variance of Laplacian: varLap / mean(gray)^2 * 1e4.

    Bands (RAS §Technical.1): >200 sharp, 50-200 ok, 5-50 soft, <5 fail. The
    caller must have resampled to the fixed analysis resolution first.
    """
    g = np.asarray(gray, dtype=np.float64)
    mean = float(g.mean())
    if mean <= 1e-6:
        return 0.0
    var = float(cv2.Laplacian(g.astype(np.float32), cv2.CV_32F).var())
    return var / (mean * mean) * 1e4


def immerkaer_noise(gray: np.ndarray, tile: int = T.NOISE_TILE) -> float:
    """Immerkaer noise estimate on the flattest tile (RAS §Technical.2).

    sigma = sqrt(pi/2) / (6*(W-2)*(H-2)) * sum|I (*) K|,
    K = [[1,-2,1], [-2,4,-2], [1,-2,1]].

    Evaluated on the flattest ``tile`` x ``tile`` window so texture is not
    counted as noise. Bands: <2 clean, 2-4 grain, 4-8 warn, >8 fail.
    """
    g = np.asarray(gray, dtype=np.float32)
    h, w = g.shape[:2]
    if h < 4 or w < 4:
        return 0.0

    patch = g
    if h >= tile and w >= tile:
        # Flattest tile = lowest local standard deviation.
        best_sd = math.inf
        step = max(8, tile // 2)
        for y in range(0, h - tile + 1, step):
            for x in range(0, w - tile + 1, step):
                block = g[y : y + tile, x : x + tile]
                sd = float(block.std())
                if sd < best_sd:
                    best_sd = sd
                    patch = block

    ph, pw = patch.shape[:2]
    if ph < 3 or pw < 3:
        return 0.0
    kernel = np.array([[1, -2, 1], [-2, 4, -2], [1, -2, 1]], dtype=np.float32)
    conv = cv2.filter2D(patch, cv2.CV_32F, kernel, borderType=cv2.BORDER_REPLICATE)
    interior = conv[1:-1, 1:-1]
    denom = 6.0 * (pw - 2) * (ph - 2)
    if denom <= 0:
        return 0.0
    return float(math.sqrt(math.pi / 2.0) * np.abs(interior).sum() / denom)


def blockiness(gray: np.ndarray, block: int = 8) -> float:
    """Ratio of mean absolute difference across 8-px block boundaries to the mean
    absolute difference elsewhere (RAS §Technical.4).

    <1.05 clean, 1.15-1.35 warn, >1.35 heavy macroblocking. Advisory only.
    """
    g = np.asarray(gray, dtype=np.float64)
    h, w = g.shape[:2]
    if w < 2 * block or h < 2 * block:
        return 1.0
    dx = np.abs(np.diff(g, axis=1))
    cols = np.arange(dx.shape[1])
    on = (cols + 1) % block == 0
    off = ~on
    if not on.any() or not off.any():
        return 1.0
    a = float(dx[:, on].mean())
    b = float(dx[:, off].mean())
    if b <= 1e-9:
        return 1.0
    return a / b


def clipping(frame: np.ndarray) -> tuple[float, float]:
    """(fraction >= 254, fraction <= 1) across all channels."""
    f = np.asarray(frame)
    return float((f >= T.CONTINUITY_CLIP_HIGH).mean()), float((f <= T.CONTINUITY_CLIP_LOW).mean())


def is_frozen_pair(a: np.ndarray, b: np.ndarray) -> tuple[bool, bool]:
    """(bit_identical, below_noise_floor) for a consecutive frame pair.

    Bit-identical is the decoder/generation freeze tell (RAS §Technical.3): a
    legitimately static shot still dithers. The softer noise-floor test is kept
    as a secondary signal for re-encoded material.
    """
    if a.shape != b.shape:
        return False, False
    if np.array_equal(a, b):
        return True, True
    diff = float(np.abs(a.astype(np.float32) - b.astype(np.float32)).mean())
    return False, diff < T.FROZEN_DIFF_THRESHOLD


def within_tolerance(actual: float, expected: float, tol: float) -> bool:
    """Relative tolerance test that is safe when ``expected`` is zero."""
    if expected <= 0:
        return True
    return abs(actual - expected) / expected <= tol


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def run(
    media_path: str,
    probe_info: dict[str, Any],
    expected: dict[str, Any] | None,
) -> dict[str, Any]:
    """Run the conformance check."""
    expected = expected or {}
    findings: list[str] = []
    advisories: list[str] = []
    verdict = "pass"
    details: dict[str, Any] = {"expected": expected, "probe": probe_info}

    def escalate(to: str) -> None:
        nonlocal verdict
        order = {"pass": 0, "flag": 1, "fail": 2}
        if order[to] > order[verdict]:
            verdict = to

    duration = float(probe_info.get("durationSec") or 0.0)
    fps = float(probe_info.get("fps") or 0.0)
    width = int(probe_info.get("width") or 0)
    height = int(probe_info.get("height") or 0)

    # -- decode sanity --------------------------------------------------------
    head: list[np.ndarray] = []
    tail: list[np.ndarray] = []
    sharp_series: list[tuple[float, float]] = []
    noise_vals: list[float] = []
    block_vals: list[float] = []
    clip_hi_vals: list[float] = []
    clip_lo_vals: list[float] = []
    n_frames = 0
    decode_error: str | None = None

    try:
        with Clip(media_path) as clip:
            stride = max(1, int(round(clip.fps * T.SHARPNESS_WINDOW_SEC))) if clip.fps > 0 else 15
            for idx, t, frame in clip.frames(stride=1):
                n_frames += 1
                if len(head) < T.FROZEN_CHECK_FRAMES:
                    head.append(frame.copy())
                tail.append(frame.copy())
                if len(tail) > T.FROZEN_CHECK_FRAMES:
                    tail.pop(0)
                if idx % stride == 0:
                    analysis = resample_long_edge(frame, T.SHARPNESS_ANALYSIS_LONG_EDGE)
                    gray = to_gray(analysis)
                    sharp_series.append((t, normalized_sharpness(gray)))
                    noise_vals.append(immerkaer_noise(gray))
                    block_vals.append(blockiness(gray))
                    hi, lo = clipping(frame)
                    clip_hi_vals.append(hi)
                    clip_lo_vals.append(lo)
    except Exception as exc:
        decode_error = str(exc)

    if decode_error:
        return {
            "verdict": "fail",
            "score": 0,
            "reason": f"the file will not decode ({decode_error}) — unusable as delivered",
            "details": {**details, "decodeError": decode_error},
            "evidence_frames": [],
        }
    if n_frames == 0:
        return {
            "verdict": "fail",
            "score": 0,
            "reason": "the file decoded zero frames — unusable as delivered",
            "details": {**details, "framesDecoded": 0},
            "evidence_frames": [],
        }
    details["framesDecoded"] = n_frames

    # -- format vs expectation -----------------------------------------------
    exp_dur = float(expected.get("durationSec") or 0.0)
    if exp_dur > 0 and duration > 0:
        rel = abs(duration - exp_dur) / exp_dur
        details["durationDelta"] = round(duration - exp_dur, 3)
        if rel > T.DURATION_FAIL_TOLERANCE:
            escalate("fail")
            findings.append(
                f"runs {duration:.1f}s against an expected {exp_dur:.1f}s "
                f"({rel * 100:.0f}% off — beyond the {T.DURATION_FAIL_TOLERANCE * 100:.0f}% limit)"
            )
        elif rel > T.DURATION_FLAG_TOLERANCE:
            escalate("flag")
            findings.append(
                f"runs {duration:.1f}s against an expected {exp_dur:.1f}s ({rel * 100:.0f}% off)"
            )

    exp_fps = float(expected.get("fps") or 0.0)
    if exp_fps > 0 and fps > 0 and not within_tolerance(fps, exp_fps, T.FPS_MISMATCH_TOLERANCE):
        escalate("flag")
        findings.append(f"is {fps:.3f} fps against an expected {exp_fps:.3f} fps")

    exp_w = int(expected.get("width") or 0)
    exp_h = int(expected.get("height") or 0)
    if exp_w > 0 and exp_h > 0 and width > 0 and height > 0:
        exp_aspect = exp_w / exp_h
        aspect = width / height
        if not within_tolerance(aspect, exp_aspect, T.ASPECT_MISMATCH_TOLERANCE):
            escalate("fail")
            findings.append(
                f"is {width}x{height} ({aspect:.3f}:1) against an expected "
                f"{exp_w}x{exp_h} ({exp_aspect:.3f}:1) — the framing cannot be matched in the edit"
            )
        elif width < exp_w * T.RESOLUTION_FLOOR_TOLERANCE or height < exp_h * T.RESOLUTION_FLOOR_TOLERANCE:
            escalate("flag")
            findings.append(f"is {width}x{height}, below the expected {exp_w}x{exp_h}")

    # -- frozen / black head and tail ----------------------------------------
    def _run_report(frames: list[np.ndarray], label: str) -> None:
        nonlocal verdict
        if len(frames) < 2:
            return
        identical = 0
        quiet = 0
        for a, b in zip(frames, frames[1:]):
            bit, soft = is_frozen_pair(a, b)
            identical += int(bit)
            quiet += int(soft)
        pairs = len(frames) - 1
        details[f"{label}IdenticalPairs"] = identical
        details[f"{label}QuietPairs"] = quiet
        if identical >= pairs:
            escalate("flag")
            findings.append(
                f"frozen frames at {label} — the first {len(frames)} frames are bit-identical "
                "(decoder or generation freeze, not a static shot)"
            )
        elif quiet >= pairs:
            escalate("flag")
            findings.append(
                f"frozen frames at {label} — no measurable change across {len(frames)} frames"
            )
        lumas = [float(to_gray(f).mean()) for f in frames]
        details[f"{label}MeanLuma"] = round(float(np.mean(lumas)), 2)
        if float(np.mean(lumas)) < T.BLACK_LUMA_THRESHOLD:
            escalate("flag")
            findings.append(
                f"black frames at {label} (mean luma {float(np.mean(lumas)):.1f}/255)"
            )

    _run_report(head, "head")
    _run_report(tail, "tail")

    # -- advisories: sharpness, noise, blockiness, clipping -------------------
    if sharp_series:
        vals = np.array([v for _t, v in sharp_series])
        med = float(np.median(vals))
        details["sharpnessMedian"] = round(med, 2)
        details["sharpnessMin"] = round(float(vals.min()), 2)
        details["sharpnessAnalysisLongEdge"] = T.SHARPNESS_ANALYSIS_LONG_EDGE
        soft_idx = np.flatnonzero(vals < max(T.SHARPNESS_NORMALIZED_SOFT, med * T.SHARPNESS_COLLAPSE_RATIO))
        details["softWindows"] = int(soft_idx.size)
        if med < T.SHARPNESS_NORMALIZED_SOFT:
            advisories.append(f"the whole take is soft (sharpness {med:.0f}, below {T.SHARPNESS_NORMALIZED_SOFT:.0f})")
        elif soft_idx.size:
            times = ", ".join(f"{sharp_series[int(i)][0]:.1f}s" for i in soft_idx[:3])
            advisories.append(
                f"sharpness collapses at {times} (to {float(vals[soft_idx].min()):.0f} "
                f"against a clip median of {med:.0f})"
            )

    if noise_vals:
        nmed = float(np.median(noise_vals))
        details["noiseSigma"] = round(nmed, 3)
        if nmed > T.NOISE_WARN:
            advisories.append(f"heavy sensor-style noise (sigma {nmed:.1f})")
        elif nmed > T.NOISE_GRAIN:
            advisories.append(f"noticeable noise (sigma {nmed:.1f})")

    if block_vals:
        bmed = float(np.median(block_vals))
        details["blockiness"] = round(bmed, 3)
        if bmed > T.BLOCKINESS_FAIL:
            advisories.append(f"heavy macroblocking (boundary ratio {bmed:.2f})")
        elif bmed > T.BLOCKINESS_WARN:
            advisories.append(f"visible compression blocking (boundary ratio {bmed:.2f})")

    if clip_hi_vals:
        hi = float(np.median(clip_hi_vals))
        lo = float(np.median(clip_lo_vals))
        details["clipHigh"] = round(hi, 4)
        details["clipLow"] = round(lo, 4)
        # Never a verdict change on its own — a white studio background
        # legitimately clips 56% of samples (RAS §Technical.5).
        if hi > T.CLIP_HI_FLAG:
            advisories.append(
                f"{hi * 100:.0f}% of samples are clipped highlights (check whether this is a "
                "blown sky/background rather than exposure error)"
            )
        elif hi > T.CLIP_HI_WARN:
            advisories.append(f"{hi * 100:.1f}% clipped highlights")
        if lo > T.CLIP_LO_FLAG:
            advisories.append(f"{lo * 100:.0f}% of samples are crushed shadows")
        elif lo > T.CLIP_LO_WARN:
            advisories.append(f"{lo * 100:.1f}% crushed shadows")

    # -- assemble -------------------------------------------------------------
    if findings:
        reason = "; ".join(findings[:3])
    else:
        reason = (
            f"conforms ({duration:.1f}s, {fps:.2f} fps, {width}x{height}, "
            f"{probe_info.get('codec', 'unknown')})"
        )
    if advisories:
        reason = f"{reason} — {'; '.join(advisories[:2])}"

    if verdict == "fail":
        score = min(T.OVERALL_FAIL_CAP, 100 - 25 * len(findings))
    elif verdict == "flag":
        score = max(50, 90 - 12 * len(findings))
    else:
        score = 100 - min(8, 3 * len(advisories))
    score = int(max(0, min(100, score)))

    evidence_frames: list[dict[str, Any]] = []
    if verdict != "pass" and any("head" in f for f in findings):
        evidence_frames.append({"frame": 0, "t": 0.0, "caption": "head of clip"})
    if verdict != "pass" and any("tail" in f for f in findings) and n_frames > 1:
        last = n_frames - 1
        evidence_frames.append(
            {
                "frame": last,
                "t": round(last / fps, 3) if fps > 0 else 0.0,
                "caption": "tail of clip",
            }
        )

    details["advisories"] = advisories
    return {
        "verdict": verdict,
        "score": score,
        "reason": reason,
        "evidence_frames": evidence_frames,
        "details": details,
    }
