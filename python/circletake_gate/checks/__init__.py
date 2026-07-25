"""Gate checks. Each module exposes ``run(...) -> dict`` shaped like CheckReport
(src/shared/types.ts) plus engine-internal keys that report.py strips."""

from __future__ import annotations

CHECK_IDS = ("identity", "temporal", "anatomy", "continuity", "conformance")

__all__ = ["CHECK_IDS"]
