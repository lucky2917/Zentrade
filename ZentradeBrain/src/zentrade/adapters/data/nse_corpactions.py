"""
NSE corporate actions, date-ranged.

Only two subject forms carry a computable price ratio, and both were read off
live data rather than guessed:

    Bonus 1:1
    Face Value Split (Sub-Division) - From Rs 10/- Per Share To Re 1/- Per Share

Everything else (dividends, demergers, rights) is retained verbatim with
kind="other" and no factor. Nothing is discarded, and the parse rate is
reported so the fragility of free-text parsing stays visible instead of
silently degrading the adjustment table.

POINT-IN-TIME LIMITATION, recorded deliberately. The feed exposes a
caBroadcastDate field but it is empty on every one of 3,152 sampled rows, so
there is no announcement timestamp. known_at is therefore taken as the
ex-date, which is LATER than the true announcement. That errs toward knowing
less, not more, which is the only safe direction for a point-in-time store.
"""

from __future__ import annotations

import json
import re
import time
import urllib.request
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from fractions import Fraction

_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Safari/537.36"
_ENDPOINT = "https://www.nseindia.com/api/corporates-corporateActions?index=equities"
_REFERER = "https://www.nseindia.com/companies-listing/corporate-filings-actions"

BONUS_RE = re.compile(r"bonus\s+(\d+)\s*:\s*(\d+)", re.I)
SPLIT_RE = re.compile(
    r"from\s+(?:rs|re)\.?\s*([\d.]+)\s*/?-?\s*per\s+share\s+to\s+(?:rs|re)\.?\s*([\d.]+)", re.I
)

KIND_SPLIT, KIND_BONUS, KIND_OTHER = "split", "bonus", "other"
# A consolidation is a face-value change in the opposite direction: fewer
# shares, higher price, so historical prices scale UP. Detected by the
# direction of the ratio rather than the wording, because NSE writes both
# "Face Value Split ... From X To Y" and "Consolidation Of Equity Shares
# From X To Y" and only the numbers distinguish them reliably.
KIND_CONSOLIDATION = "consolidation"


@dataclass(frozen=True)
class CorporateAction:
    symbol: str
    isin: str
    ex_date: date
    kind: str
    numerator: int
    denominator: int
    subject: str

    @property
    def price_factor(self) -> Fraction:
        return Fraction(self.numerator, self.denominator)


@dataclass
class ParseReport:
    total: int = 0
    parsed: dict[str, int] = field(default_factory=dict)
    unparsed_subjects: list[str] = field(default_factory=list)

    @property
    def rate(self) -> float:
        return sum(self.parsed.values()) / self.total if self.total else 0.0


def _opener():
    op = urllib.request.build_opener()
    op.addheaders = [("User-Agent", _UA), ("Referer", _REFERER)]
    return op


def _parse_ex_date(text: str) -> date | None:
    try:
        return datetime.strptime(text.strip(), "%d-%b-%Y").date()
    except (ValueError, AttributeError):
        return None


def classify(subject: str) -> tuple[str, int, int]:
    """Return (kind, numerator, denominator). The factor multiplies prices
    BEFORE the ex-date so history is comparable with today."""
    text = (subject or "").strip()

    bonus = BONUS_RE.search(text)
    if bonus:
        # "Bonus a:b" = a new shares for every b held, so b old become a+b.
        a, b = int(bonus.group(1)), int(bonus.group(2))
        if a >= 0 and b > 0:
            ratio = Fraction(b, a + b)
            return KIND_BONUS, ratio.numerator, ratio.denominator

    split = SPLIT_RE.search(text)
    if split:
        # Face value 10 -> 1 means ten times the shares, so a tenth the price.
        # Face value 1 -> 10 is the reverse: a tenth the shares, ten times the
        # price, and historical prices must scale UP to stay comparable.
        old, new = Fraction(split.group(1)), Fraction(split.group(2))
        if old > 0 and new > 0:
            ratio = new / old
            kind = KIND_SPLIT if ratio < 1 else KIND_CONSOLIDATION
            return kind, ratio.numerator, ratio.denominator

    return KIND_OTHER, 1, 1


def fetch_range(start: date, end: date, timeout: float = 30.0) -> list[dict]:
    url = f"{_ENDPOINT}&from_date={start:%d-%m-%Y}&to_date={end:%d-%m-%Y}"
    with _opener().open(url, timeout=timeout) as response:
        payload = json.loads(response.read())
    return payload if isinstance(payload, list) else []


def parse(rows: list[dict]) -> tuple[list[CorporateAction], ParseReport]:
    report = ParseReport(total=len(rows))
    actions = []
    for row in rows:
        ex = _parse_ex_date(row.get("exDate", ""))
        if ex is None:
            continue
        subject = (row.get("subject") or "").strip()
        kind, num, den = classify(subject)
        report.parsed[kind] = report.parsed.get(kind, 0) + 1
        if kind == KIND_OTHER and len(report.unparsed_subjects) < 40:
            report.unparsed_subjects.append(subject)
        actions.append(CorporateAction(
            symbol=(row.get("symbol") or "").strip().upper(),
            isin=(row.get("isin") or "").strip().upper(),
            ex_date=ex, kind=kind, numerator=num, denominator=den, subject=subject,
        ))
    return actions, report


def to_adjustment_rows(actions: list[CorporateAction]) -> list[dict]:
    """Only price-affecting actions enter the adjustment table. `other` is
    retained upstream but must never silently contribute a factor of 1."""
    rows = []
    for action in actions:
        if action.kind not in (KIND_SPLIT, KIND_BONUS, KIND_CONSOLIDATION):
            continue
        effective = datetime(action.ex_date.year, action.ex_date.month, action.ex_date.day,
                             tzinfo=timezone.utc)
        rows.append({
            "symbol": action.symbol,
            "effective_ts_utc": int(effective.timestamp() * 1_000_000),
            "kind": action.kind,
            "numerator": action.numerator,
            "denominator": action.denominator,
            "source": "nse_corporate_actions_api",
        })
    return rows


def polite_sleep(seconds: float = 1.5) -> None:
    time.sleep(seconds)
