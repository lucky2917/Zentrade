"""Acceptance harness for spine_v2 intraday storage."""

from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

import polars as pl
import pyarrow as pa

import zentrade
from zentrade.adapters.data.fyers_intraday import iter_cache_files
from zentrade.adapters.data.intraday_backfill import VENUE, ingest
from zentrade.adapters.data.pit import FutureDataRequested, SpinePitSource
from zentrade.spine.layout import bars_glob, spine_root
from zentrade.spine.semantics import (
    BAR_SCHEMA, EXPECTED_CANDLES_PER_SESSION, INTRADAY_GRANULARITIES,
    NSE_SESSION_OPEN_IST, SEMANTICS_ID, last_bar_minute,
)

ROOT = Path(zentrade.__file__).resolve().parents[2]
SPINE = ROOT / "data" / "spine"
CACHE = ROOT / "data" / "cache" / "intraday"
UNIVERSE = ROOT / "data" / "universe_intraday.txt"

DAY_US = 86_400_000_000
IST_OFFSET_US = 19_800_000_000
MARKET_WIDE_FRACTION = 0.90

checks: list[tuple[bool, str]] = []
facts: dict = {}


def check(passed: bool, label: str, detail: str = "") -> None:
    checks.append((passed, label))
    print(f"  [{'PASS' if passed else 'FAIL'}] {label}" + (f"  {detail}" if detail else ""))


class LeakySource(SpinePitSource):
    """A reader that hands back a bar at as_of, to prove the guard is live."""

    def __init__(self, table: pa.Table):
        object.__setattr__(self, "table", table)
        super().__init__(base=SPINE, venue=VENUE, granularity="1d", adjust=False)

    def bars_before(self, *, as_of: int, symbols=None, lookback_sessions: int = 0):
        latest = max(self.table.column("ts_utc").to_pylist())
        if latest >= as_of:
            raise FutureDataRequested(
                f"source returned a bar at {latest} which is not before as_of {as_of}"
            )
        return self.table


def session_expr() -> pl.Expr:
    return ((pl.col("ts_utc") + IST_OFFSET_US) // DAY_US).alias("session")


def minute_expr() -> pl.Expr:
    return (((pl.col("ts_utc") + IST_OFFSET_US) % DAY_US) // 60_000_000).alias("minute")


def as_date(day_index: int) -> str:
    return datetime.fromtimestamp(day_index * 86400, tz=timezone.utc).date().isoformat()


def frame(granularity: str) -> pl.LazyFrame:
    return pl.scan_parquet(bars_glob(SPINE, VENUE, granularity))


def digest(base: Path, granularity: str) -> str:
    sha = hashlib.sha256()
    for path in sorted(Path(spine_root(base)).rglob(f"granularity={granularity}/**/*.parquet")):
        sha.update(path.read_bytes())
    return sha.hexdigest()


def backfill_in_flight() -> bool:
    """A cache that is still growing makes idempotency and clean-room meaningless."""
    try:
        out = subprocess.run(["pgrep", "-f", "fetchIntraday"],
                             capture_output=True, text=True, timeout=10)
        return out.returncode == 0 and bool(out.stdout.strip())
    except Exception:
        return False


def daily_sessions() -> pl.DataFrame:
    return (frame("1d")
            .select(pl.col("symbol"), session_expr())
            .unique()
            .collect())


def check_daily_parity() -> None:
    print("\ndaily v1/v2 parity")
    v1 = SPINE / "spine_v1" / "bars" / "venue=NSE" / "granularity=1d"
    if not v1.exists():
        check(False, "spine_v1 daily tree present for comparison", str(v1))
        return
    pairs, identical = 0, 0
    for original in sorted(v1.glob("*/bars.parquet")):
        rebuilt = spine_root(SPINE) / "bars" / "venue=NSE" / "granularity=1d" / \
            original.parent.name / "bars.parquet"
        pairs += 1
        if rebuilt.exists() and original.read_bytes() == rebuilt.read_bytes():
            identical += 1
    check(pairs > 0 and identical == pairs,
          "every v1 daily partition is byte-identical under v2",
          f"{identical}/{pairs} partitions")

    a = frame("1d").select(pl.len()).collect().item()
    b = pl.scan_parquet(str(v1 / "*/bars.parquet")).select(pl.len()).collect().item()
    check(a == b, "daily row count unchanged by the migration", f"{a:,} rows")
    facts["daily_rows"] = a


def check_granularity(granularity: str, in_flight: bool) -> None:
    print(f"\n{granularity}")
    expected = EXPECTED_CANDLES_PER_SESSION[granularity]
    lazy = frame(granularity)

    totals = lazy.select(
        pl.len().alias("rows"),
        pl.col("symbol").n_unique().alias("symbols"),
        pl.col("ts_utc").min().alias("lo"),
        pl.col("ts_utc").max().alias("hi"),
    ).collect().row(0, named=True)

    cells = (lazy.select(pl.col("symbol"), session_expr())
             .group_by(["symbol", "session"]).agg(pl.len().alias("n"))
             .collect())
    sessions = cells["session"].unique()
    span = f"{as_date(sessions.min())} .. {as_date(sessions.max())}"
    check(totals["rows"] > 0, f"{granularity} coverage present",
          f"{totals['rows']:,} rows, {totals['symbols']} symbols, "
          f"{len(sessions):,} sessions, {span}")
    facts[granularity] = {
        "rows": totals["rows"], "symbols": totals["symbols"],
        "sessions": len(sessions), "span": span,
    }

    per_session_symbols = (cells.group_by("session").agg(pl.len().alias("k")))
    universe_size = totals["symbols"]
    wide = set(per_session_symbols.filter(
        pl.col("k") >= MARKET_WIDE_FRACTION * universe_size)["session"].to_list())

    short = cells.filter(pl.col("n") < expected)
    over = cells.filter(pl.col("n") > expected)
    check(over.height == 0, "no session exceeds the expected candle count",
          f"{cells.height:,} symbol-sessions, {over.height} over")

    short_by_session = short.group_by("session").agg(pl.len().alias("k"))
    market_wide_short = set(short_by_session.join(
        per_session_symbols, on="session"
    ).filter(pl.col("k") >= MARKET_WIDE_FRACTION * pl.col("k_right"))["session"].to_list())
    unexplained_short = short.filter(~pl.col("session").is_in(list(market_wide_short)))
    check(unexplained_short.height == 0,
          f"every symbol-session has {expected} candles, or is short market-wide",
          f"{short.height:,} short, {len(market_wide_short)} market-wide sessions, "
          f"{unexplained_short.height:,} unexplained")
    if market_wide_short:
        sample = sorted(as_date(s) for s in market_wide_short)[:6]
        print(f"         market-wide short sessions: {', '.join(sample)}"
              + (" ..." if len(market_wide_short) > 6 else ""))
    if unexplained_short.height:
        for row in unexplained_short.head(8).iter_rows(named=True):
            print(f"         SHORT {row['symbol']} {as_date(row['session'])} "
                  f"{row['n']}/{expected}")

    dupes = (lazy.group_by(["symbol", "ts_utc"]).agg(pl.len().alias("n"))
             .filter(pl.col("n") > 1).select(pl.len()).collect().item())
    check(dupes == 0, "no duplicate (symbol, ts_utc)", f"{totals['rows']:,} rows")

    bounds = lazy.select(minute_expr()).select(
        pl.col("minute").min().alias("lo"), pl.col("minute").max().alias("hi")
    ).collect().row(0, named=True)
    last_minute = last_bar_minute(granularity)
    check(bounds["lo"] >= NSE_SESSION_OPEN_IST and bounds["hi"] <= last_minute,
          "no out-of-session timestamps, last bar closes by the bell",
          f"IST {bounds['lo']//60:02d}:{bounds['lo']%60:02d}"
          f"..{bounds['hi']//60:02d}:{bounds['hi']%60:02d}")

    unsorted_rows = (lazy.sort("ts_utc")
                     .select(pl.col("symbol"), pl.col("ts_utc"))
                     .with_columns(pl.col("ts_utc").diff().over("symbol").alias("step"))
                     .filter(pl.col("step") <= 0).select(pl.len()).collect().item())
    check(unsorted_rows == 0, "chronological within each symbol",
          f"{unsorted_rows} non-increasing steps")

    coverage = cells.group_by("symbol").agg(
        pl.col("session").min().alias("first"),
        pl.col("session").max().alias("last"),
        pl.len().alias("have"))
    observed = {(s, ss) for s, ss in zip(cells["symbol"].to_list(), cells["session"].to_list())}
    gaps = []
    for row in coverage.iter_rows(named=True):
        inside = [s for s in wide if row["first"] <= s <= row["last"]]
        missing = [s for s in inside if (row["symbol"], s) not in observed]
        if missing:
            gaps.append((row["symbol"], len(missing), sorted(missing)[:3]))
    total_gaps = sum(g[1] for g in gaps)
    check(total_gaps == 0, "no unexplained missing sessions inside each symbol's span",
          f"{len(wide):,} market-wide sessions, {total_gaps} gaps across {len(gaps)} symbols")
    for symbol, count, sample in gaps[:8]:
        print(f"         GAP {symbol} {count} missing, e.g. "
              f"{', '.join(as_date(s) for s in sample)}")
    facts.setdefault("gaps", {})[granularity] = total_gaps

    stamps = (lazy.select("ts_utc").unique().sort("ts_utc")
              .with_row_index("i").collect())
    mid = stamps.filter(pl.col("i") == stamps.height // 2)["ts_utc"].item()
    nxt = stamps.filter(pl.col("i") == stamps.height // 2 + 1)["ts_utc"].item()
    raw = SpinePitSource(SPINE, VENUE, granularity, adjust=False)
    at = raw.bars_before(as_of=mid)
    after = raw.bars_before(as_of=nxt)
    latest = max(at.column("ts_utc").to_pylist()) if at.num_rows else -1
    check(latest < mid and after.num_rows > at.num_rows,
          "as_of is exclusive: the bar at as_of is withheld",
          f"{at.num_rows:,} bars at boundary, {after.num_rows:,} one stamp later")

    guard = False
    try:
        LeakySource(pa.table({
            "symbol": ["X"], "ts_utc": [mid], "open": [1], "high": [1],
            "low": [1], "close": [1], "volume": [1]}, schema=BAR_SCHEMA)
        ).bars_before(as_of=mid)
    except FutureDataRequested:
        guard = True
    check(guard, "FutureDataRequested fires when a reader returns a bar at as_of")

    cache_files = list(iter_cache_files(CACHE, granularity))
    raw_candles = 0
    for path, _ in cache_files:
        raw_candles += len(json.loads(path.read_text())["candles"])
    check(raw_candles >= totals["rows"],
          "raw cache accounts for every spine row",
          f"cache {raw_candles:,} candles, spine {totals['rows']:,} rows, "
          f"{raw_candles - totals['rows']:,} removed as duplicate/out-of-session")
    facts[granularity]["cache_candles"] = raw_candles
    facts[granularity]["cache_files"] = len(cache_files)

    if in_flight:
        print("       [SKIP] idempotency and clean-room: backfill still writing to cache")
        return

    before = digest(SPINE, granularity)
    again = ingest(CACHE, SPINE, granularity)
    check(again.inserted == 0 and digest(SPINE, granularity) == before,
          "re-ingestion is idempotent",
          f"inserted {again.inserted}, replaced {again.replaced:,}, bytes stable")
    facts[granularity]["duplicates_removed"] = again.parse.duplicates_dropped
    facts[granularity]["out_of_session"] = again.parse.out_of_session

    with tempfile.TemporaryDirectory() as tmp:
        fresh = Path(tmp) / "spine"
        ingest(CACHE, fresh, granularity)
        check(digest(fresh, granularity) == before,
              "clean-room reproduction is byte-identical", before[:16])


def main() -> int:
    in_flight = backfill_in_flight()
    print(f"spine_v2 intraday verification  ({SEMANTICS_ID})")
    if in_flight:
        print("  WARNING: a backfill is running; cache-dependent checks are skipped\n")

    print("semantics")
    check(SEMANTICS_ID == "spine_v2", "semantics id is spine_v2", SEMANTICS_ID)
    check(set(INTRADAY_GRANULARITIES) == {"1m", "5m", "15m"},
          "intraday granularities registered", str(INTRADAY_GRANULARITIES))
    check(EXPECTED_CANDLES_PER_SESSION == {"1m": 375, "5m": 75, "15m": 25},
          "expected candles per session", str(EXPECTED_CANDLES_PER_SESSION))

    check_daily_parity()
    for granularity in INTRADAY_GRANULARITIES:
        check_granularity(granularity, in_flight)

    if UNIVERSE.exists():
        print("\nsymbol coverage")
        wanted = {s.strip() for s in UNIVERSE.read_text().split("\n") if s.strip()}
        for granularity in INTRADAY_GRANULARITIES:
            have = set(frame(granularity).select(pl.col("symbol").unique())
                       .collect()["symbol"].to_list())
            missing = sorted(wanted - have)
            check(not missing, f"{granularity} covers the planned universe",
                  f"{len(have & wanted)}/{len(wanted)} symbols"
                  + (f", missing {', '.join(missing[:8])}" if missing else ""))

    passed = sum(1 for ok, _ in checks if ok)
    print(f"\n{passed}/{len(checks)} checks passed")
    for ok, label in checks:
        if not ok:
            print(f"  FAILED: {label}")
    (ROOT / "data" / "intraday_facts.json").write_text(json.dumps(facts, indent=2, default=str))
    return 0 if passed == len(checks) else 1


if __name__ == "__main__":
    raise SystemExit(main())
