"""Idempotent partition writes for the spine."""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path

import polars as pl
import pyarrow.parquet as pq

from .layout import bars_partition
from .semantics import BAR_SCHEMA, SORT_KEY, require_granularity

BARS_FILE = "bars.parquet"

_POLARS_BAR_SCHEMA = {
    "symbol": pl.Utf8,
    "ts_utc": pl.Int64,
    "open": pl.Int64,
    "high": pl.Int64,
    "low": pl.Int64,
    "close": pl.Int64,
    "volume": pl.Int64,
}


@dataclass(frozen=True)
class WriteResult:
    inserted: int
    replaced: int
    partitions: int

    @property
    def total(self) -> int:
        return self.inserted + self.replaced


def _frame(rows: list[dict]) -> pl.DataFrame:
    return pl.DataFrame(rows, schema=_POLARS_BAR_SCHEMA)


def write_bars(base: Path, venue: str, granularity: str, rows: list[dict]) -> WriteResult:
    require_granularity(granularity)
    if not rows:
        return WriteResult(inserted=0, replaced=0, partitions=0)

    grouped: dict[Path, list[dict]] = defaultdict(list)
    for row in rows:
        grouped[bars_partition(base, venue, granularity, row["ts_utc"])].append(row)

    inserted = replaced = 0
    for directory, partition_rows in grouped.items():
        incoming = _frame(partition_rows).unique(subset=SORT_KEY, keep="last")
        target = directory / BARS_FILE

        if target.exists():
            existing = pl.read_parquet(target)
            overlap = existing.join(incoming.select(SORT_KEY), on=SORT_KEY, how="semi").height
            merged = pl.concat([existing, incoming]).unique(subset=SORT_KEY, keep="last")
        else:
            overlap = 0
            merged = incoming

        replaced += overlap
        inserted += incoming.height - overlap

        directory.mkdir(parents=True, exist_ok=True)
        table = merged.sort(SORT_KEY).to_arrow().cast(BAR_SCHEMA)
        pq.write_table(table, target, compression="zstd")

    return WriteResult(inserted=inserted, replaced=replaced, partitions=len(grouped))


def write_adjustments(base: Path, venue: str, rows: list[dict]) -> WriteResult:
    """Append-only adjustment table, deduplicated on (symbol, effective_ts_utc,."""
    from .layout import adjustments_path
    from .semantics import ADJUSTMENT_SCHEMA

    if not rows:
        return WriteResult(inserted=0, replaced=0, partitions=0)

    key = ["symbol", "effective_ts_utc", "kind"]
    schema = {
        "symbol": pl.Utf8, "effective_ts_utc": pl.Int64, "kind": pl.Utf8,
        "numerator": pl.Int64, "denominator": pl.Int64, "source": pl.Utf8,
    }
    incoming = pl.DataFrame(rows, schema=schema).unique(subset=key, keep="last")
    target = adjustments_path(base, venue)

    if target.exists():
        existing = pl.read_parquet(target)
        overlap = existing.join(incoming.select(key), on=key, how="semi").height
        merged = pl.concat([existing, incoming]).unique(subset=key, keep="last")
    else:
        overlap = 0
        merged = incoming

    target.parent.mkdir(parents=True, exist_ok=True)
    table = merged.sort(key).to_arrow().cast(ADJUSTMENT_SCHEMA)
    pq.write_table(table, target, compression="zstd")

    return WriteResult(inserted=incoming.height - overlap, replaced=overlap, partitions=1)
