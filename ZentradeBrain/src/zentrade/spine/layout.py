"""
Hive-partitioned paths for spine_v1.

Partitioning follows the dominant read pattern rather than the write pattern.
Cross-sectional ranking ("every symbol on this date") is what the research loop
runs constantly, so bars partition by time and carry the symbol as a column;
Parquet row-group statistics prune single-symbol reads well enough without a
partition per symbol. Minute bars add a month level because a year of them in
one file is large enough to hurt.
"""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

from .semantics import DAILY, MINUTE, SEMANTICS_ID, require_granularity

BARS = "bars"
ADJUSTMENTS = "adjustments"


def spine_root(base: Path) -> Path:
    return Path(base) / SEMANTICS_ID


def _utc(ts_utc: int) -> datetime:
    return datetime.fromtimestamp(ts_utc / 1_000_000, tz=timezone.utc)


def partition_key(granularity: str, ts_utc: int) -> tuple[tuple[str, str], ...]:
    require_granularity(granularity)
    moment = _utc(ts_utc)
    if granularity == DAILY:
        return (("year", f"{moment.year:04d}"),)
    return (("year", f"{moment.year:04d}"), ("month", f"{moment.month:02d}"))


def bars_partition(base: Path, venue: str, granularity: str, ts_utc: int) -> Path:
    path = spine_root(base) / BARS / f"venue={venue}" / f"granularity={granularity}"
    for name, value in partition_key(granularity, ts_utc):
        path = path / f"{name}={value}"
    return path


def bars_glob(base: Path, venue: str, granularity: str) -> str:
    require_granularity(granularity)
    depth = "*/" * len(partition_key(granularity, 0))
    root = spine_root(base) / BARS / f"venue={venue}" / f"granularity={granularity}"
    return f"{root}/{depth}*.parquet"


def adjustments_path(base: Path, venue: str) -> Path:
    return spine_root(base) / ADJUSTMENTS / f"venue={venue}" / "adjustments.parquet"
