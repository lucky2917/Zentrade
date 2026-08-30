"""Evidence for intraday short sessions: does volume conserve across granularities?

A 1m bar exists only if the symbol traded in that minute, so a thin name has
fewer than 375 bars without anything being lost. That claim is testable rather
than assumed: 1m, 5m and 15m arrive in separate provider responses, and the
daily bhavcopy is an independent source altogether. If all four agree on the
volume of a session, every trade is present and the absent bars carried none.
"""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

import polars as pl

import zentrade
from zentrade.spine.layout import bars_glob
from zentrade.spine.semantics import EXPECTED_CANDLES_PER_SESSION

ROOT = Path(zentrade.__file__).resolve().parents[2]
SPINE = ROOT / "data" / "spine"
DAY_US, IST_US = 86_400_000_000, 19_800_000_000
MARKET_WIDE_FRACTION = 0.90


def as_date(day_index: int) -> str:
    return datetime.fromtimestamp(day_index * 86400, tz=timezone.utc).date().isoformat()


def per_session(granularity: str) -> pl.DataFrame:
    return (pl.scan_parquet(bars_glob(SPINE, "NSE", granularity))
            .select(pl.col("symbol"), pl.col("volume"),
                    ((pl.col("ts_utc") + IST_US) // DAY_US).alias("session"),
                    (((pl.col("ts_utc") + IST_US) % DAY_US) // 60_000_000).alias("minute"))
            .group_by(["symbol", "session"])
            .agg(pl.len().alias("bars"), pl.col("volume").sum().alias("vol"),
                 pl.col("minute").min().alias("first_min"),
                 pl.col("minute").max().alias("last_min"))
            .collect())


def daily_volume() -> pl.DataFrame:
    return (pl.scan_parquet(bars_glob(SPINE, "NSE", "1d"))
            .select(pl.col("symbol"), pl.col("volume").alias("vol_1d"),
                    ((pl.col("ts_utc") + IST_US) // DAY_US).alias("session"))
            .collect())


def main() -> int:
    one, five, fifteen = per_session("1m"), per_session("5m"), per_session("15m")
    daily = daily_volume()

    joined = (one.rename({"bars": "bars_1m", "vol": "vol_1m"})
              .join(five.select(["symbol", "session", "bars", "vol"])
                    .rename({"bars": "bars_5m", "vol": "vol_5m"}),
                    on=["symbol", "session"], how="left")
              .join(fifteen.select(["symbol", "session", "bars", "vol"])
                    .rename({"bars": "bars_15m", "vol": "vol_15m"}),
                    on=["symbol", "session"], how="left")
              .join(daily, on=["symbol", "session"], how="left"))

    expected = EXPECTED_CANDLES_PER_SESSION["1m"]
    per_day = joined.group_by("session").agg(pl.len().alias("symbols"))
    short_by_day = (joined.filter(pl.col("bars_1m") < expected)
                    .group_by("session").agg(pl.len().alias("short")))
    market_wide = set(short_by_day.join(per_day, on="session")
                      .filter(pl.col("short") >= MARKET_WIDE_FRACTION * pl.col("symbols"))
                      ["session"].to_list())

    short = joined.filter(pl.col("bars_1m") < expected)
    unexplained = short.filter(~pl.col("session").is_in(list(market_wide)))

    print(f"symbol-sessions           {joined.height:,}")
    print(f"short at 1m               {short.height:,}")
    print(f"  market-wide short days  {len(market_wide)} "
          f"covering {short.height - unexplained.height:,} symbol-sessions")
    print(f"  unexplained short       {unexplained.height:,}")

    print("\n=== volume conservation on the unexplained short sessions ===")
    checks = [("1m vs 5m", "vol_5m"), ("1m vs 15m", "vol_15m"), ("1m vs daily", "vol_1d")]
    for label, column in checks:
        subset = unexplained.filter(pl.col(column).is_not_null())
        equal = subset.filter(pl.col("vol_1m") == pl.col(column)).height
        pct = 100.0 * equal / subset.height if subset.height else 0.0
        diff = subset.filter(pl.col("vol_1m") != pl.col(column))
        worst = ""
        if diff.height:
            d = diff.with_columns(
                ((pl.col("vol_1m") - pl.col(column)).abs()).alias("gap")).sort("gap", descending=True)
            top = d.row(0, named=True)
            worst = (f" | largest gap {top['gap']:,} on {top['symbol']} "
                     f"{as_date(top['session'])} ({top['vol_1m']:,} vs {top[column]:,})")
        print(f"  {label:12} exact match {equal:,}/{subset.height:,} ({pct:.4f}%){worst}")

    print("\n=== what a short session looks like ===")
    sample = unexplained.sort("bars_1m").head(6)
    for row in sample.iter_rows(named=True):
        interior = row["last_min"] - row["first_min"] + 1
        print(f"  {row['symbol']:12} {as_date(row['session'])}  bars {row['bars_1m']:>3}/375  "
              f"span {row['first_min']//60:02d}:{row['first_min']%60:02d}-"
              f"{row['last_min']//60:02d}:{row['last_min']%60:02d} ({interior} min)  "
              f"vol 1m={row['vol_1m']:,} 5m={row['vol_5m']:,} 15m={row['vol_15m']:,} "
              f"daily={row['vol_1d']:,}" if row["vol_1d"] is not None else
              f"  {row['symbol']:12} {as_date(row['session'])}  bars {row['bars_1m']}/375")

    print("\n=== classification ===")
    conserved = unexplained.filter(
        (pl.col("vol_1m") == pl.col("vol_5m")) & (pl.col("vol_1m") == pl.col("vol_15m")))
    not_conserved = unexplained.filter(
        (pl.col("vol_1m") != pl.col("vol_5m")) | (pl.col("vol_1m") != pl.col("vol_15m")))
    print(f"  A zero-trade minutes (1m=5m=15m volume)   {conserved.height:,}")
    print(f"  C provider/data gap (volume disagrees)     {not_conserved.height:,}")
    for row in not_conserved.head(10).iter_rows(named=True):
        print(f"      {row['symbol']:12} {as_date(row['session'])} "
              f"1m={row['vol_1m']:,} 5m={row['vol_5m']:,} 15m={row['vol_15m']:,}")

    print("\n=== does the same hold on FULL sessions (control)? ===")
    full = joined.filter(pl.col("bars_1m") == expected)
    for label, column in checks:
        subset = full.filter(pl.col(column).is_not_null())
        equal = subset.filter(pl.col("vol_1m") == pl.col(column)).height
        pct = 100.0 * equal / subset.height if subset.height else 0.0
        print(f"  {label:12} exact match {equal:,}/{subset.height:,} ({pct:.4f}%)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
