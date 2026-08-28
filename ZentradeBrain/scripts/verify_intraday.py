"""Acceptance harness for spine_v2 intraday storage."""

from __future__ import annotations

import hashlib
import shutil
import sys
import tempfile
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import polars as pl
import pyarrow as pa

import zentrade
from zentrade.adapters.data.fyers_intraday import ist_parts
from zentrade.adapters.data.intraday_backfill import VENUE, ingest
from zentrade.adapters.data.pit import FutureDataRequested, SpinePitSource
from zentrade.spine.layout import bars_glob, spine_root
from zentrade.spine.semantics import (
    BAR_SCHEMA,
    EXPECTED_CANDLES_PER_SESSION, INTRADAY_GRANULARITIES, NSE_SESSION_CLOSE_IST,
    NSE_SESSION_OPEN_IST, SEMANTICS_ID,
)

ROOT = Path(zentrade.__file__).resolve().parents[2]
SPINE = ROOT / "data" / "spine"
CACHE = ROOT / "data" / "cache" / "intraday"

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


checks: list[tuple[bool, str]] = []


def check(passed: bool, label: str, detail: str = "") -> None:
    checks.append((passed, label))
    mark = "PASS" if passed else "FAIL"
    print(f"  [{mark}] {label}" + (f"  {detail}" if detail else ""))


def read_all(granularity: str) -> pl.DataFrame:
    return pl.read_parquet(bars_glob(SPINE, VENUE, granularity))


def digest(granularity: str) -> str:
    sha = hashlib.sha256()
    for path in sorted(Path(spine_root(SPINE)).rglob(f"granularity={granularity}/**/*.parquet")):
        sha.update(path.read_bytes())
    return sha.hexdigest()


def session_of(ts_utc: int) -> str:
    return ist_parts(ts_utc // 1_000_000)[0]


def daily_sessions_between(lo: str, hi: str, symbols: list[str]) -> dict[str, set[str]]:
    """Sessions the daily spine says each symbol traded, as the missing-session oracle."""
    frame = pl.read_parquet(bars_glob(SPINE, VENUE, "1d")).filter(
        pl.col("symbol").is_in(symbols)
    )
    out: dict[str, set[str]] = {s: set() for s in symbols}
    for row in frame.iter_rows(named=True):
        day = datetime.fromtimestamp(row["ts_utc"] / 1e6, tz=timezone.utc).date().isoformat()
        if lo <= day <= hi:
            out[row["symbol"]].add(day)
    return out


def main() -> int:
    print(f"spine_v2 intraday verification  ({SEMANTICS_ID})\n")

    print("semantics")
    check(SEMANTICS_ID == "spine_v2", "semantics id is spine_v2", SEMANTICS_ID)
    check(set(INTRADAY_GRANULARITIES) == {"1m", "5m", "15m"},
          "intraday granularities registered", str(INTRADAY_GRANULARITIES))
    check(EXPECTED_CANDLES_PER_SESSION == {"1m": 375, "5m": 75, "15m": 25},
          "expected candles per session", str(EXPECTED_CANDLES_PER_SESSION))

    for granularity in INTRADAY_GRANULARITIES:
        print(f"\n{granularity}")
        frame = read_all(granularity).sort(["ts_utc", "symbol"])
        expected = EXPECTED_CANDLES_PER_SESSION[granularity]
        symbols = sorted(frame["symbol"].unique().to_list())

        sessions = [session_of(t) for t in frame["ts_utc"].to_list()]
        tagged = frame.with_columns(pl.Series("session", sessions))

        per_cell = tagged.group_by(["symbol", "session"]).agg(pl.len().alias("n"))
        wrong = per_cell.filter(pl.col("n") != expected)
        check(wrong.height == 0, f"every symbol-session has exactly {expected} candles",
              f"{per_cell.height} cells, {wrong.height} wrong")

        dupes = frame.group_by(["symbol", "ts_utc"]).agg(pl.len().alias("n")).filter(pl.col("n") > 1)
        check(dupes.height == 0, "no duplicate (symbol, ts_utc)", f"{frame.height:,} rows")

        minutes = [ist_parts(t // 1_000_000)[1] for t in frame["ts_utc"].to_list()]
        outside = [m for m in minutes
                   if m < NSE_SESSION_OPEN_IST or m > NSE_SESSION_CLOSE_IST]
        check(not outside, "no out-of-session timestamps",
              f"IST {min(minutes)//60:02d}:{min(minutes)%60:02d}"
              f"..{max(minutes)//60:02d}:{max(minutes)%60:02d}")

        ordered = all(
            group["ts_utc"].to_list() == sorted(group["ts_utc"].to_list())
            for _, group in frame.group_by("symbol")
        )
        check(ordered, "chronological within each symbol")

        observed = {s: set() for s in symbols}
        for symbol, session in zip(tagged["symbol"].to_list(), tagged["session"].to_list()):
            observed[symbol].add(session)
        lo, hi = min(sessions), max(sessions)
        oracle = daily_sessions_between(lo, hi, symbols)
        missing = {s: sorted(oracle[s] - observed[s]) for s in symbols if oracle[s] - observed[s]}
        check(not missing, "no missing sessions vs the daily spine",
              f"{lo}..{hi}, {len(observed[symbols[0]])} sessions/symbol")

        before = digest(granularity)
        result = ingest(CACHE, SPINE, granularity)
        after = digest(granularity)
        check(result.inserted == 0 and after == before,
              "re-ingestion is idempotent",
              f"inserted {result.inserted}, replaced {result.replaced:,}, bytes stable")

        with tempfile.TemporaryDirectory() as tmp:
            fresh = Path(tmp) / "spine"
            ingest(CACHE, fresh, granularity)
            sha = hashlib.sha256()
            for path in sorted(Path(spine_root(fresh)).rglob(f"granularity={granularity}/**/*.parquet")):
                sha.update(path.read_bytes())
            check(sha.hexdigest() == before, "clean-room reproduction is byte-identical",
                  before[:16])

        as_of_session = sorted(set(sessions))[len(set(sessions)) // 2]
        cutoff = int(datetime.fromisoformat(as_of_session)
                     .replace(tzinfo=timezone.utc).timestamp() * 1_000_000)
        source = SpinePitSource(SPINE, VENUE, granularity)
        table = source.bars_before(as_of=cutoff, lookback_sessions=expected * 3)
        latest = max(table.column("ts_utc").to_pylist()) if table.num_rows else -1
        check(table.num_rows > 0 and latest < cutoff, "PIT read honours as_of",
              f"{table.num_rows:,} bars, latest {session_of(latest)} < {as_of_session}")

        raw = SpinePitSource(SPINE, VENUE, granularity, adjust=False)
        stamps = sorted(set(frame["ts_utc"].to_list()))
        boundary = stamps[len(stamps) // 2]
        at = raw.bars_before(as_of=boundary)
        just_after = raw.bars_before(as_of=stamps[len(stamps) // 2 + 1])
        excluded = (at.num_rows == 0
                    or max(at.column("ts_utc").to_pylist()) < boundary)
        check(excluded and just_after.num_rows > at.num_rows,
              "as_of is exclusive: the bar at as_of is withheld",
              f"{at.num_rows:,} bars at boundary, {just_after.num_rows:,} one bar later")

        guard_fires = False
        try:
            forged = pa.table({
                "symbol": ["X"], "ts_utc": [boundary], "open": [1], "high": [1],
                "low": [1], "close": [1], "volume": [1],
            }, schema=BAR_SCHEMA)
            LeakySource(forged).bars_before(as_of=boundary)
        except FutureDataRequested:
            guard_fires = True
        check(guard_fires, "FutureDataRequested fires when a reader returns a bar at as_of")

    passed = sum(1 for ok, _ in checks if ok)
    print(f"\n{passed}/{len(checks)} checks passed")
    if passed != len(checks):
        for ok, label in checks:
            if not ok:
                print(f"  FAILED: {label}")
    return 0 if passed == len(checks) else 1


if __name__ == "__main__":
    raise SystemExit(main())
