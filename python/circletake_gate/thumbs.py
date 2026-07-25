"""Poster, filmstrip, and evidence-frame extraction via ffmpeg."""

from __future__ import annotations

import os
import subprocess

from . import thresholds as T
from .probe import ProbeError, find_tool, probe


class ThumbError(RuntimeError):
    """ffmpeg missing or an extraction produced no file."""


def _run(cmd: list[str]) -> None:
    out = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
    if out.returncode != 0:
        raise ThumbError(f"ffmpeg failed ({out.returncode}): {out.stderr.strip()[-400:]}")


def _extract_at(ffmpeg: str, media: str, t: float, width: int, dest: str, quality: int = 3) -> None:
    """Extract one frame at time ``t``. Input-side seek (fast, keyframe-accurate)."""
    cmd = [
        ffmpeg, "-nostdin", "-y",
        "-ss", f"{max(0.0, t):.4f}",
        "-i", media,
        "-frames:v", "1",
        "-vf", f"scale={width}:-2:flags=lanczos",
        "-q:v", str(quality),
        dest,
    ]
    _run(cmd)
    if not os.path.isfile(dest):
        raise ThumbError(f"ffmpeg produced no output for t={t:.3f}s of {media}")


def make_thumbs(media: str, out_dir: str, count: int = T.STRIP_COUNT) -> dict[str, object]:
    """Write poster.jpg (25% of duration, 640w) and strip_0..N-1.jpg (240w).

    Returns {'poster': path, 'strip': [paths], 'durationSec': float}.
    """
    ffmpeg = find_tool("ffmpeg")
    info = probe(media)
    duration = float(info["durationSec"])
    if duration <= 0:
        raise ThumbError(f"cannot make thumbnails: zero duration for {media}")
    os.makedirs(out_dir, exist_ok=True)

    poster = os.path.join(out_dir, "poster.jpg")
    _extract_at(ffmpeg, media, duration * T.POSTER_POSITION, T.POSTER_WIDTH, poster, quality=2)

    strip: list[str] = []
    n = max(1, int(count))
    for i in range(n):
        # Evenly spaced across the interior; never the literal first/last frame,
        # which are often fades or black.
        frac = (i + 0.5) / n
        dest = os.path.join(out_dir, f"strip_{i}.jpg")
        _extract_at(ffmpeg, media, duration * frac, T.STRIP_WIDTH, dest)
        strip.append(dest)

    return {"poster": poster, "strip": strip, "durationSec": duration}


def extract_frames(
    media: str,
    frames: list[int],
    out_dir: str,
    fps: float | None = None,
    width: int = T.EVIDENCE_WIDTH,
) -> list[dict[str, object]]:
    """Extract specific frame indices as ``f%06d.jpg`` JPEGs at ``width``.

    Frame-accurate: we seek to just before the target and use the ``select``
    filter on the exact frame number, because an input-side seek alone lands on
    the nearest keyframe and would mislabel evidence on long-GOP media.

    Returns [{'frame': int, 't': float, 'image': abspath}] in input order,
    silently skipping frames ffmpeg could not produce.
    """
    if not frames:
        return []
    ffmpeg = find_tool("ffmpeg")
    if fps is None or fps <= 0:
        try:
            fps = float(probe(media)["fps"])
        except ProbeError:
            fps = 0.0
    os.makedirs(out_dir, exist_ok=True)

    results: list[dict[str, object]] = []
    for idx in frames:
        idx = max(0, int(idx))
        t = idx / fps if fps and fps > 0 else 0.0
        dest = os.path.join(out_dir, f"f{idx:06d}.jpg")
        if os.path.isfile(dest):
            results.append({"frame": idx, "t": round(t, 4), "image": dest})
            continue
        # Seek a short way back, then pick the exact frame by number.
        seek = max(0.0, t - 1.0)
        seek_frame = int(round(seek * fps)) if fps and fps > 0 else 0
        rel = max(0, idx - seek_frame)
        cmd = [
            ffmpeg, "-nostdin", "-y",
            "-ss", f"{seek:.4f}",
            "-i", media,
            "-vf", f"select=eq(n\\,{rel}),scale={width}:-2:flags=lanczos",
            "-vsync", "0",
            "-frames:v", "1",
            "-q:v", "2",
            dest,
        ]
        try:
            _run(cmd)
        except ThumbError:
            # Fall back to a plain timestamp seek rather than losing the evidence.
            try:
                _extract_at(ffmpeg, media, t, width, dest, quality=2)
            except ThumbError:
                continue
        if os.path.isfile(dest):
            results.append({"frame": idx, "t": round(t, 4), "image": dest})
    return results
