"""Integer minor-unit arithmetic. Kernel-level: imports nothing internal."""

from __future__ import annotations

import json
from decimal import Decimal, InvalidOperation
from typing import Any

CURRENCY_SCALES = {"INR": 2, "USD": 2}


class MoneyError(ValueError):
    """Raised when a value cannot be represented exactly in minor units."""


def decimal_from_json(text: str | bytes) -> Any:
    return json.loads(text, parse_float=Decimal)


def scale_for_currency(currency: str) -> int:
    try:
        return CURRENCY_SCALES[currency]
    except KeyError:
        raise MoneyError(f"unknown currency: {currency!r}") from None


def to_minor(value: str | Decimal | int, currency: str) -> int:
    if isinstance(value, bool):
        raise MoneyError(f"refusing bool as price: {value!r}")
    if isinstance(value, float):
        raise MoneyError(
            f"refusing float price {value!r}: decode with decimal_from_json, or pass a str"
        )

    if isinstance(value, int):
        amount = Decimal(value)
    elif isinstance(value, Decimal):
        amount = value
    elif isinstance(value, str):
        try:
            amount = Decimal(value.strip())
        except InvalidOperation:
            raise MoneyError(f"not a decimal amount: {value!r}") from None
    else:
        raise MoneyError(f"unsupported price type: {type(value).__name__}")

    if not amount.is_finite():
        raise MoneyError(f"price is not finite: {value!r}")

    scale = scale_for_currency(currency)
    shifted = amount.scaleb(scale)
    if shifted != shifted.to_integral_value():
        raise MoneyError(f"price {value!r} exceeds {scale} fractional digits for {currency}")
    return int(shifted)


def from_minor(minor: int, currency: str) -> Decimal:
    return Decimal(minor).scaleb(-scale_for_currency(currency))
