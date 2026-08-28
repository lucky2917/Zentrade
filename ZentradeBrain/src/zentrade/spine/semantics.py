"""spine_v1 - frozen semantics for the local market data spine."""

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
