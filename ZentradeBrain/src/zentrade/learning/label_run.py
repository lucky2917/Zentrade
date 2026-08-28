"""Driver for a universal shadow-labeling run over the tradeable universe."""

from __future__ import annotations

import sys
import time
from datetime import date, datetime, timezone
from pathlib import Path

import zentrade

from ..adapters.data.pit import SpinePitSource
from ..features.universe import liquidity_screen
from .labeler import LabelSpec, LabelSet, label_digest, label_population


def _ts(day: date) -> int:
    return int(datetime(day.year, day.month, day.day, tzinfo=timezone.utc).timestamp() * 1_000_000)


def run(spine: Path, as_of: date, universe_size: int = 100,
        spec: LabelSpec | None = None, log=print) -> LabelSet:
    source = SpinePitSource(spine)
    screen = liquidity_screen(source, as_of, size=universe_size)
    log(f"  universe: {len(screen)} of {screen.considered:,} symbols considered")

    started = time.perf_counter()
    labels = label_population(source, as_of=_ts(as_of), spec=spec,
                              symbols=list(screen.symbols))
    log(f"  labelled {len(labels):,} in {time.perf_counter() - started:.1f}s")
    return labels


def main(argv: list[str]) -> int:
    root = Path(zentrade.__file__).resolve().parents[2]
    as_of = date.fromisoformat(argv[1]) if len(argv) > 1 else date(2026, 8, 27)
    size = int(argv[2]) if len(argv) > 2 else 100

    print(f"Universal shadow labeling  as_of {as_of}  universe {size}", flush=True)
    labels = run(root / "data" / "spine", as_of, size)

    stamps = [label.decision_ts for label in labels.labels]
    first = datetime.fromtimestamp(min(stamps) / 1e6, tz=timezone.utc).date()
    last = datetime.fromtimestamp(max(stamps) / 1e6, tz=timezone.utc).date()
    print(f"\n  labels        {len(labels):,}")
    print(f"  symbols       {len({l.symbol for l in labels.labels}):,}")
    print(f"  sessions      {len(set(stamps)):,}")
    print(f"  span          {first} .. {last}")
    print(f"  outcomes      {labels.counts()}")
    print(f"  final         {len(labels.final()):,}   pending {len(labels.pending()):,}")
    print(f"  spec hash     {labels.spec_hash[:32]}")
    print(f"  digest        {label_digest(labels)[:32]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
