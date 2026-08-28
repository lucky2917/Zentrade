"""
Point-in-time liquidity screen.

The tradeable universe on a past date must be what was actually liquid THEN,
not what is liquid now. Selecting today's top 100 and backtesting them over
five years is the textbook survivorship error: it silently conditions on
having survived and stayed liquid, which is information from the future.

Turnover is close x volume. The bhavcopy carries a true traded-value column,
but spine_v1's bar schema is frozen without it, and close x volume is the
standard proxy. Using it is a deliberate approximation, recorded here rather
than hidden: it misprices days with a wide intraday range, and it is a
ranking input rather than a traded quantity, so the error is tolerable.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import polars as pl

from ..spine.reader import read_bars

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
    base: Path,
    as_of: date,
    venue: str = "NSE",
    size: int = DEFAULT_SIZE,
    lookback_days: int = DEFAULT_LOOKBACK_DAYS,
    min_sessions: int = MIN_SESSIONS,
) -> ScreenResult:
    """Top `size` symbols by median daily turnover over the lookback window
    ending STRICTLY BEFORE as_of. The strictness is the whole point: a screen
    that includes as_of has seen the day it is about to trade."""
    start = as_of - timedelta(days=lookback_days)
    table = read_bars(base, venue, "1d", start_ts=_ts(start), end_ts=_ts(as_of))
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
        # symbol breaks ties so the screen is reproducible, never arbitrary
        .sort(["median_turnover", "symbol"], descending=[True, False])
        .head(size)
    )
    return ScreenResult(
        as_of=as_of,
        symbols=tuple(ranked["symbol"].to_list()),
        considered=frame.select(pl.col("symbol").n_unique()).item(),
        sessions_used=sessions,
    )
