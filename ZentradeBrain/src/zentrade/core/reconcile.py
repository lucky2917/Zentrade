"""Reconciliation between internal state and the execution venue."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum


class Divergence(str, Enum):
    NONE = "NONE"
    POSITION_MISMATCH = "POSITION_MISMATCH"
    CASH_MISMATCH = "CASH_MISMATCH"
    UNKNOWN_ORDER = "UNKNOWN_ORDER"
    MISSING_ORDER = "MISSING_ORDER"


@dataclass(frozen=True)
class ReconciliationResult:
    divergence: Divergence
    details: tuple[str, ...] = field(default_factory=tuple)

    @property
    def clean(self) -> bool:
        return self.divergence is Divergence.NONE


def reconcile(internal_positions: dict[str, int], venue_positions: dict[str, int],
              internal_cash: int, venue_cash: int,
              internal_orders: set[str], venue_orders: set[str],
              cash_tolerance: int = 0) -> ReconciliationResult:
    """Any divergence is reported, never absorbed. Silently trusting one side."""
    details: list[str] = []

    symbols = set(internal_positions) | set(venue_positions)
    for symbol in sorted(symbols):
        mine = internal_positions.get(symbol, 0)
        theirs = venue_positions.get(symbol, 0)
        if mine != theirs:
            details.append(f"{symbol}: internal {mine} vs venue {theirs}")
    if details:
        return ReconciliationResult(Divergence.POSITION_MISMATCH, tuple(details))

    if abs(internal_cash - venue_cash) > cash_tolerance:
        return ReconciliationResult(
            Divergence.CASH_MISMATCH,
            (f"internal {internal_cash} vs venue {venue_cash}",))

    unknown = venue_orders - internal_orders
    if unknown:
        return ReconciliationResult(Divergence.UNKNOWN_ORDER, tuple(sorted(unknown)))

    missing = internal_orders - venue_orders
    if missing:
        return ReconciliationResult(Divergence.MISSING_ORDER, tuple(sorted(missing)))

    return ReconciliationResult(Divergence.NONE)
