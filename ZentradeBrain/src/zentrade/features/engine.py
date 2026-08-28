"""The canonical feature engine. One implementation for replay, paper and live."""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass

from ..adapters.data.pit import PitDataSource
from . import indicators as ind
from .schema import FEATURE_NAMES, MIN_HISTORY_SESSIONS, schema_hash

LOOKBACK_SESSIONS = MIN_HISTORY_SESSIONS + 5


@dataclass(frozen=True)
class FeatureRow:
    symbol: str
    as_of: int
    sessions_available: int
    values: tuple[float | None, ...]

    def as_dict(self) -> dict[str, float | None]:
        return dict(zip(FEATURE_NAMES, self.values))

    @property
    def complete(self) -> bool:
        return all(value is not None for value in self.values)


@dataclass(frozen=True)
class FeatureSnapshot:
    as_of: int
    schema_hash: str
    rows: tuple[FeatureRow, ...]

    def __len__(self) -> int:
        return len(self.rows)

    def by_symbol(self) -> dict[str, FeatureRow]:
        return {row.symbol: row for row in self.rows}

    def complete_rows(self) -> tuple[FeatureRow, ...]:
        return tuple(row for row in self.rows if row.complete)


@dataclass(frozen=True)
class _Series:
    opens: list[int]
    highs: list[int]
    lows: list[int]
    closes: list[int]
    volumes: list[int]


def _compute_row(symbol: str, as_of: int, series: _Series) -> FeatureRow:
    closes, highs, lows, volumes = series.closes, series.highs, series.lows, series.volumes
    values = (
        ind.simple_return(closes, 1),
        ind.simple_return(closes, 5),
        ind.simple_return(closes, 21),
        ind.price_to_average_ratio(closes, 20),
        ind.price_to_average_ratio(closes, 50),
        ind.realized_volatility(closes, 20),
        ind.volatility_ratio(closes, 20, 60),
        ind.average_true_range_pct(highs, lows, closes, 14),
        ind.range_position(highs[-1], lows[-1], closes[-1]) if closes else None,
        ind.volume_ratio(volumes, 20),
        ind.distance_from_extreme(closes, 252, use_high=True),
        ind.distance_from_extreme(closes, 252, use_high=False),
    )
    return FeatureRow(symbol=symbol, as_of=as_of, sessions_available=len(closes), values=values)


def _group_series(table) -> dict[str, _Series]:
    grouped: dict[str, list[tuple]] = defaultdict(list)
    columns = {name: table.column(name).to_pylist() for name in
               ("symbol", "ts_utc", "open", "high", "low", "close", "volume")}
    for index in range(table.num_rows):
        grouped[columns["symbol"][index]].append((
            columns["ts_utc"][index], columns["open"][index], columns["high"][index],
            columns["low"][index], columns["close"][index], columns["volume"][index],
        ))
    series = {}
    for symbol, rows in grouped.items():
        rows.sort(key=lambda r: r[0])
        series[symbol] = _Series(
            opens=[r[1] for r in rows], highs=[r[2] for r in rows],
            lows=[r[3] for r in rows], closes=[r[4] for r in rows],
            volumes=[r[5] for r in rows],
        )
    return series


def compute_features(source: PitDataSource, *, as_of: int,
                     symbols: list[str] | None = None) -> FeatureSnapshot:
    """Features for every symbol, using only bars strictly before as_of."""
    table = source.bars_before(
        as_of=as_of, symbols=symbols, lookback_sessions=LOOKBACK_SESSIONS
    )
    series = _group_series(table)
    rows = tuple(
        _compute_row(symbol, as_of, series[symbol])
        for symbol in sorted(series)
        if series[symbol].closes
    )
    return FeatureSnapshot(as_of=as_of, schema_hash=schema_hash(), rows=rows)
