"""P2 acceptance verification."""
from __future__ import annotations

import inspect
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import pyarrow as pa

from zentrade.adapters.data.pit import InMemoryPitSource, SpinePitSource
from zentrade.features.engine import compute_features
from zentrade.features.schema import SchemaMismatch, require_schema, schema_hash
from zentrade.replay.harness import (
    replay_digest, run_replay, session_timestamps, snapshot_digest,
)

ROOT = Path(__file__).resolve().parents[1]
SPINE = ROOT / "data" / "spine"
results: list[tuple[str, bool, str]] = []


def check(name: str, passed: bool, detail: str = "") -> None:
    results.append((name, passed, detail))
    print(f"  [{'PASS' if passed else 'FAIL'}] {name}" + (f"  -- {detail}" if detail else ""),
          flush=True)


def main() -> int:
    print("=" * 74)
    print("P2 ACCEPTANCE VERIFICATION")
    print("=" * 74)

    source = SpinePitSource(SPINE)
    stamps = session_timestamps(date(2026, 7, 1), date(2026, 8, 21))
    symbols = ["RELIANCE", "TCS", "HDFCBANK", "INFY", "SBIN", "ICICIBANK"]

    print("\n[1] Deterministic replay")
    first = run_replay(source, stamps, symbols)
    second = run_replay(SpinePitSource(SPINE), stamps, symbols)
    check("repeated runs give an identical digest",
          replay_digest(first) == replay_digest(second),
          f"{len(first)} snapshots, {first.rows} rows")
    check("digest is stable across fresh source objects",
          replay_digest(first) == replay_digest(second))

    print("\n[2] as_of required on every PIT access")
    offenders = []
    for cls in (SpinePitSource, InMemoryPitSource):
        for name, member in inspect.getmembers(cls, inspect.isfunction):
            if name.startswith("_"):
                continue
            parameter = inspect.signature(member).parameters.get("as_of")
            if parameter is None or parameter.default is not inspect.Parameter.empty \
                    or parameter.kind is not inspect.Parameter.KEYWORD_ONLY:
                offenders.append(f"{cls.__name__}.{name}")
    check("as_of is required and keyword-only everywhere", offenders == [],
          f"offenders: {offenders}" if offenders else "2 sources checked")

    print("\n[3] Point-in-time boundary")
    as_of = stamps[len(stamps) // 2]
    table = source.bars_before(as_of=as_of, symbols=symbols, lookback_sessions=300)
    latest = max(table.column("ts_utc").to_pylist())
    check("no bar at or after as_of is returned", latest < as_of,
          f"latest {latest} < as_of {as_of}")

    full = source.bars_before(as_of=stamps[-1], symbols=symbols, lookback_sessions=400)
    truncated = InMemoryPitSource(full)
    a = compute_features(source, as_of=as_of, symbols=symbols)
    b = compute_features(truncated, as_of=as_of, symbols=symbols)
    check("future bars do not change past features",
          snapshot_digest(a) == snapshot_digest(b), f"{len(a)} symbols compared")

    print("\n[4] Feature-schema hash")
    check("hash is stable", schema_hash() == schema_hash(), schema_hash()[:24] + "...")
    try:
        require_schema("0" * 64)
        mismatched = False
    except SchemaMismatch:
        mismatched = True
    check("mismatched schema fails closed", mismatched)
    check("snapshot carries the schema hash", a.schema_hash == schema_hash())

    print("\n[5] Canonical engine shared across adapters")
    check("spine and in-memory adapters agree",
          snapshot_digest(a) == snapshot_digest(b))
    parameters = set(inspect.signature(compute_features).parameters)
    check("engine takes no mode parameter",
          not ({"mode", "live", "paper", "replay", "is_backtest"} & parameters),
          f"signature: {sorted(parameters)}")

    print("\n[6] No wall-clock leakage")
    import ast
    src = ROOT / "src" / "zentrade"
    banned = ("datetime.now", "datetime.utcnow", "datetime.today", "date.today", "time.time")

    def dotted(node):
        parts = []
        while isinstance(node, ast.Attribute):
            parts.append(node.attr)
            node = node.value
        if isinstance(node, ast.Name):
            parts.append(node.id)
        return ".".join(reversed(parts))

    leaks = []
    for path in src.rglob("*.py"):
        if path.as_posix().endswith("kernel/clock.py"):
            continue
        for node in ast.walk(ast.parse(path.read_text())):
            if isinstance(node, ast.Call):
                name = dotted(node.func)
                if any(name == b or name.endswith("." + b) for b in banned):
                    leaks.append(f"{path.relative_to(src)}:{node.lineno}")
    check("no wall-clock read outside kernel/clock", leaks == [], f"{len(leaks)} leaks")

    print("\n" + "=" * 74)
    failed = [n for n, ok, _ in results if not ok]
    print(f"P2 CRITERIA: {len(results) - len(failed)}/{len(results)} passed")
    for n in failed:
        print(f"  - {n}")
    print("=" * 74)
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
