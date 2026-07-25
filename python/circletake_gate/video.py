"""Decode utilities shared by every check.

Doctrine: decode once per pass, at the smallest resolution that still carries the
signal (thresholds.METRIC_MAX_HEIGHT for metrics, COLOR_STAT_SIZE for colour).
Seeking is avoided in favour of sequential ``grab()``-skipping: OpenCV's frame
seek is keyframe-approximate on long-GOP media, which would silently misalign the
per-frame series against the timestamps we report to the UI.
"""

from __future__ import annotations

import math
import os
from collections.abc import Iterator
from typing import Any

import cv2
import numpy as np


class DecodeError(RuntimeError):
    """The container could not be opened or produced zero frames."""


class Clip:
    """Thin cv2.VideoCapture wrapper with the metadata the checks need."""

    def __init__(self, path: str) -> None:
        if not os.path.isfile(path):
            raise DecodeError(f"media file not found: {path}")
        self.path = path
        self.cap = cv2.VideoCapture(path)
        if not self.cap.isOpened():
            raise DecodeError(f"could not open media (unsupported or corrupt): {path}")
        self.fps = float(self.cap.get(cv2.CAP_PROP_FPS) or 0.0)
        if not math.isfinite(self.fps) or self.fps <= 0:
            self.fps = 0.0
        self.width = int(self.cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
        self.height = int(self.cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
        count = int(self.cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        self.frame_count = count if count > 0 else 0

    @property
    def duration_sec(self) -> float:
        if self.fps > 0 and self.frame_count > 0:
            return self.frame_count / self.fps
        return 0.0

    def close(self) -> None:
        try:
            self.cap.release()
        except Exception:  # pragma: no cover - defensive
            pass

    def __enter__(self) -> Clip:
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    def frames(self, stride: int = 1) -> Iterator[tuple[int, float, np.ndarray]]:
        """Yield ``(frame_index, t_seconds, bgr)`` every ``stride`` frames.

        Uses grab()-skip so decode cost is paid only for kept frames while frame
        indices stay exact.
        """
        stride = max(1, int(stride))
        idx = 0
        while True:
            ok = self.cap.grab()
            if not ok:
                break
            if idx % stride == 0:
                ok, frame = self.cap.retrieve()
                if not ok or frame is None:
                    break
                yield idx, self.t_of(idx), frame
            idx += 1

    def t_of(self, frame_index: int) -> float:
        """Timestamp of a frame index using the container fps."""
        return frame_index / self.fps if self.fps > 0 else 0.0

    def read_range(self, start: int, count: int) -> list[np.ndarray]:
        """Read ``count`` frames starting at index ``start`` (BGR, native size)."""
        out: list[np.ndarray] = []
        if start > 0:
            # Seek then verify: on long-GOP media CAP_PROP_POS_FRAMES lands on a
            # keyframe, so we sequentially advance to the exact index.
            self.cap.set(cv2.CAP_PROP_POS_FRAMES, float(start))
            pos = int(self.cap.get(cv2.CAP_PROP_POS_FRAMES) or 0)
            while pos < start:
                if not self.cap.grab():
                    return out
                pos += 1
        for _ in range(max(0, count)):
            ok, frame = self.cap.read()
            if not ok or frame is None:
                break
            out.append(frame)
        return out

    def tail_frames(self, count: int) -> list[np.ndarray]:
        """Last ``count`` frames. Falls back to a full sequential pass when the
        container reports no frame count (webm/vfr)."""
        if self.frame_count > 0:
            start = max(0, self.frame_count - count)
            frames = self.read_range(start, count)
            if frames:
                return frames
        ring: list[np.ndarray] = []
        self.cap.set(cv2.CAP_PROP_POS_FRAMES, 0.0)
        while True:
            ok, frame = self.cap.read()
            if not ok or frame is None:
                break
            ring.append(frame)
            if len(ring) > count:
                ring.pop(0)
        return ring


def downscale_to_height(frame: np.ndarray, max_height: int) -> np.ndarray:
    """Downscale (never upscale) so height <= ``max_height``, preserving aspect."""
    h, w = frame.shape[:2]
    if h <= max_height or h == 0:
        return frame
    scale = max_height / float(h)
    return cv2.resize(
        frame, (max(1, int(round(w * scale))), max_height), interpolation=cv2.INTER_AREA
    )


def downscale_to_width(frame: np.ndarray, width: int) -> np.ndarray:
    """Resize so width == ``width`` exactly, preserving aspect.

    Temporal metrics are resolution-dependent, so the working width is fixed
    rather than capped (RTS §2); small sources are upscaled to keep every
    report's numbers on one scale.
    """
    h, w = frame.shape[:2]
    if w == width or w == 0:
        return frame
    scale = width / float(w)
    interp = cv2.INTER_AREA if scale < 1.0 else cv2.INTER_LINEAR
    return cv2.resize(frame, (width, max(1, int(round(h * scale)))), interpolation=interp)


def to_gray(frame: np.ndarray) -> np.ndarray:
    """BGR (or already-gray) → float32 grayscale in 0-255."""
    if frame.ndim == 2:
        gray = frame
    else:
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    return gray.astype(np.float32)


def color_stat_frame(frame: np.ndarray, size: int) -> np.ndarray:
    """Downsample to ``size`` x ``size`` BGR uint8 for colour statistics."""
    return cv2.resize(frame, (size, size), interpolation=cv2.INTER_AREA)


def temporal_stride(fps: float, max_effective_fps: float) -> int:
    """Frame stride that keeps effective sampling at or below the cap."""
    if fps <= 0 or fps <= max_effective_fps:
        return 1
    return max(1, int(math.floor(fps / max_effective_fps)))


def sample_stride(fps: float, target_fps: float) -> int:
    """Frame stride approximating ``target_fps`` sampling."""
    if fps <= 0 or target_fps <= 0 or fps <= target_fps:
        return 1
    return max(1, int(round(fps / target_fps)))
