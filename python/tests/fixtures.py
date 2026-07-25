"""Synthetic clip generators with INJECTED defects.

SPEC "definition of done" requires that generated fixtures with injected defects
are flagged and that the clean fixture passes. These builders use cv2.VideoWriter
with the mp4v fourcc (available in every opencv-contrib wheel, no ffmpeg
dependency) so the fast test suite never touches the network or a model.

Every clip is built from the same textured base so the checks see realistic
gradient content rather than flat colour — flat frames make optical flow
degenerate and would let a broken warp metric pass.
"""

from __future__ import annotations

import os

import cv2
import numpy as np

WIDTH = 320
HEIGHT = 240
FPS = 24.0
FOURCC = cv2.VideoWriter_fourcc(*"mp4v")


def _texture(width: int = WIDTH * 3, height: int = HEIGHT * 2, seed: int = 7) -> np.ndarray:
    """A large, high-frequency textured plate to pan across."""
    rng = np.random.default_rng(seed)
    base = rng.integers(40, 200, size=(height, width, 3), dtype=np.uint8)
    base = cv2.GaussianBlur(base, (7, 7), 0)
    # Add structure so optical flow has something to lock onto.
    for i in range(0, width, 37):
        cv2.line(base, (i, 0), (i + 60, height), (230, 210, 180), 2)
    for j in range(0, height, 29):
        cv2.line(base, (0, j), (width, j + 40), (60, 90, 140), 2)
    for k in range(24):
        cx = int(rng.integers(0, width))
        cy = int(rng.integers(0, height))
        cv2.circle(base, (cx, cy), int(rng.integers(8, 26)), (int(rng.integers(0, 255)),) * 3, -1)
    return base


def _write(path: str, frames: list[np.ndarray], fps: float = FPS) -> str:
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    h, w = frames[0].shape[:2]
    writer = cv2.VideoWriter(path, FOURCC, fps, (w, h))
    if not writer.isOpened():
        raise RuntimeError(f"cv2.VideoWriter could not open {path} (mp4v unavailable?)")
    for f in frames:
        writer.write(f)
    writer.release()
    return path


def _pan_frames(n: int, plate: np.ndarray | None = None, dx: int = 4, brightness: float = 1.0) -> list[np.ndarray]:
    """A clean linear pan across the texture plate."""
    plate = _texture() if plate is None else plate
    frames = []
    for i in range(n):
        x = (i * dx) % max(1, plate.shape[1] - WIDTH)
        crop = plate[0:HEIGHT, x : x + WIDTH].copy()
        if brightness != 1.0:
            crop = np.clip(crop.astype(np.float32) * brightness, 0, 255).astype(np.uint8)
        frames.append(crop)
    return frames


def clean_pan(path: str, seconds: float = 3.0) -> str:
    """A clean pan — must PASS temporal."""
    n = int(seconds * FPS)
    return _write(path, _pan_frames(n))


def luma_flicker(path: str, seconds: float = 3.0, amplitude: float = 0.03, hz: float = 6.0) -> str:
    """A pan with a periodic luma flicker injected — must FLAG temporal.

    Periodic at 6 Hz so the FFT PAR test (RTS §3) confirms it as flicker rather
    than a legitimate exposure change. The amplitude is deliberately modest (3%):
    a large-amplitude flicker also trips the warp-ratio churn detector, which
    would let the flicker path pass its test for the wrong reason.
    """
    n = int(seconds * FPS)
    frames = _pan_frames(n)
    out = []
    for i, f in enumerate(frames):
        gain = 1.0 + amplitude * np.sin(2 * np.pi * hz * i / FPS)
        out.append(np.clip(f.astype(np.float32) * gain, 0, 255).astype(np.uint8))
    return _write(path, out)


def morph_crossfade(path: str, seconds: float = 3.0, fade_frames: int = 3) -> str:
    """A mid-clip crossfade into an unrelated STATIC scene — must FAIL temporal.

    The second scene is static on purpose. Crossfading between two scenes that
    pan at similar rates lets optical flow explain much of the change (measured
    ratio only ~0.3); when the incoming scene does not share the outgoing
    motion, the change becomes genuinely motion-inexplicable and the warp ratio
    goes above 1.0 — the true morph signature.
    """
    n = int(seconds * FPS)
    a = _pan_frames(n, _texture(seed=7))
    still = _texture(seed=99)[0:HEIGHT, 0:WIDTH].copy()
    mid = n // 2
    out = []
    for i in range(n):
        if i < mid:
            out.append(a[i])
        elif i < mid + fade_frames:
            alpha = (i - mid + 1) / (fade_frames + 1)
            out.append(cv2.addWeighted(a[i], 1 - alpha, still, alpha, 0))
        else:
            out.append(still.copy())
    return _write(path, out)


def generative_churn(path: str, seconds: float = 3.0, churn_sec: float = 1.0, seed: int = 3) -> str:
    """A pan with a sustained elastic-warp 'boil' in the middle — must FAIL.

    Per-frame randomized local warping is literally what generative churn is:
    the content stays recognizable but every pixel is re-imagined, so the change
    is large and no coherent motion field explains it. Sustained past
    CHURN_SUSTAIN_SEC, so this exercises the sustained-churn fail path.
    """
    n = int(seconds * FPS)
    frames = _pan_frames(n, _texture(seed=7))
    rng = np.random.default_rng(seed)
    start = n // 2
    end = start + int(churn_sec * FPS)
    out = []
    for i, f in enumerate(frames):
        if start <= i < end:
            h, w = f.shape[:2]
            gx, gy = np.meshgrid(np.arange(w, dtype=np.float32), np.arange(h, dtype=np.float32))
            nx = cv2.GaussianBlur(rng.normal(0, 7, (h, w)).astype(np.float32), (31, 31), 0) * 6
            ny = cv2.GaussianBlur(rng.normal(0, 7, (h, w)).astype(np.float32), (31, 31), 0) * 6
            f = cv2.remap(f, gx + nx, gy + ny, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)
        out.append(f)
    return _write(path, out)


def frozen_tail(path: str, seconds: float = 3.0, freeze_frames: int = 20) -> str:
    """A pan whose last frames are bit-identical duplicates — conformance flags."""
    n = int(seconds * FPS)
    frames = _pan_frames(n - freeze_frames)
    frames += [frames[-1].copy() for _ in range(freeze_frames)]
    return _write(path, frames)


def exposure_pair(dir_path: str, step: float = 1.35) -> tuple[str, str]:
    """Two 'shots' of the same scene at different exposures.

    Returns (shot_a, shot_b); continuity must flag the step between them.
    """
    plate = _texture(seed=21)
    n = int(2.0 * FPS)
    a = os.path.join(dir_path, "shot_a.mp4")
    b = os.path.join(dir_path, "shot_b.mp4")
    _write(a, _pan_frames(n, plate, brightness=1.0))
    _write(b, _pan_frames(n, plate, brightness=step))
    return a, b


def short_clip(path: str, frames: int = 2) -> str:
    """A near-empty clip — temporal must skip rather than crash."""
    return _write(path, _pan_frames(max(1, frames)))


def build_all(out_dir: str) -> dict[str, str]:
    """Build the whole fixture set into ``out_dir``."""
    os.makedirs(out_dir, exist_ok=True)
    a, b = exposure_pair(out_dir)
    return {
        "clean": clean_pan(os.path.join(out_dir, "clean.mp4")),
        "flicker": luma_flicker(os.path.join(out_dir, "flicker.mp4")),
        "morph": morph_crossfade(os.path.join(out_dir, "morph.mp4")),
        "churn": generative_churn(os.path.join(out_dir, "churn.mp4")),
        "frozen": frozen_tail(os.path.join(out_dir, "frozen.mp4")),
        "exposure_a": a,
        "exposure_b": b,
    }


if __name__ == "__main__":  # pragma: no cover - manual fixture generation
    import sys

    target = sys.argv[1] if len(sys.argv) > 1 else "fixtures"
    for name, p in build_all(target).items():
        print(f"{name}: {p}")
