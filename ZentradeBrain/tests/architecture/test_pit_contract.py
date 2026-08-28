"""Point-in-time access must be structurally impossible to bypass."""
import inspect

import pytest

from zentrade.adapters.data import pit
from zentrade.adapters.data.pit import InMemoryPitSource, PitDataSource, SpinePitSource

SOURCES = [SpinePitSource, InMemoryPitSource]
ACCESS_METHODS = ["bars_before", "symbols_before"]


@pytest.mark.parametrize("source", SOURCES)
@pytest.mark.parametrize("method", ACCESS_METHODS)
def test_as_of_is_required_and_keyword_only(source, method):
    signature = inspect.signature(getattr(source, method))
    assert "as_of" in signature.parameters, f"{source.__name__}.{method} has no as_of"
    parameter = signature.parameters["as_of"]
    assert parameter.default is inspect.Parameter.empty, "as_of must have no default"
    assert parameter.kind is inspect.Parameter.KEYWORD_ONLY, (
        "as_of must be keyword-only so it cannot be supplied positionally by accident"
    )


def test_sources_satisfy_the_protocol(tmp_path):
    """isinstance, not issubclass: the protocol carries a data attribute."""
    import pyarrow as pa
    from zentrade.spine.semantics import BAR_SCHEMA

    instances = [
        SpinePitSource(tmp_path),
        InMemoryPitSource(BAR_SCHEMA.empty_table()),
    ]
    for instance in instances:
        assert isinstance(instance, PitDataSource), type(instance).__name__


def test_engine_and_replay_never_import_the_raw_reader():
    """read_bars is the unbounded primitive. The PIT source wraps it; anything."""
    import ast
    from pathlib import Path

    src = Path(__file__).resolve().parents[2] / "src" / "zentrade"
    offenders = []
    for package in ("features", "replay"):
        for path in (src / package).rglob("*.py"):
            tree = ast.parse(path.read_text())
            for node in ast.walk(tree):
                if isinstance(node, ast.ImportFrom) and node.module:
                    if node.module.endswith("spine.reader"):
                        offenders.append(f"{path.relative_to(src)} imports {node.module}")
                    for alias in node.names:
                        if alias.name in ("read_bars", "universe_on"):
                            offenders.append(f"{path.relative_to(src)} imports {alias.name}")
    assert offenders == [], (
        "downstream code must go through PitDataSource:\n  " + "\n  ".join(offenders)
    )


def test_pit_source_methods_all_bound_by_as_of():
    """Every public access method on the module's own sources takes an as_of."""
    offenders = []
    for source in SOURCES:
        for name, member in inspect.getmembers(source, inspect.isfunction):
            if name.startswith("_"):
                continue
            if "as_of" not in inspect.signature(member).parameters:
                offenders.append(f"{source.__name__}.{name}")
    assert offenders == [], f"unbounded access methods: {offenders}"
