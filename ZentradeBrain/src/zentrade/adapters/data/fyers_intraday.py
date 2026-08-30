"""Parse the Fyers intraday cache into spine_v2 rows."""

from __future__ import annotations

import json
from collections.abc import Iterator
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from pathlib import Path

from ...kernel.money import to_minor
from ...spine.semantics import (
    EXPECTED_CANDLES_PER_SESSION, GRANULARITY_MINUTES, INTRADAY_GRANULARITIES,
    NSE_SESSION_OPEN_IST, SemanticsError, last_bar_minute,
)

VENUE = "NSE"
CURRENCY = "INR"
IST_OFFSET_SECONDS = 19800

RESOLUTION_TO_GRANULARITY = {"1": "1m", "5": "5m", "15": "15m"}


@dataclass
class ParseReport:
    files: int = 0
    raw_candles: int = 0
    rows: int = 0
    duplicates_dropped: int = 0
    out_of_session: int = 0
    unordered_files: int = 0
    symbols: set[str] = field(default_factory=set)
    sessions: set[str] = field(default_factory=set)

    def summary(self) -> str:
        return (f"files {self.files} | raw {self.raw_candles:,} | rows {self.rows:,} | "
                f"duplicates dropped {self.duplicates_dropped:,} | "
                f"out-of-session {self.out_of_session} | unordered files {self.unordered_files} | "
                f"symbols {len(self.symbols)} | sessions {len(self.sessions)}")


def strip_symbol(fyers_symbol: str) -> str:
    return fyers_symbol.replace("NSE:", "").replace("-EQ", "")


def ist_parts(epoch_seconds: int) -> tuple[str, int]:
    moment = datetime.fromtimestamp(epoch_seconds + IST_OFFSET_SECONDS, tz=timezone.utc)
    return moment.date().isoformat(), moment.hour * 60 + moment.minute


def parse_file(path: Path, report: ParseReport) -> list[dict]:
    """One cache file to spine rows.

    Deduplication happens here as well as in the writer. Fyers returns the
    trailing session twice on a full-length request, 25 duplicate 15m candles
    measured on 2026-08-28, and that same response arrives out of order.
    Catching both here makes the count visible instead of letting the writer
    silently absorb it.
    """
    payload = json.loads(path.read_text())
    granularity = RESOLUTION_TO_GRANULARITY.get(str(payload["resolution"]))
    if granularity is None:
        raise SemanticsError(f"unmapped resolution {payload['resolution']!r} in {path.name}")

    last_minute = last_bar_minute(granularity)
    symbol = strip_symbol(payload["symbol"])
    report.files += 1
    report.symbols.add(symbol)

    seen: dict[int, dict] = {}
    previous = None
    unordered = False

    for candle in payload["candles"]:
        epoch, open_, high, low, close, volume = candle
        report.raw_candles += 1

        if previous is not None and epoch <= previous:
            unordered = True
        previous = epoch

        session, minutes = ist_parts(epoch)
        if minutes < NSE_SESSION_OPEN_IST or minutes > last_minute:
            report.out_of_session += 1
            continue

        ts_utc = epoch * 1_000_000
        if ts_utc in seen:
            report.duplicates_dropped += 1
            continue

        report.sessions.add(session)
        seen[ts_utc] = {
            "symbol": symbol, "ts_utc": ts_utc,
            "open": to_minor(str(open_), CURRENCY), "high": to_minor(str(high), CURRENCY),
            "low": to_minor(str(low), CURRENCY), "close": to_minor(str(close), CURRENCY),
            "volume": int(volume),
        }

    if unordered:
        report.unordered_files += 1

    rows = [seen[key] for key in sorted(seen)]
    report.rows += len(rows)
    return rows


def _window_start(path: Path) -> str:
    return path.name.split("__")[2]


def iter_cache_files(cache_dir: Path, granularity: str) -> Iterator[tuple[Path, date]]:
    """Cache files for one granularity, oldest window first.

    Ordering by window start is what lets the caller flush finished months: no
    later file can contribute rows to a month that ends before the current
    file begins.
    """
    if granularity not in INTRADAY_GRANULARITIES:
        raise SemanticsError(f"{granularity!r} is not an intraday granularity")
    resolution = str(GRANULARITY_MINUTES[granularity])

    matched = []
    for path in Path(cache_dir).glob("*.json"):
        parts = path.name.split("__")
        if len(parts) == 4 and parts[1] == resolution:
            matched.append((path, date.fromisoformat(_window_start(path))))
    matched.sort(key=lambda item: (item[1], item[0].name))
    yield from matched


def load_cache(cache_dir: Path, granularity: str) -> tuple[list[dict], ParseReport]:
    """Collect a whole granularity in memory. Small ranges and tests only."""
    report = ParseReport()
    rows: list[dict] = []
    for path, _ in iter_cache_files(cache_dir, granularity):
        rows.extend(parse_file(path, report))
    rows.sort(key=lambda row: (row["ts_utc"], row["symbol"]))
    return rows, report


def session_completeness(rows: list[dict], granularity: str) -> dict:
    """Candles per session for an already-deduplicated set of rows.

    Only valid on rows that have been through the writer, or on a single
    file. Tallying across cache files double counts any session two windows
    both cover, so the spine itself is the authority on completeness.
    """
    expected = EXPECTED_CANDLES_PER_SESSION[granularity]
    per_cell: dict[tuple[str, str], int] = {}
    for row in rows:
        session, _ = ist_parts(row["ts_utc"] // 1_000_000)
        cell = (row["symbol"], session)
        per_cell[cell] = per_cell.get(cell, 0) + 1
    counts = sorted(per_cell.values())
    return {
        "expected": expected, "symbol_sessions": len(per_cell),
        "min": counts[0] if counts else 0, "max": counts[-1] if counts else 0,
        "short": {k: n for k, n in per_cell.items() if n < expected},
        "over": {k: n for k, n in per_cell.items() if n > expected},
    }
