"""Circle Take gate engine — local QC scoring for AI-generated video takes.

Worker CLI: ``python -m circletake_gate <command>``. All machine-readable output
is line-JSON on stdout (see :mod:`circletake_gate.protocol`); diagnostics go to
stderr and are never parsed by the host app.
"""

ENGINE_VERSION = "1.0.0"

__all__ = ["ENGINE_VERSION"]
