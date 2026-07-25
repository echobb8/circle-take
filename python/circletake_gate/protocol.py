"""Line-JSON worker protocol.

The host (Electron main) parses stdout line by line with ``parseWorkerLine``
(src/shared/types.ts). Only these three message shapes are ever written to
stdout::

    {"type":"progress","stage":str,"pct":float,"note":str?}
    {"type":"done","result":any?}
    {"type":"error","message":str}

Anything else — warnings, tracebacks, library chatter — goes to stderr via
:func:`log`. Never ``print()`` inside this package.
"""

from __future__ import annotations

import json
import sys
from typing import Any


def _write(payload: dict[str, Any]) -> None:
    """Serialize one message as a single stdout line and flush immediately."""
    sys.stdout.write(json.dumps(payload, ensure_ascii=False, default=_fallback) + "\n")
    sys.stdout.flush()


def _fallback(obj: Any) -> Any:
    """JSON fallback so a stray numpy scalar can never break the protocol."""
    if hasattr(obj, "item"):
        try:
            return obj.item()
        except Exception:  # pragma: no cover - defensive
            pass
    if hasattr(obj, "tolist"):
        try:
            return obj.tolist()
        except Exception:  # pragma: no cover - defensive
            pass
    return str(obj)


def emit(stage: str, pct: float, note: str | None = None) -> None:
    """Emit a progress message. ``pct`` is clamped to 0-100."""
    msg: dict[str, Any] = {
        "type": "progress",
        "stage": stage,
        "pct": round(float(max(0.0, min(100.0, pct))), 2),
    }
    if note:
        msg["note"] = note
    _write(msg)


def done(result: Any = None) -> None:
    """Emit the terminal success message."""
    msg: dict[str, Any] = {"type": "done"}
    if result is not None:
        msg["result"] = result
    _write(msg)


def error(message: str) -> None:
    """Emit the terminal failure message."""
    _write({"type": "error", "message": str(message)})


def log(*parts: Any) -> None:
    """Diagnostics to stderr. Host logs this but never parses it."""
    sys.stderr.write(" ".join(str(p) for p in parts) + "\n")
    sys.stderr.flush()
