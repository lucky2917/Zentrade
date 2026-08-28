"""
NSE daily bhavcopy, both archive formats.

NSE changed format in 2024. Verified 2026-08-28 from this machine:
  legacy  cm<DD><MON><YYYY>bhav.csv.zip     2021-06 .. 2024-03
  UDiFF   BhavCopy_NSE_CM_..._<YYYYMMDD>_F_0000.csv.zip   2024-01-01 .. present

They overlap through early 2024, which is what makes the parity test possible:
the same session parsed by both readers must agree to the paise.

A daily bar's timestamp is session close (15:30 IST = 10:00 UTC), because that
is the first moment the bar is complete. Stamping it at midnight would place
information before it existed, which spine_v1 law 5 forbids.
"""

from __future__ import annotations

import csv
import io
import time
import urllib.error
import urllib.request
import zipfile
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from ...contracts.market import DailyBar
from ...kernel.money import to_minor

VENUE = "NSE"
CURRENCY = "INR"
EQUITY_SERIES = frozenset({"EQ", "BE"})

SESSION_CLOSE_UTC = (10, 0)
UDIFF_FIRST_DATE = date(2024, 1, 1)

_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Safari/537.36"
_MONTHS = ("JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC")
_ARCHIVE = "https://nsearchives.nseindia.com"


class BhavcopyUnavailable(RuntimeError):
    """The archive has no file for this date. Holidays and weekends land here."""


@dataclass(frozen=True)
class Format:
    name: str
    url: str


def udiff_url(day: date) -> str:
    return f"{_ARCHIVE}/content/cm/BhavCopy_NSE_CM_0_0_0_{day:%Y%m%d}_F_0000.csv.zip"


def legacy_url(day: date) -> str:
    mon = _MONTHS[day.month - 1]
    return f"{_ARCHIVE}/content/historical/EQUITIES/{day.year}/{mon}/cm{day:%d}{mon}{day.year}bhav.csv.zip"


def formats_for(day: date) -> tuple[Format, ...]:
    """Preferred first. UDiFF wins on overlapping dates: it is the current
    format and carries more fields."""
    if day >= UDIFF_FIRST_DATE:
        return (Format("udiff", udiff_url(day)), Format("legacy", legacy_url(day)))
    return (Format("legacy", legacy_url(day)),)


def session_timestamp(day: date) -> int:
    hh, mm = SESSION_CLOSE_UTC
    moment = datetime(day.year, day.month, day.day, hh, mm, tzinfo=timezone.utc)
    return int(moment.timestamp() * 1_000_000)


def _download(url: str, timeout: float) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": _UA, "Referer": "https://www.nseindia.com/"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read()


def fetch_raw(day: date, fmt: Format, cache_dir: Path | None = None, timeout: float = 30.0) -> str:
    """Return the decoded CSV, from cache when present. The archive is
    immutable for past dates, so a cache hit needs no revalidation."""
    cached = None
    if cache_dir is not None:
        cached = Path(cache_dir) / f"{day:%Y%m%d}_{fmt.name}.csv"
        if cached.exists():
            return cached.read_text(encoding="utf-8")

    try:
        payload = _download(fmt.url, timeout)
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            raise BhavcopyUnavailable(f"no {fmt.name} bhavcopy for {day}") from None
        raise

    archive = zipfile.ZipFile(io.BytesIO(payload))
    text = archive.read(archive.namelist()[0]).decode("utf-8", errors="replace")

    if cached is not None:
        cached.parent.mkdir(parents=True, exist_ok=True)
        cached.write_text(text, encoding="utf-8")
    return text


def _bar(symbol, isin, series, day, o, h, low, c, volume) -> DailyBar:
    return DailyBar(
        symbol=symbol, isin=isin, series=series, session_date=day,
        open=to_minor(o, CURRENCY), high=to_minor(h, CURRENCY),
        low=to_minor(low, CURRENCY), close=to_minor(c, CURRENCY),
        volume=int(float(volume)),
    )


def parse_udiff(text: str, day: date) -> list[DailyBar]:
    bars = []
    for row in csv.DictReader(io.StringIO(text)):
        if (row.get("SctySrs") or "").strip() not in EQUITY_SERIES:
            continue
        if (row.get("FinInstrmTp") or "").strip() not in {"STK", ""}:
            continue
        bars.append(_bar(
            row["TckrSymb"], row["ISIN"], row["SctySrs"], day,
            row["OpnPric"], row["HghPric"], row["LwPric"], row["ClsPric"], row["TtlTradgVol"],
        ))
    return bars


def parse_legacy(text: str, day: date) -> list[DailyBar]:
    bars = []
    for row in csv.DictReader(io.StringIO(text)):
        clean = {(k or "").strip(): (v or "").strip() for k, v in row.items()}
        if clean.get("SERIES") not in EQUITY_SERIES:
            continue
        bars.append(_bar(
            clean["SYMBOL"], clean["ISIN"], clean["SERIES"], day,
            clean["OPEN"], clean["HIGH"], clean["LOW"], clean["CLOSE"], clean["TOTTRDQTY"],
        ))
    return bars


PARSERS = {"udiff": parse_udiff, "legacy": parse_legacy}


def load_day(day: date, cache_dir: Path | None = None, prefer: str | None = None,
             timeout: float = 30.0) -> tuple[str, list[DailyBar]]:
    """Return (format_name, bars). Raises BhavcopyUnavailable when no format has the date."""
    candidates = formats_for(day)
    if prefer is not None:
        candidates = tuple(f for f in candidates if f.name == prefer) or candidates
    last: Exception | None = None
    for fmt in candidates:
        try:
            text = fetch_raw(day, fmt, cache_dir, timeout)
        except BhavcopyUnavailable as exc:
            last = exc
            continue
        return fmt.name, PARSERS[fmt.name](text, day)
    raise last or BhavcopyUnavailable(f"no bhavcopy for {day}")


def to_spine_rows(bars: list[DailyBar]) -> list[dict]:
    ts = None
    rows = []
    for bar in bars:
        if ts is None:
            ts = session_timestamp(bar.session_date)
        rows.append({
            "symbol": bar.symbol, "ts_utc": ts,
            "open": bar.open, "high": bar.high, "low": bar.low, "close": bar.close,
            "volume": bar.volume,
        })
    return rows


def trading_days(start: date, end: date):
    day = start
    while day <= end:
        if day.weekday() < 5:
            yield day
        day += timedelta(days=1)


def polite_sleep(seconds: float = 1.0) -> None:
    time.sleep(seconds)
