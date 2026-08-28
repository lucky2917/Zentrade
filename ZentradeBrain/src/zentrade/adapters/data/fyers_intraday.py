"""Parse the Fyers intraday cache into spine_v2 rows."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

from ...kernel.money import to_minor
from ...spine.semantics import (
    EXPECTED_CANDLES_PER_SESSION, GRANULARITY_MINUTES, INTRADAY_GRANULARITIES,
    NSE_SESSION_CLOSE_IST, NSE_SESSION_OPEN_IST, SemanticsError,
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
    trailing session twice on a full-length request, 375 duplicate candles
    observed on 2026-08-28, and catching it at parse time makes the count
    visible instead of letting the writer silently absorb it.
    """
    payload = json.loads(path.read_text())
    granularity = RESOLUTION_TO_GRANULARITY.get(str(payload["resolution"]))
    if granularity is None:
        raise SemanticsError(f"unmapped resolution {payload['resolution']!r} in {path.name}")

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
        if minutes < NSE_SESSION_OPEN_IST or minutes > NSE_SESSION_CLOSE_IST:
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


def load_cache(cache_dir: Path, granularity: str) -> tuple[list[dict], ParseReport]:
    if granularity not in INTRADAY_GRANULARITIES:
        raise SemanticsError(f"{granularity!r} is not an intraday granularity")
    resolution = str(GRANULARITY_MINUTES[granularity])

    report = ParseReport()
    rows: list[dict] = []
    for path in sorted(Path(cache_dir).glob("*.json")):
        payload_resolution = json.loads(path.read_text())["resolution"]
        if str(payload_resolution) != resolution:
            continue
        rows.extend(parse_file(path, report))

    rows.sort(key=lambda row: (row["ts_utc"], row["symbol"]))
    return rows, report


def session_completeness(rows: list[dict], granularity: str) -> dict:
    """Candles per session against what the granularity implies."""
    expected = EXPECTED_CANDLES_PER_SESSION[granularity]
    per_session: dict[tuple[str, str], int] = {}
    for row in rows:
        session, _ = ist_parts(row["ts_utc"] // 1_000_000)
        key = (row["symbol"], session)
        per_session[key] = per_session.get(key, 0) + 1

    counts = sorted(per_session.values())
    short = {key: n for key, n in per_session.items() if n < expected}
    over = {key: n for key, n in per_session.items() if n > expected}
    return {
        "expected": expected, "symbol_sessions": len(per_session),
        "min": counts[0] if counts else 0, "max": counts[-1] if counts else 0,
        "short": short, "over": over,
    }
