"""DuckDB read surface for the spine."""

from __future__ import annotations

from pathlib import Path

import duckdb

import glob as _glob

import pyarrow as pa

from .layout import adjustments_path, bars_glob
from .semantics import BAR_SCHEMA, require_granularity


def _connect() -> duckdb.DuckDBPyConnection:
    return duckdb.connect(database=":memory:")


def read_bars(
    base: Path,
    venue: str,
    granularity: str,
    symbols: list[str] | None = None,
    start_ts: int | None = None,
    end_ts: int | None = None,
):
    require_granularity(granularity)
    clauses, params = [], []
    if symbols:
        clauses.append(f"symbol IN ({','.join('?' * len(symbols))})")
        params.extend(symbols)
    if start_ts is not None:
        clauses.append("ts_utc >= ?")
        params.append(start_ts)
    if end_ts is not None:
        clauses.append("ts_utc < ?")
        params.append(end_ts)

    pattern = bars_glob(base, venue, granularity)
    if not _glob.glob(pattern):
        return BAR_SCHEMA.empty_table()

    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    sql = f"""
        SELECT symbol, ts_utc, open, high, low, close, volume
        FROM read_parquet(?, hive_partitioning = true)
        {where}
        ORDER BY ts_utc, symbol
    """
    with _connect() as con:
        return con.execute(sql, [pattern, *params]).to_arrow_table()


def adjustment_factors(base: Path, venue: str, as_of_ts: int):
    """Cumulative back-adjustment factor per (symbol, effective_ts), using only."""
    path = adjustments_path(base, venue)
    if not path.exists():
        return None

    sql = """
        SELECT
            symbol,
            effective_ts_utc,
            exp(sum(ln(numerator::DOUBLE / denominator::DOUBLE)) OVER (
                PARTITION BY symbol
                ORDER BY effective_ts_utc DESC
                ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
            )) AS price_factor
        FROM read_parquet(?)
        WHERE effective_ts_utc <= ?
        ORDER BY symbol, effective_ts_utc
    """
    with _connect() as con:
        return con.execute(sql, [str(path), as_of_ts]).to_arrow_table()


def universe_on(base: Path, venue: str, granularity: str, start_ts: int, end_ts: int) -> list[str]:
    """Symbols that actually traded in the window. Reconstructing the tradeable."""
    require_granularity(granularity)
    pattern = bars_glob(base, venue, granularity)
    if not _glob.glob(pattern):
        return []
    sql = """
        SELECT DISTINCT symbol
        FROM read_parquet(?, hive_partitioning = true)
        WHERE ts_utc >= ? AND ts_utc < ?
        ORDER BY symbol
    """
    with _connect() as con:
        rows = con.execute(sql, [pattern, start_ts, end_ts]).fetchall()
    return [r[0] for r in rows]
