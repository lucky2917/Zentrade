"""P3 acceptance verification against the real spine."""
from __future__ import annotations

import statistics
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import zentrade
from zentrade.adapters.data.pit import SpinePitSource
from zentrade.features.universe import liquidity_screen
from zentrade.learning.labeler import LabelSpec, label_digest, label_population
from zentrade.learning.outcomes import Outcome

ROOT = Path(zentrade.__file__).resolve().parents[2]
SPINE = ROOT / "data" / "spine"
results: list[tuple[str, bool, str]] = []


def check(name: str, passed: bool, detail: str = "") -> None:
    results.append((name, passed, detail))
    print(f"  [{'PASS' if passed else 'FAIL'}] {name}" + (f"  -- {detail}" if detail else ""),
          flush=True)


def ts(day: date) -> int:
    return int(datetime(day.year, day.month, day.day, tzinfo=timezone.utc).timestamp() * 1_000_000)


def main() -> int:
    print("=" * 74)
    print("P3 ACCEPTANCE VERIFICATION")
    print("=" * 74)

    source = SpinePitSource(SPINE)
    late, early = date(2026, 8, 27), date(2026, 5, 27)
    universe = list(liquidity_screen(source, late, size=40).symbols)

    print("\n[1] Coverage")
    full = label_population(source, as_of=ts(late), symbols=universe)
    stamps = [l.decision_ts for l in full.labels]
    span = (datetime.fromtimestamp(max(stamps) / 1e6, tz=timezone.utc).date()
            - datetime.fromtimestamp(min(stamps) / 1e6, tz=timezone.utc).date())
    print(f"      labels {len(full):,}  symbols {len({l.symbol for l in full.labels})}  "
          f"sessions {len(set(stamps)):,}  span {span.days / 365.25:.2f} yr")
    print(f"      outcomes {full.counts()}")
    check("labels generated for the full population", len(full) > 40_000, f"{len(full):,}")
    check("every universe symbol labelled",
          {l.symbol for l in full.labels} == set(universe), f"{len(universe)} symbols")
    check("coverage spans the history", span.days > 365 * 4, f"{span.days / 365.25:.2f} yr")

    print("\n[2] Determinism")
    again = label_population(source, as_of=ts(late), symbols=universe)
    check("repeated runs give an identical digest",
          label_digest(full) == label_digest(again), label_digest(full)[:24] + "...")
    check("output sorted by symbol then time",
          [(l.symbol, l.decision_ts) for l in full.labels]
          == sorted((l.symbol, l.decision_ts) for l in full.labels))

    print("\n[3] Truncation invariance on real data")
    truncated = label_population(source, as_of=ts(early), symbols=universe)
    late_by_key = {(l.symbol, l.decision_ts): l for l in full.labels}
    changed = []
    for label in truncated.final():
        other = late_by_key.get((label.symbol, label.decision_ts))
        if other is None:
            continue
        if (label.outcome, label.resolved_ts, label.exit_price) != \
           (other.outcome, other.resolved_ts, other.exit_price):
            changed.append((label.symbol, label.decision_ts))
    check("final labels unchanged at a later as_of", changed == [],
          f"{len(truncated.final()):,} compared, {len(changed)} changed")

    resolved_later = [l for l in truncated.pending()
                      if late_by_key.get((l.symbol, l.decision_ts))
                      and late_by_key[(l.symbol, l.decision_ts)].final]
    check("pending labels resolve once more data arrives",
          len(resolved_later) > 0, f"{len(resolved_later):,} of {len(truncated.pending()):,}")

    print("\n[4] No look-ahead")
    bad_order = [l for l in full.final()
                 if l.resolved_ts is not None and l.resolved_ts <= l.decision_ts]
    check("no label resolves at or before its decision", bad_order == [],
          f"{len(full.final()):,} final labels checked")

    horizon = LabelSpec().horizon_sessions
    over = [l for l in full.final()
            if l.sessions_to_resolve is not None and l.sessions_to_resolve > horizon]
    check("no label resolves beyond its horizon", over == [], f"horizon {horizon}")

    pending_recent = full.pending()
    if pending_recent:
        newest_final = max((l.decision_ts for l in full.final()), default=0)
        check("pending labels are the recent ones", True,
              f"{len(pending_recent):,} unresolved near the horizon")

    print("\n[5] Independence from selection")
    subset = universe[:10]
    partial = label_population(source, as_of=ts(late), symbols=subset)
    partial_keys = {(l.symbol, l.decision_ts): l for l in partial.labels}
    mismatched = [k for k, v in partial_keys.items()
                  if late_by_key[k].outcome != v.outcome]
    check("a symbol's labels do not depend on which others were labelled",
          mismatched == [], f"{len(partial_keys):,} compared")

    print("\n[6] Label sanity")
    finals = full.final()
    resolutions = [l.sessions_to_resolve for l in finals if l.sessions_to_resolve]
    returns = [l.forward_return for l in finals if l.forward_return is not None]
    print(f"      median sessions to resolve {statistics.median(resolutions):.0f}")
    print(f"      mean forward return {statistics.mean(returns):+.5f}")
    check("all final labels carry an exit price",
          all(l.exit_price is not None for l in finals))
    check("all final labels carry a forward return",
          all(l.forward_return is not None for l in finals))
    check("no pending label carries an outcome price",
          all(l.exit_price is None for l in full.pending()))
    check("every label records its spec hash",
          all(l.spec_hash == full.spec_hash for l in full.labels))
    check("target above entry and stop below entry",
          all(l.target > l.entry > l.stop for l in full.labels))

    print("\n" + "=" * 74)
    failed = [n for n, ok, _ in results if not ok]
    print(f"P3 CRITERIA: {len(results) - len(failed)}/{len(results)} passed")
    for n in failed:
        print(f"  - {n}")
    print("=" * 74)
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
