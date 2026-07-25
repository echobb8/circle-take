"""ffprobe wrapper → ProbeInfo (src/shared/types.ts).

Homebrew's /opt/homebrew/bin is searched before PATH because Electron apps launch
with a login-shell-less environment on macOS and frequently do not inherit it.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from fractions import Fraction
from typing import Any

_BREW_DIRS = ("/opt/homebrew/bin", "/usr/local/bin")


class ProbeError(RuntimeError):
    """ffprobe missing, failed, or produced no usable video stream."""


def find_tool(name: str) -> str:
    """Resolve an ffmpeg-family binary: env override, Homebrew dirs, then PATH."""
    env = os.environ.get(f"CIRCLETAKE_{name.upper()}")
    if env and os.path.isfile(env) and os.access(env, os.X_OK):
        return env
    for d in _BREW_DIRS:
        cand = os.path.join(d, name)
        if os.path.isfile(cand) and os.access(cand, os.X_OK):
            return cand
    found = shutil.which(name)
    if found:
        return found
    raise ProbeError(
        f"{name} not found. Install ffmpeg (macOS: brew install ffmpeg) or set "
        f"CIRCLETAKE_{name.upper()} to its full path."
    )


def _fps_from_rate(rate: str | None) -> float:
    """Parse an ffprobe rational rate string ('24000/1001') into fps."""
    if not rate:
        return 0.0
    try:
        f = Fraction(rate)
    except (ValueError, ZeroDivisionError):
        return 0.0
    if f.denominator == 0:
        return 0.0
    return float(f)


def probe(media_path: str) -> dict[str, Any]:
    """Return {durationSec, fps, width, height, codec} for ``media_path``."""
    if not os.path.isfile(media_path):
        raise ProbeError(f"media file not found: {media_path}")
    ffprobe = find_tool("ffprobe")
    cmd = [
        ffprobe,
        "-v", "error",
        "-print_format", "json",
        "-show_format",
        "-show_streams",
        media_path,
    ]
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    except subprocess.TimeoutExpired as exc:  # pragma: no cover - environmental
        raise ProbeError(f"ffprobe timed out on {media_path}") from exc
    if out.returncode != 0:
        raise ProbeError(f"ffprobe failed ({out.returncode}): {out.stderr.strip()[:400]}")
    try:
        data = json.loads(out.stdout)
    except json.JSONDecodeError as exc:
        raise ProbeError(f"ffprobe returned non-JSON for {media_path}") from exc

    streams = [s for s in data.get("streams", []) if s.get("codec_type") == "video"]
    if not streams:
        raise ProbeError(f"no video stream in {media_path}")
    v = streams[0]

    fps = _fps_from_rate(v.get("r_frame_rate"))
    if fps <= 0:
        fps = _fps_from_rate(v.get("avg_frame_rate"))

    duration = 0.0
    for src in (v.get("duration"), data.get("format", {}).get("duration")):
        try:
            duration = float(src)
            if duration > 0:
                break
        except (TypeError, ValueError):
            continue
    if duration <= 0:
        # Container without a duration header: derive from frame count if present.
        nb = v.get("nb_frames")
        try:
            if nb and fps > 0:
                duration = float(nb) / fps
        except (TypeError, ValueError):
            duration = 0.0

    return {
        "durationSec": round(float(duration), 4),
        "fps": round(float(fps), 6),
        "width": int(v.get("width") or 0),
        "height": int(v.get("height") or 0),
        "codec": str(v.get("codec_name") or "unknown"),
    }
