"""Runtime model downloads — sha256-pinned, atomic, offline-friendly.

House rule (AGENTS.md #5): weights are never committed and never fetched from a
non-pinned URL.

TRAP (RT §Pinned model downloads): the opencv_zoo ONNX files are Git-LFS
pointers. ``raw.githubusercontent.com`` serves the 131-byte pointer text, not the
model — the download "succeeds" and the ONNX loader fails later with a confusing
parse error. ``media.githubusercontent.com/media/...`` serves the real object.
Size AND sha256 are both verified after every download, and a mismatched file is
deleted rather than cached.

The opencv_zoo URLs pin commit 47534e27c9851bb1128ccc0102f1145e27f23f98
(repo HEAD at 2026-07-24, verified serving the exact expected byte counts).
Even so, the sha256 is the real integrity gate: a moved pin can only ever cause a
clean, explained failure, never a silently wrong model.
"""

from __future__ import annotations

import hashlib
import os
import shutil
import ssl
import sys
import tempfile
import urllib.error
import urllib.request
from dataclasses import dataclass

from . import protocol


def _ssl_context() -> ssl.SSLContext | None:
    """TLS context backed by certifi's CA bundle when available.

    A stock python.org CPython on macOS ships NO system CA store, so every
    HTTPS model download fails with CERTIFICATE_VERIFY_FAILED unless a bundle is
    supplied explicitly (verified on this machine: the default context fails,
    a certifi-backed one succeeds). certifi is a hard dependency of mediapipe,
    which is in our pinned requirement set, so it is always present in a correct
    install; the fallback keeps a mediapipe-less environment working against a
    properly configured system store.

    Verification is never disabled — an unverifiable download is a failed
    download, and the sha256 pin is checked regardless.
    """
    try:
        import certifi

        return ssl.create_default_context(cafile=certifi.where())
    except Exception:  # pragma: no cover - environment dependent
        return None

OPENCV_ZOO_COMMIT = "47534e27c9851bb1128ccc0102f1145e27f23f98"
_ZOO_BASE = f"https://media.githubusercontent.com/media/opencv/opencv_zoo/{OPENCV_ZOO_COMMIT}/models"

DOWNLOAD_TIMEOUT_SEC = 300


@dataclass(frozen=True)
class ModelSpec:
    key: str
    filename: str
    url: str
    sha256: str
    size: int
    version: str
    license: str
    #: True when upstream serves this from a rolling '/latest/' path, so the hash
    #: may change without notice. Mismatch warns and degrades instead of failing.
    rolling: bool = False


YUNET = ModelSpec(
    key="yunet",
    filename="face_detection_yunet_2023mar.onnx",
    url=f"{_ZOO_BASE}/face_detection_yunet/face_detection_yunet_2023mar.onnx",
    sha256="8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4",
    size=232589,
    version="2023mar",
    license="MIT",
)

SFACE = ModelSpec(
    key="sface",
    filename="face_recognition_sface_2021dec.onnx",
    url=f"{_ZOO_BASE}/face_recognition_sface/face_recognition_sface_2021dec.onnx",
    sha256="0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79",
    size=38696353,
    version="2021dec",
    license="Apache-2.0",
)

HAND_LANDMARKER = ModelSpec(
    key="hand_landmarker",
    filename="hand_landmarker.task",
    # RESEARCH-anatomy-supplement.md §Anatomy.1: pin '/1/', NOT '/latest/'. For
    # some MediaPipe models the two paths are DIFFERENT bytes; '/1/' is
    # immutable. Verified 2026-07-24: '/1/' serves 7,819,105 B with exactly the
    # sha256 pinned in RESEARCH-tech.md, so this is a strictly safer URL for the
    # same artifact.
    url=(
        "https://storage.googleapis.com/mediapipe-models/hand_landmarker/"
        "hand_landmarker/float16/1/hand_landmarker.task"
    ),
    sha256="fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1",
    size=7819105,
    version="float16-1",
    license="Apache-2.0",
    # Kept True purely as a degradation policy: anatomy must never take a gate
    # run down (Windows MediaPipe risk, RT §Dependency set). With the '/1/' pin a
    # hash mismatch is no longer expected.
    rolling=True,
)

MODELS: dict[str, ModelSpec] = {m.key: m for m in (YUNET, SFACE, HAND_LANDMARKER)}


class ModelError(RuntimeError):
    """Download failed, or the fetched bytes did not match the pin."""


def default_cache_dir() -> str:
    """Platform cache dir under 'CircleTake/models'.

    Must stay outside iCloud-synced paths (SPEC non-negotiables): every candidate
    below is a local, non-synced location.
    """
    env = os.environ.get("CIRCLETAKE_CACHE_DIR")
    if env:
        return os.path.join(env, "models")
    home = os.path.expanduser("~")
    if sys.platform == "darwin":
        base = os.path.join(home, "Library", "Application Support")
    elif os.name == "nt":
        base = os.environ.get("LOCALAPPDATA") or os.path.join(home, "AppData", "Local")
    else:
        base = os.environ.get("XDG_CACHE_HOME") or os.path.join(home, ".cache")
    return os.path.join(base, "CircleTake", "models")


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _verify(path: str, spec: ModelSpec) -> tuple[bool, str]:
    """Return (ok, detail). Size is checked first — it catches the LFS-pointer
    trap instantly without hashing 38 MB."""
    actual_size = os.path.getsize(path)
    if actual_size != spec.size:
        if actual_size < 1000:
            return False, (
                f"got {actual_size} bytes, expected {spec.size}. This is almost "
                "certainly a Git-LFS pointer file rather than the model — the "
                "download URL must be media.githubusercontent.com, not raw."
            )
        return False, f"size {actual_size} != expected {spec.size}"
    actual_sha = sha256_file(path)
    if actual_sha != spec.sha256:
        return False, f"sha256 {actual_sha} != expected {spec.sha256}"
    return True, "ok"


def _download(spec: ModelSpec, dest: str, progress: bool) -> None:
    """Fetch to a temp file in the destination dir, verify, then atomically rename."""
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    fd, tmp = tempfile.mkstemp(
        dir=os.path.dirname(dest), prefix=f".{spec.filename}.", suffix=".part"
    )
    os.close(fd)
    try:
        req = urllib.request.Request(spec.url, headers={"User-Agent": "CircleTake/1.0"})
        with urllib.request.urlopen(
            req, timeout=DOWNLOAD_TIMEOUT_SEC, context=_ssl_context()
        ) as resp:
            total = spec.size
            read = 0
            last_pct = -10.0
            with open(tmp, "wb") as out:
                while True:
                    chunk = resp.read(1 << 18)
                    if not chunk:
                        break
                    out.write(chunk)
                    read += len(chunk)
                    if progress and total:
                        pct = 100.0 * read / total
                        if pct - last_pct >= 10.0:
                            last_pct = pct
                            protocol.emit(
                                "models", pct, f"downloading {spec.filename} {pct:.0f}%"
                            )
        ok, detail = _verify(tmp, spec)
        if not ok:
            os.unlink(tmp)
            raise ModelError(
                f"{spec.filename} failed integrity check ({detail}). "
                f"Source: {spec.url}"
            )
        os.replace(tmp, dest)
    except urllib.error.URLError as exc:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise ModelError(
            f"could not download {spec.filename}: {exc}. Circle Take is offline-"
            f"friendly — place the file at {dest} manually to run without network."
        ) from exc
    except Exception:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def ensure_model(spec: ModelSpec, cache_dir: str | None = None, progress: bool = True) -> str:
    """Return a local path to a verified copy of ``spec``, downloading if needed.

    Raises :class:`ModelError` on any integrity failure, except for a
    ``rolling`` spec whose bytes are intact but whose hash has moved upstream —
    that warns on stderr and returns the path, so anatomy can degrade to 'skip'
    downstream rather than taking the whole gate run down.
    """
    cache_dir = cache_dir or default_cache_dir()
    dest = os.path.join(cache_dir, spec.filename)

    if os.path.isfile(dest):
        ok, detail = _verify(dest, spec)
        if ok:
            return dest
        if spec.rolling:
            protocol.log(
                f"warning: cached {spec.filename} does not match the pinned hash "
                f"({detail}); upstream '/latest/' may have rolled. Using it anyway."
            )
            return dest
        protocol.log(f"cached {spec.filename} is invalid ({detail}); re-downloading")
        os.unlink(dest)

    if progress:
        protocol.emit("models", 0.0, f"fetching {spec.filename} ({spec.size / 1e6:.1f} MB)")
    try:
        _download(spec, dest, progress)
    except ModelError:
        if spec.rolling and os.path.isfile(dest):
            protocol.log(
                f"warning: {spec.filename} hash moved upstream; keeping the "
                "downloaded file and letting the caller decide."
            )
            return dest
        raise
    return dest


def ensure_rolling_model(spec: ModelSpec, cache_dir: str | None = None) -> tuple[str | None, str | None]:
    """Best-effort fetch for a rolling spec.

    Returns ``(path, warning)``. On any failure returns ``(None, reason)`` so the
    caller can emit verdict 'skip' rather than crashing — the Windows MediaPipe
    risk (RT: upstream #6187) and a rolled '/latest/' hash both land here.
    """
    cache_dir = cache_dir or default_cache_dir()
    dest = os.path.join(cache_dir, spec.filename)
    try:
        if not os.path.isfile(dest):
            protocol.emit("models", 0.0, f"fetching {spec.filename}")
            _download(spec, dest, progress=True)
            return dest, None
        ok, detail = _verify(dest, spec)
        if ok:
            return dest, None
        warn = (
            f"{spec.filename} does not match the pinned sha256 ({detail}); the "
            "upstream '/latest/' path may have rolled"
        )
        protocol.log(f"warning: {warn}")
        return dest, warn
    except ModelError as exc:
        protocol.log(f"warning: {exc}")
        return None, str(exc)
    except Exception as exc:  # pragma: no cover - defensive
        protocol.log(f"warning: unexpected error fetching {spec.filename}: {exc}")
        return None, str(exc)


def clear_cache(cache_dir: str | None = None) -> None:
    """Remove the whole model cache (used by tests and the host's reset action)."""
    cache_dir = cache_dir or default_cache_dir()
    if os.path.isdir(cache_dir):
        shutil.rmtree(cache_dir)
