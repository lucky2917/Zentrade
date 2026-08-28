"""Point-in-time liquidity screen."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import polars as pl

from ..adapters.data.pit import PitDataSource

DEFAULT_LOOKBACK_DAYS = 180
DEFAULT_SIZE = 100
MIN_SESSIONS = 60


def _ts(day: date) -> int:
    return int(datetime(day.year, day.month, day.day, tzinfo=timezone.utc).timestamp() * 1_000_000)


@dataclass(frozen=True)
class ScreenResult:
    as_of: date
    symbols: tuple[str, ...]
    considered: int
    sessions_used: int

    def __len__(self) -> int:
        return len(self.symbols)


def liquidity_screen(
    source: PitDataSource,
    as_of: date,
    size: int = DEFAULT_SIZE,
    lookback_days: int = DEFAULT_LOOKBACK_DAYS,
    min_sessions: int = MIN_SESSIONS,
) -> ScreenResult:
    """Top `size` symbols by median daily turnover over the window before as_of."""
    sessions_back = int(lookback_days * 5 / 7) + 5
    table = source.bars_before(as_of=_ts(as_of), lookback_sessions=sessions_back)
    if table.num_rows == 0:
        return ScreenResult(as_of, (), 0, 0)

    frame = pl.from_arrow(table).with_columns(
        (pl.col("close") * pl.col("volume")).alias("turnover")
    )
    sessions = frame.select(pl.col("ts_utc").n_unique()).item()

    ranked = (
        frame.group_by("symbol")
        .agg(
            pl.col("turnover").median().alias("median_turnover"),
            pl.len().alias("sessions"),
        )
        .filter(pl.col("sessions") >= min(min_sessions, sessions))
        .sort(["median_turnover", "symbol"], descending=[True, False])
        .head(size)
    )
    return ScreenResult(
        as_of=as_of,
        symbols=tuple(ranked["symbol"].to_list()),
        considered=frame.select(pl.col("symbol").n_unique()).item(),
        sessions_used=sessions,
    )
