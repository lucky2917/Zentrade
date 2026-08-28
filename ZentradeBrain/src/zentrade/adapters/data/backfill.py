"""Resumable NSE daily backfill into spine_v1."""

from __future__ import annotations

import sys
from dataclasses import dataclass, field
from datetime import date, timedelta
from pathlib import Path

from ...kernel.clock import SystemClock
from ...spine.writer import write_bars
from .nse_bhavcopy import (
    BhavcopyUnavailable, load_day, polite_sleep, to_spine_rows, trading_days,
)

VENUE = "NSE"
GRANULARITY = "1d"


@dataclass
class BackfillReport:
    sessions: int = 0
    holidays: int = 0
    failures: list[tuple[date, str]] = field(default_factory=list)
    rows_written: int = 0
    partitions: int = 0
    formats: dict[str, int] = field(default_factory=dict)
    first_session: date | None = None
    last_session: date | None = None

    def summary(self) -> str:
        span = f"{self.first_session} .. {self.last_session}" if self.first_session else "none"
        fmt = ", ".join(f"{k}={v}" for k, v in sorted(self.formats.items())) or "none"
        return (
            f"sessions {self.sessions} | holidays/absent {self.holidays} | "
            f"failures {len(self.failures)} | rows {self.rows_written:,} | "
            f"partitions {self.partitions} | formats {fmt} | span {span}"
        )


def _partition_year(day: date) -> int:
    return day.year


def _flushing_print(*args) -> None:
    print(*args, flush=True)


def backfill_daily(
    start: date,
    end: date,
    spine_base: Path,
    cache_dir: Path,
    delay: float = 0.8,
    log=_flushing_print,
) -> BackfillReport:
    report = BackfillReport()
    pending: list[dict] = []
    current_year: int | None = None

    def flush() -> None:
        nonlocal pending
        if not pending:
            return
        result = write_bars(spine_base, VENUE, GRANULARITY, pending)
        report.rows_written += result.total
        report.partitions += result.partitions
        log(f"  [{current_year}] wrote {result.total:,} rows across {result.partitions} partition(s)")
        pending = []

    for day in trading_days(start, end):
        year = _partition_year(day)
        if current_year is not None and year != current_year:
            flush()
        current_year = year

        cached = (cache_dir / f"{day:%Y%m%d}_udiff.csv").exists() or (
            cache_dir / f"{day:%Y%m%d}_legacy.csv"
        ).exists()

        try:
            fmt, bars = load_day(day, cache_dir)
        except BhavcopyUnavailable:
            report.holidays += 1
            if not cached:
                polite_sleep(delay)
            continue
        except Exception as exc:
            report.failures.append((day, f"{type(exc).__name__}: {exc}"))
            log(f"  {day} FAILED {type(exc).__name__}: {exc}")
            if not cached:
                polite_sleep(delay)
            continue

        report.sessions += 1
        report.formats[fmt] = report.formats.get(fmt, 0) + 1
        report.first_session = report.first_session or day
        report.last_session = day
        pending.extend(to_spine_rows(bars))

        if report.sessions % 50 == 0:
            log(f"  {day}  {report.sessions} sessions, {len(bars):,} symbols, format={fmt}")

        if not cached:
            polite_sleep(delay)

    flush()
    return report


def main(argv: list[str]) -> int:
    root = Path(__file__).resolve().parents[4]
    start = date.fromisoformat(argv[1]) if len(argv) > 1 else date(2021, 6, 1)
    today = SystemClock().now().date()
    end = date.fromisoformat(argv[2]) if len(argv) > 2 else today - timedelta(days=1)

    spine_base = root / "data" / "spine"
    cache_dir = root / "data" / "cache" / "bhavcopy"
    cache_dir.mkdir(parents=True, exist_ok=True)

    print(f"NSE daily backfill  {start} .. {end}")
    print(f"  spine {spine_base}")
    print(f"  cache {cache_dir}", flush=True)

    report = backfill_daily(start, end, spine_base, cache_dir)
    print("\nDONE  " + report.summary(), flush=True)
    for day, err in report.failures[:20]:
        print(f"  failure {day}: {err}")
    return 1 if len(report.failures) > 10 else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
