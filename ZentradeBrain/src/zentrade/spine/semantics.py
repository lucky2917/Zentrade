"""
spine_v1 - frozen semantics for the local market data spine.

Laws. Changing any of these requires a spine_v2, which coexists with v1 and
never reinterprets rows written under it:

1. Prices are stored RAW, as integers in currency minor units. Corporate
   actions are never applied in place and history is never rewritten.
2. Timestamps are UTC microseconds since the epoch. Venue-local session time
   is derived at read time and never stored.
3. A bar's identity is (venue, symbol, granularity, ts_utc). Ingestion is
   idempotent on that key.
4. Adjustment factors live in their own append-only table and are applied at
   read time.
5. No row may carry information that was unavailable at its ts_utc.

Law 1 is the one that costs something up front and pays later: storing
adjusted prices means every new split silently rewrites history, which breaks
the byte-for-byte reproducibility the rest of this codebase is built on.
"""

from __future__ import annotations

import pyarrow as pa

from ..kernel.money import CURRENCY_SCALES, scale_for_currency

SEMANTICS_ID = "spine_v1"

DAILY = "1d"
MINUTE = "1m"
GRANULARITIES = (DAILY, MINUTE)

VENUE_CURRENCY = {
    "NSE": "INR",
    "BSE": "INR",
}

PRICE_FIELDS = ("open", "high", "low", "close")

BAR_SCHEMA = pa.schema(
    [
        pa.field("symbol", pa.string(), nullable=False),
        pa.field("ts_utc", pa.int64(), nullable=False),
        pa.field("open", pa.int64(), nullable=False),
        pa.field("high", pa.int64(), nullable=False),
        pa.field("low", pa.int64(), nullable=False),
        pa.field("close", pa.int64(), nullable=False),
        pa.field("volume", pa.int64(), nullable=False),
    ]
)

ADJUSTMENT_SCHEMA = pa.schema(
    [
        pa.field("symbol", pa.string(), nullable=False),
        pa.field("effective_ts_utc", pa.int64(), nullable=False),
        pa.field("kind", pa.string(), nullable=False),
        pa.field("numerator", pa.int64(), nullable=False),
        pa.field("denominator", pa.int64(), nullable=False),
        pa.field("source", pa.string(), nullable=False),
    ]
)

# consolidation (reverse split) added after live data showed VERTOZ going
# Re 1 -> Rs 10. Additive: no existing row changes meaning.
ADJUSTMENT_KINDS = ("split", "bonus", "consolidation", "dividend")

SORT_KEY = ("ts_utc", "symbol")


class SemanticsError(ValueError):
    """Raised when an input violates a frozen spine_v1 law."""


def currency_for(venue: str) -> str:
    try:
        return VENUE_CURRENCY[venue]
    except KeyError:
        raise SemanticsError(f"unknown venue: {venue!r}") from None


def scale_for(venue: str) -> int:
    return scale_for_currency(currency_for(venue))


def require_granularity(granularity: str) -> str:
    if granularity not in GRANULARITIES:
        raise SemanticsError(
            f"unknown granularity {granularity!r}, expected one of {GRANULARITIES}"
        )
    return granularity
