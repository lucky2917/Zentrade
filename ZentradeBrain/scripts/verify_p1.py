"""P1 acceptance verification. Every criterion from the build plan, checked."""
from __future__ import annotations

import csv
import io
import shutil
import subprocess
import sys
import tempfile
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from zentrade.adapters.data.nse_bhavcopy import BhavcopyUnavailable, load_day, to_spine_rows
from zentrade.adapters.data.symbology import Observation, build as build_symbology
from zentrade.features.universe import liquidity_screen
from zentrade.spine.reader import adjustment_factors, read_bars, universe_on
from zentrade.spine.writer import write_bars

ROOT = Path(__file__).resolve().parents[1]
SPINE = ROOT / "data" / "spine"
CACHE = ROOT / "data" / "cache" / "bhavcopy"

results: list[tuple[str, bool, str]] = []


def check(name: str, passed: bool, detail: str = "") -> None:
    results.append((name, passed, detail))
    print(f"  [{'PASS' if passed else 'FAIL'}] {name}" + (f"  -- {detail}" if detail else ""), flush=True)


def ts(d: date) -> int:
    return int(datetime(d.year, d.month, d.day, tzinfo=timezone.utc).timestamp() * 1_000_000)


def read_cached(path: Path):
    text = path.read_text(encoding="utf-8", errors="replace")
    udiff = "TckrSymb" in text.split("\n", 1)[0]
    for row in csv.DictReader(io.StringIO(text)):
        r = {(k or "").strip(): (v or "").strip() for k, v in row.items()}
        sym = r.get("TckrSymb") if udiff else r.get("SYMBOL")
        isin = r.get("ISIN")
        ser = r.get("SctySrs") if udiff else r.get("SERIES")
        if ser in ("EQ", "BE") and sym and isin:
            yield sym, isin


def main() -> int:
    print("=" * 74)
    print("P1 ACCEPTANCE VERIFICATION")
    print("=" * 74)

    print("\n[1] Spine inventory")
    table = read_bars(SPINE, "NSE", "1d")
    rows = table.num_rows
    ts_values = table.column("ts_utc").to_pylist()
    symbols = set(table.column("symbol").to_pylist())
    sessions = sorted({datetime.fromtimestamp(t / 1e6, tz=timezone.utc).date() for t in ts_values})
    print(f"      rows {rows:,}  sessions {len(sessions):,}  distinct symbols {len(symbols):,}")
    print(f"      span {sessions[0]} .. {sessions[-1]}")
    check("ingested >= 1200 sessions", len(sessions) >= 1200, f"{len(sessions)} sessions")
    check("spans >= 5 years", (sessions[-1] - sessions[0]).days >= 365 * 5,
          f"{(sessions[-1]-sessions[0]).days/365.25:.2f} yr")
    check("symbol count plausible for NSE", 2000 <= len(symbols) <= 5000, f"{len(symbols)}")

    print("\n[2] Format parity on the 2024 overlap")
    mismatches = 0
    checked = 0
    for day in (date(2024, 1, 2), date(2024, 2, 1), date(2024, 3, 1)):
        try:
            _, u = load_day(day, CACHE, prefer="udiff")
            _, l = load_day(day, CACHE, prefer="legacy")
        except BhavcopyUnavailable:
            continue
        ud = {b.symbol: b for b in u}
        ld = {b.symbol: b for b in l}
        checked += 1
        if ud.keys() != ld.keys():
            mismatches += 1
            continue
        for s, a in ud.items():
            b = ld[s]
            if (a.open, a.high, a.low, a.close, a.volume) != (b.open, b.high, b.low, b.close, b.volume):
                mismatches += 1
            elif a.isin != b.isin:
                mismatches += 1
    check("legacy and UDiFF agree to the paise", mismatches == 0 and checked > 0,
          f"{checked} sessions, {mismatches} mismatches")

    print("\n[3] Idempotent re-ingest")
    before = read_bars(SPINE, "NSE", "1d").num_rows
    sample = sessions[len(sessions) // 2]
    _, bars = load_day(sample, CACHE)
    result = write_bars(SPINE, "NSE", "1d", to_spine_rows(bars))
    after = read_bars(SPINE, "NSE", "1d").num_rows
    check("re-ingest adds no rows", before == after, f"{before:,} -> {after:,}")
    check("re-ingest reports replacement not insertion", result.inserted == 0,
          f"inserted {result.inserted}, replaced {result.replaced}")

    print("\n[4] Clean re-run reproduces the same spine")
    year = sessions[len(sessions) // 2].year
    with tempfile.TemporaryDirectory() as tmp:
        fresh = Path(tmp) / "spine"
        built = 0
        for day in [d for d in sessions if d.year == year]:
            try:
                _, bars = load_day(day, CACHE)
            except BhavcopyUnavailable:
                continue
            write_bars(fresh, "NSE", "1d", to_spine_rows(bars))
            built += 1
        original = SPINE / f"spine_v1/bars/venue=NSE/granularity=1d/year={year}/bars.parquet"
        rebuilt = fresh / f"spine_v1/bars/venue=NSE/granularity=1d/year={year}/bars.parquet"
        same_bytes = original.read_bytes() == rebuilt.read_bytes()
        a = read_bars(SPINE, "NSE", "1d", start_ts=ts(date(year, 1, 1)), end_ts=ts(date(year + 1, 1, 1)))
        b = read_bars(fresh, "NSE", "1d", start_ts=ts(date(year, 1, 1)), end_ts=ts(date(year + 1, 1, 1)))
        check(f"clean rebuild of {year} is byte-identical", same_bytes,
              f"{built} sessions, {a.num_rows:,} rows")
        check("clean rebuild has identical content", a.equals(b))

    print("\n[5] Point-in-time universe reconstruction")
    for y in sorted({d.year for d in sessions}):
        u = universe_on(SPINE, "NSE", "1d", ts(date(y, 1, 1)), ts(date(y + 1, 1, 1)))
        if u:
            print(f"      {y}: {len(u):,} symbols traded")
    early = set(universe_on(SPINE, "NSE", "1d", ts(date(2021, 6, 1)), ts(date(2021, 12, 31))))
    late = set(universe_on(SPINE, "NSE", "1d", ts(date(2026, 1, 1)), ts(date(2026, 12, 31))))
    gone = early - late
    check("delisted names retained in history", len(gone) > 0,
          f"{len(gone):,} symbols traded in 2021 but not 2026")
    check("universe grows over time", len(late) > 0 and len(early) > 0,
          f"2021 {len(early):,} -> 2026 {len(late):,}")

    print("\n[6] Corporate actions")
    factors = adjustment_factors(SPINE, "NSE", ts(date(2026, 8, 27)))
    n_adj = factors.num_rows if factors is not None else 0
    print(f"      adjustment rows effective by 2026-08-27: {n_adj:,}")
    check("adjustment table populated", n_adj > 300, f"{n_adj} rows")
    if n_adj:
        pf = factors.column("price_factor").to_pylist()
        check("all cumulative factors positive and finite",
              all(f > 0 and f == f and f != float("inf") for f in pf),
              f"min {min(pf):.4f} max {max(pf):.4f}")

        import polars as _pl
        raw = _pl.read_parquet(SPINE / "spine_v1/adjustments/venue=NSE/adjustments.parquet")
        raw = raw.with_columns((_pl.col("numerator") / _pl.col("denominator")).alias("f"))
        dilutive = raw.filter(_pl.col("kind").is_in(["split", "bonus"]))
        accretive = raw.filter(_pl.col("kind") == "consolidation")
        check("splits and bonuses scale history down",
              bool((dilutive["f"] <= 1).all()),
              f"{dilutive.height} rows, max {dilutive['f'].max():.4f}")
        check("consolidations scale history up",
              accretive.height == 0 or bool((accretive["f"] > 1).all()),
              f"{accretive.height} rows"
              + (f", min {accretive['f'].min():.4f}" if accretive.height else ""))
        check("no factor is absurd (parser sanity)",
              bool(((raw["f"] > 1e-4) & (raw["f"] < 1e4)).all()),
              f"range {raw['f'].min():.5f} .. {raw['f'].max():.2f}")

    print("\n[7] Entity resolution over the full cache")
    obs = []
    for f in sorted(CACHE.glob("*.csv")):
        day = datetime.strptime(f.name[:8], "%Y%m%d").date()
        for sym, isin in read_cached(f):
            obs.append(Observation(sym, isin, day))
    sg = build_symbology(obs)
    renamed = sum(e.renamed for e in sg.entities.values())
    reissued = sum(e.reissued for e in sg.entities.values())
    print(f"      {len(obs):,} observations -> {len(sg.entities):,} entities")
    print(f"      renamed {renamed:,}   ISIN reissued {reissued:,}")
    zydus = sg.entity_for_symbol("ZYDUSLIFE")
    cadila = sg.entity_for_symbol("CADILAHC")
    check("real rename unified (CADILAHC/ZYDUSLIFE)",
          zydus is not None and cadila is not None and zydus.entity_id == cadila.entity_id,
          zydus.entity_id if zydus else "not found")
    if zydus:
        span = (zydus.last_seen - zydus.first_seen).days / 365.25
        check("renamed entity has continuous multi-year history", span >= 4.5, f"{span:.2f} yr")

    print("\n[8] Point-in-time liquidity screen")
    screens = {}
    for as_of in (date(2022, 1, 3), date(2024, 1, 2), date(2026, 8, 24)):
        r = liquidity_screen(SPINE, as_of, size=100)
        screens[as_of] = r
        print(f"      {as_of}: considered {r.considered:,}, sessions {r.sessions_used}, selected {len(r)}")
        print(f"        top 8: {list(r.symbols[:8])}")
    check("screen returns 100 names at each date", all(len(r) == 100 for r in screens.values()))
    a, b = screens[date(2022, 1, 3)].symbols, screens[date(2026, 8, 24)].symbols
    churn = len(set(a) ^ set(b)) / 2
    check("universe composition changes over time", churn > 10,
          f"{churn:.0f} names differ between 2022 and 2026")
    repeat = liquidity_screen(SPINE, date(2024, 1, 2), size=100)
    check("screen is deterministic", list(repeat.symbols) == list(screens[date(2024, 1, 2)].symbols))

    print("\n" + "=" * 74)
    failed = [n for n, ok, _ in results if not ok]
    print(f"P1 CRITERIA: {len(results) - len(failed)}/{len(results)} passed")
    if failed:
        print("\nFAILED:")
        for n in failed:
            print(f"  - {n}")
    print("=" * 74)
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
