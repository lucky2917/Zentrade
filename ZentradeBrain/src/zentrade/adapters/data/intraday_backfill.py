"""Ingest cached Fyers intraday candles into the spine."""

from __future__ import annotations

import shutil
import sys
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from pathlib import Path

import zentrade

from ...spine.layout import spine_root
from ...spine.semantics import INTRADAY_GRANULARITIES
from ...spine.writer import write_bars
from .fyers_intraday import ParseReport, iter_cache_files, parse_file

VENUE = "NSE"


def _month_of(ts_utc: int) -> tuple[int, int]:
    moment = datetime.fromtimestamp(ts_utc / 1_000_000, tz=timezone.utc)
    return moment.year, moment.month


def _month_end(month: tuple[int, int]) -> date:
    year, index = month
    return date(year + (index == 12), 1 if index == 12 else index + 1, 1)


@dataclass
class IngestResult:
    granularity: str
    parse: ParseReport = field(default_factory=ParseReport)
    inserted: int = 0
    replaced: int = 0
    partitions: int = 0

    def summary(self) -> str:
        return (f"{self.granularity}: {self.parse.rows:,} rows -> "
                f"inserted {self.inserted:,}, replaced {self.replaced:,}, "
                f"{self.partitions} partition(s)")


def ingest(cache_dir: Path, spine_base: Path, granularity: str, log=None) -> IngestResult:
    """Stream the cache into the spine one month at a time.

    Holding every row would cost tens of gigabytes at 1m across the full
    archive. Cache files are visited oldest window first, so once a file
    starting on F is reached, no month ending before F can gain further rows
    and its partition can be written and released.
    """
    result = IngestResult(granularity=granularity)
    pending: dict[tuple[int, int], list[dict]] = {}
    written: set[tuple[int, int]] = set()

    def flush(month: tuple[int, int]) -> None:
        rows = pending.pop(month)
        outcome = write_bars(spine_base, VENUE, granularity, rows)
        result.inserted += outcome.inserted
        result.replaced += outcome.replaced
        result.partitions += outcome.partitions
        written.add(month)
        if log:
            log(f"    {month[0]}-{month[1]:02d}  {len(rows):,} rows")

    for path, window_start in iter_cache_files(cache_dir, granularity):
        for row in parse_file(path, result.parse):
            pending.setdefault(_month_of(row["ts_utc"]), []).append(row)

        for month in [m for m in pending if _month_end(m) <= window_start]:
            flush(month)

    for month in sorted(pending):
        flush(month)

    return result


def purge(spine_base: Path, granularity: str) -> None:
    """Drop a granularity's partitions so the next ingest rebuilds them.

    write_bars merges incoming rows into whatever a partition already holds, so
    a row the parser has stopped emitting survives a plain re-ingest. Correcting
    a parse rule therefore needs an explicit purge, not another pass.
    """
    if granularity not in INTRADAY_GRANULARITIES:
        raise ValueError(f"refusing to purge {granularity!r}")
    tree = spine_root(spine_base) / "bars" / f"venue={VENUE}" / f"granularity={granularity}"
    if tree.exists():
        shutil.rmtree(tree)


def main(argv: list[str]) -> int:
    root = Path(zentrade.__file__).resolve().parents[2]
    cache_dir = root / "data" / "cache" / "intraday"
    spine_base = root / "data" / "spine"
    args = argv[1:]
    rebuild = "--rebuild" in args
    targets = [a for a in args if not a.startswith("--")] or list(INTRADAY_GRANULARITIES)

    print(f"intraday ingest  cache {cache_dir}"
          + ("  (rebuild: partitions dropped first)" if rebuild else ""), flush=True)
    for granularity in targets:
        print(f"  {granularity}", flush=True)
        if rebuild:
            purge(spine_base, granularity)
        result = ingest(cache_dir, spine_base, granularity,
                        log=lambda m: print(m, flush=True))
        print(f"  {result.summary()}")
        print(f"     parse: {result.parse.summary()}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
