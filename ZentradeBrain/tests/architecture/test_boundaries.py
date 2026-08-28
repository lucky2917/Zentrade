"""
Architecture enforcement. These are release-blocking: they encode the
structural guarantees that Research and Learning cannot trade.
"""
import ast
from pathlib import Path

import pytest

SRC = Path(__file__).resolve().parents[2] / "src" / "zentrade"

FORBIDDEN_IMPORTS = {
    "research": ("zentrade.core", "zentrade.adapters.execution"),
    "learning": ("zentrade.core", "zentrade.adapters.execution"),
}

CLOCK_MODULE = "kernel/clock.py"
# Suffixes, not pairs: datetime.now() and datetime.datetime.now() are both
# wall-clock reads, and an earlier version of this check saw only the first.
BANNED_CLOCK_SUFFIXES = ("datetime.now", "datetime.utcnow", "datetime.today",
                         "date.today", "time.time", "time.monotonic")


def modules():
    return sorted(p for p in SRC.rglob("*.py"))


def resolve(node: ast.AST, module_path: Path) -> list[str]:
    """Absolute dotted names imported by this node, resolving relative imports."""
    if isinstance(node, ast.Import):
        return [a.name for a in node.names]
    if not isinstance(node, ast.ImportFrom):
        return []
    if node.level == 0:
        return [node.module or ""]
    parts = module_path.relative_to(SRC.parent).with_suffix("").parts
    base = list(parts[:-1])
    for _ in range(node.level - 1):
        if base:
            base.pop()
    if node.module:
        base.append(node.module)
    return [".".join(base)]


@pytest.mark.parametrize("package,forbidden", FORBIDDEN_IMPORTS.items())
def test_process_packages_cannot_import_the_trading_core(package, forbidden):
    offenders = []
    for path in (SRC / package).rglob("*.py"):
        tree = ast.parse(path.read_text())
        for node in ast.walk(tree):
            for name in resolve(node, path):
                if any(name == f or name.startswith(f + ".") for f in forbidden):
                    offenders.append(f"{path.relative_to(SRC)} imports {name}")
    assert offenders == [], (
        f"{package} must be structurally unable to trade:\n  " + "\n  ".join(offenders)
    )


def test_kernel_imports_nothing_internal():
    offenders = []
    for path in (SRC / "kernel").rglob("*.py"):
        tree = ast.parse(path.read_text())
        for node in ast.walk(tree):
            for name in resolve(node, path):
                if name.startswith("zentrade.") and not name.startswith("zentrade.kernel"):
                    offenders.append(f"{path.relative_to(SRC)} imports {name}")
    assert offenders == [], "kernel must have no internal dependencies:\n  " + "\n  ".join(offenders)


def dotted(node: ast.AST) -> str:
    """Reconstruct a dotted call target, so datetime.datetime.now resolves fully."""
    parts = []
    while isinstance(node, ast.Attribute):
        parts.append(node.attr)
        node = node.value
    if isinstance(node, ast.Name):
        parts.append(node.id)
    return ".".join(reversed(parts))


def test_no_wall_clock_reads_outside_the_clock_module():
    """Decisions must be reproducible from a FixedClock, which is impossible if
    any module reads the wall clock directly."""
    offenders = []
    for path in modules():
        if path.as_posix().endswith(CLOCK_MODULE):
            continue
        tree = ast.parse(path.read_text())
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            name = dotted(node.func)
            if any(name == s or name.endswith("." + s) for s in BANNED_CLOCK_SUFFIXES):
                offenders.append(f"{path.relative_to(SRC)}:{node.lineno} {name}()")
    assert offenders == [], (
        "wall-clock reads outside kernel/clock.py break replay determinism:\n  " + "\n  ".join(offenders)
    )


def test_broker_credentials_live_in_exactly_one_module():
    secrets = ("FYERS_SECRET_KEY", "FYERS_CLIENT_ID", "ACCESS_TOKEN", "BROKER_SECRET")
    readers = set()
    for path in modules():
        text = path.read_text()
        if any(s in text for s in secrets):
            readers.add(path.relative_to(SRC).as_posix())
    assert readers <= {"core/credentials.py"}, (
        f"broker secrets may only be read in core/credentials.py, found in: {sorted(readers)}"
    )
