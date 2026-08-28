"""Ingest cached Fyers intraday candles into the spine."""

from __future__ import annotations

import sys
from dataclasses import dataclass
from pathlib import Path

import zentrade

from ...spine.semantics import INTRADAY_GRANULARITIES
from ...spine.writer import write_bars
from .fyers_intraday import ParseReport, load_cache, session_completeness

VENUE = "NSE"


@dataclass(frozen=True)
class IngestResult:
    granularity: str
    parse: ParseReport
    inserted: int
    replaced: int
    partitions: int
    completeness: dict

    def summary(self) -> str:
        return (f"{self.granularity}: {self.parse.rows:,} rows -> "
                f"inserted {self.inserted:,}, replaced {self.replaced:,}, "
                f"{self.partitions} partition(s)")


def ingest(cache_dir: Path, spine_base: Path, granularity: str) -> IngestResult:
    rows, parse = load_cache(cache_dir, granularity)
    result = write_bars(spine_base, VENUE, granularity, rows)
    return IngestResult(
        granularity=granularity, parse=parse,
        inserted=result.inserted, replaced=result.replaced,
        partitions=result.partitions,
        completeness=session_completeness(rows, granularity),
    )


def main(argv: list[str]) -> int:
    root = Path(zentrade.__file__).resolve().parents[2]
    cache_dir = root / "data" / "cache" / "intraday"
    spine_base = root / "data" / "spine"
    targets = argv[1:] or list(INTRADAY_GRANULARITIES)

    print(f"intraday ingest  cache {cache_dir}")
    for granularity in targets:
        result = ingest(cache_dir, spine_base, granularity)
        print(f"  {result.summary()}")
        print(f"     parse: {result.parse.summary()}")
        c = result.completeness
        print(f"     sessions: {c['symbol_sessions']} symbol-sessions, "
              f"min {c['min']} max {c['max']} expected {c['expected']}, "
              f"short {len(c['short'])}, over {len(c['over'])}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
