"""pytest configuration for the gate engine.

The fast suite must never download a model or touch the network. Tests that do
(real-model integration) are marked ``slow`` and skipped unless ``--runslow`` is
passed.
"""

from __future__ import annotations

import os
import sys

import pytest

# Make the package importable without installing it.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import fixtures as fx  # noqa: E402


def pytest_addoption(parser: pytest.Parser) -> None:
    parser.addoption(
        "--runslow",
        action="store_true",
        default=False,
        help="run slow tests (these DOWNLOAD models and run real inference)",
    )


def pytest_configure(config: pytest.Config) -> None:
    config.addinivalue_line("markers", "slow: downloads models / runs real inference")


def pytest_collection_modifyitems(config: pytest.Config, items: list[pytest.Item]) -> None:
    if config.getoption("--runslow"):
        return
    skip = pytest.mark.skip(reason="needs --runslow (downloads models)")
    for item in items:
        if "slow" in item.keywords:
            item.add_marker(skip)


@pytest.fixture(scope="session")
def clips(tmp_path_factory: pytest.TempPathFactory) -> dict[str, str]:
    """Build the synthetic fixture set once per session."""
    out = tmp_path_factory.mktemp("clips")
    return fx.build_all(str(out))
