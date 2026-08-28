"""Corporate-action backfill into the spine adjustment table."""

from __future__ import annotations

import sys
from datetime import date, timedelta
from pathlib import Path

import zentrade

from ...spine.writer import write_adjustments
from .nse_corpactions import fetch_range, parse, polite_sleep, to_adjustment_rows

VENUE = "NSE"
WINDOW_DAYS = 120
OVERLAP_DAYS = 1


def windows(start: date, end: date, size: int = WINDOW_DAYS):
    cursor = start
    while cursor <= end:
        stop = min(cursor + timedelta(days=size), end)
        yield cursor, stop
        cursor = stop + timedelta(days=1) - timedelta(days=OVERLAP_DAYS)
        if stop >= end:
            break


def _flushing_print(*args) -> None:
    print(*args, flush=True)


def backfill(start: date, end: date, spine_base: Path, log=_flushing_print) -> dict:
    seen: dict[tuple, dict] = {}
    kinds: dict[str, int] = {}
    unparsed: list[str] = []
    total = 0

    for a, b in windows(start, end):
        try:
            raw = fetch_range(a, b)
        except Exception as exc:
            log(f"  {a}..{b} FAILED {type(exc).__name__}: {exc}")
            polite_sleep()
            continue

        actions, report = parse(raw)
        total += report.total
        for kind, count in report.parsed.items():
            kinds[kind] = kinds.get(kind, 0) + count
        for subject in report.unparsed_subjects:
            if len(unparsed) < 60 and subject not in unparsed:
                unparsed.append(subject)

        for row in to_adjustment_rows(actions):
            seen[(row["symbol"], row["effective_ts_utc"], row["kind"])] = row

        log(f"  {a}..{b}  raw {report.total:5}  priced {len(to_adjustment_rows(actions)):3}  "
            f"cumulative {len(seen)}")
        polite_sleep()

    rows = sorted(seen.values(), key=lambda r: (r["symbol"], r["effective_ts_utc"]))
    result = write_adjustments(spine_base, VENUE, rows)
    return {
        "raw_actions": total, "kinds": kinds, "adjustment_rows": len(rows),
        "inserted": result.inserted, "replaced": result.replaced,
        "unparsed_sample": unparsed,
    }


def main(argv: list[str]) -> int:
    root = Path(zentrade.__file__).resolve().parents[2]
    start = date.fromisoformat(argv[1]) if len(argv) > 1 else date(2021, 6, 1)
    end = date.fromisoformat(argv[2]) if len(argv) > 2 else date(2026, 8, 27)
    print(f"NSE corporate-action backfill  {start} .. {end}", flush=True)

    summary = backfill(start, end, root / "data" / "spine")
    print(f"\nDONE  raw {summary['raw_actions']:,} | kinds {summary['kinds']} | "
          f"adjustment rows {summary['adjustment_rows']} "
          f"(inserted {summary['inserted']}, replaced {summary['replaced']})")
    print(f"\nUnparsed subject forms retained (first {len(summary['unparsed_sample'])}):")
    for s in summary["unparsed_sample"][:15]:
        print(f"    {s[:100]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
