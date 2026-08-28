"""Venue-aware wrapper over kernel money. The spine speaks venues; the kernel speaks currencies."""

from __future__ import annotations

from decimal import Decimal

from ..kernel.money import decimal_from_json, from_minor as _from_minor, to_minor as _to_minor
from .semantics import currency_for

__all__ = ["decimal_from_json", "to_minor", "from_minor"]


def to_minor(value: str | Decimal | int, venue: str) -> int:
    return _to_minor(value, currency_for(venue))


def from_minor(minor: int, venue: str) -> Decimal:
    return _from_minor(minor, currency_for(venue))
