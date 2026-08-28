"""Point-in-time data access. as_of is required and filtering happens at the source."""

from __future__ import annotations

from bisect import bisect_right
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path
from typing import Protocol, runtime_checkable

import pyarrow as pa

from ...spine.layout import adjustments_path
from ...spine.reader import read_bars
from ...spine.semantics import BAR_SCHEMA


class FutureDataRequested(RuntimeError):
    """Raised when a caller asks for data at or after its own as_of."""


@runtime_checkable
class PitDataSource(Protocol):
    venue: str

    def bars_before(self, *, as_of: int, symbols: list[str] | None = None,
                    lookback_sessions: int = 0) -> pa.Table: ...

    def symbols_before(self, *, as_of: int, lookback_sessions: int = 0) -> list[str]: ...


SESSION_MICROS = 24 * 60 * 60 * 1_000_000


def _cumulative_factors(base: Path, venue: str, as_of: int) -> dict[str, tuple[list[int], list[Fraction]]]:
    """Exact back-adjustment factors per symbol, using only actions effective at."""
    path = adjustments_path(base, venue)
    if not path.exists():
        return {}

    import polars as pl

    frame = pl.read_parquet(path).filter(pl.col("effective_ts_utc") <= as_of)
    if frame.height == 0:
        return {}

    by_symbol: dict[str, list[tuple[int, Fraction]]] = {}
    for row in frame.iter_rows(named=True):
        by_symbol.setdefault(row["symbol"], []).append(
            (row["effective_ts_utc"], Fraction(row["numerator"], row["denominator"]))
        )

    out: dict[str, tuple[list[int], list[Fraction]]] = {}
    for symbol, actions in by_symbol.items():
        actions.sort(key=lambda a: a[0])
        running = Fraction(1)
        cumulative: list[Fraction] = []
        for _, ratio in reversed(actions):
            running *= ratio
            cumulative.append(running)
        cumulative.reverse()
        out[symbol] = ([a[0] for a in actions], cumulative)
    return out


@dataclass(frozen=True)
class SpinePitSource:
    """Reads spine_v1 with a hard as_of boundary. There is no unfiltered path."""

    base: Path
    venue: str = "NSE"
    granularity: str = "1d"
    adjust: bool = True

    def _window_start(self, as_of: int, lookback_sessions: int) -> int | None:
        if lookback_sessions <= 0:
            return None
        calendar_days = int(lookback_sessions * 1.55) + 10
        return as_of - calendar_days * SESSION_MICROS

    def bars_before(self, *, as_of: int, symbols: list[str] | None = None,
                    lookback_sessions: int = 0) -> pa.Table:
        table = read_bars(
            self.base, self.venue, self.granularity,
            symbols=symbols,
            start_ts=self._window_start(as_of, lookback_sessions),
            end_ts=as_of,
        )
        if table.num_rows:
            latest = max(table.column("ts_utc").to_pylist())
            if latest >= as_of:
                raise FutureDataRequested(
                    f"source returned a bar at {latest} which is not before as_of {as_of}"
                )
        if self.adjust and table.num_rows:
            table = self._adjusted(table, as_of)
        return table

    def _adjusted(self, table: pa.Table, as_of: int) -> pa.Table:
        """Apply back-adjustment so a series spanning a corporate action is."""
        factors = _cumulative_factors(self.base, self.venue, as_of)
        if not factors:
            return table

        columns = {name: table.column(name).to_pylist()
                   for name in ("symbol", "ts_utc", "open", "high", "low", "close", "volume")}
        prices = {"open": [], "high": [], "low": [], "close": []}
        volumes = []

        for index, symbol in enumerate(columns["symbol"]):
            entry = factors.get(symbol)
            ratio = Fraction(1)
            if entry is not None:
                effective, cumulative = entry
                position = bisect_right(effective, columns["ts_utc"][index])
                if position < len(cumulative):
                    ratio = cumulative[position]
            for field in prices:
                value = columns[field][index] * ratio
                prices[field].append(int(value.numerator // value.denominator +
                                         (1 if 2 * (value.numerator % value.denominator)
                                          >= value.denominator else 0)))
            volume = columns["volume"][index] / ratio if ratio else Fraction(0)
            volumes.append(int(volume.numerator // volume.denominator +
                               (1 if 2 * (volume.numerator % volume.denominator)
                                >= volume.denominator else 0)))

        return pa.table({
            "symbol": columns["symbol"], "ts_utc": columns["ts_utc"],
            "open": prices["open"], "high": prices["high"],
            "low": prices["low"], "close": prices["close"], "volume": volumes,
        }, schema=BAR_SCHEMA)

    def symbols_before(self, *, as_of: int, lookback_sessions: int = 0) -> list[str]:
        table = self.bars_before(as_of=as_of, lookback_sessions=lookback_sessions)
        return sorted(set(table.column("symbol").to_pylist()))


@dataclass(frozen=True)
class InMemoryPitSource:
    """Same contract, backed by an in-memory table. Used to prove the engine is."""

    table: pa.Table
    venue: str = "NSE"

    def bars_before(self, *, as_of: int, symbols: list[str] | None = None,
                    lookback_sessions: int = 0) -> pa.Table:
        if self.table.num_rows == 0:
            return BAR_SCHEMA.empty_table()
        mask = [t < as_of for t in self.table.column("ts_utc").to_pylist()]
        filtered = self.table.filter(pa.array(mask))
        if symbols is not None:
            wanted = set(symbols)
            keep = [s in wanted for s in filtered.column("symbol").to_pylist()]
            filtered = filtered.filter(pa.array(keep))
        if filtered.num_rows == 0:
            return BAR_SCHEMA.empty_table()
        if lookback_sessions > 0:
            stamps = sorted(set(filtered.column("ts_utc").to_pylist()))
            if len(stamps) > lookback_sessions:
                earliest = stamps[-lookback_sessions]
                keep = [t >= earliest for t in filtered.column("ts_utc").to_pylist()]
                filtered = filtered.filter(pa.array(keep))
        order = sorted(
            range(filtered.num_rows),
            key=lambda i: (filtered.column("ts_utc")[i].as_py(), filtered.column("symbol")[i].as_py()),
        )
        return filtered.take(order).cast(BAR_SCHEMA)

    def symbols_before(self, *, as_of: int, lookback_sessions: int = 0) -> list[str]:
        table = self.bars_before(as_of=as_of)
        return sorted(set(table.column("symbol").to_pylist()))
