"""What Research may ask for, and what the Trading Core answers."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

from .orders import Side


class Veto(str, Enum):
    KILL_SWITCH = "KILL_SWITCH"
    SYSTEM_HALTED = "SYSTEM_HALTED"
    NO_NEW_ENTRIES = "NO_NEW_ENTRIES"
    MALFORMED = "MALFORMED"
    STALE_PROPOSAL = "STALE_PROPOSAL"
    PRICE_DRIFT = "PRICE_DRIFT"
    STALE_MARKET_DATA = "STALE_MARKET_DATA"
    TRADE_COUNT_EXHAUSTED = "TRADE_COUNT_EXHAUSTED"
    TURNOVER_EXHAUSTED = "TURNOVER_EXHAUSTED"
    POSITION_LIMIT = "POSITION_LIMIT"
    GROSS_EXPOSURE = "GROSS_EXPOSURE"
    NET_EXPOSURE = "NET_EXPOSURE"
    SECTOR_LIMIT = "SECTOR_LIMIT"
    SYMBOL_COUNT = "SYMBOL_COUNT"
    INSUFFICIENT_POSITION = "INSUFFICIENT_POSITION"
    BELOW_VIABILITY_FLOOR = "BELOW_VIABILITY_FLOOR"
    BUDGET_EXHAUSTED = "BUDGET_EXHAUSTED"
    DUPLICATE = "DUPLICATE"


@dataclass(frozen=True)
class Proposal:
    """Research proposes. It never decides, and it never sizes the final order."""

    proposal_id: str
    symbol: str
    side: Side
    quantity: int
    reference_price: int
    created_ts: int
    is_exit: bool = False


@dataclass(frozen=True)
class RiskDecision:
    proposal_id: str
    approved: bool
    quantity: int
    veto: Veto | None = None
    binding_constraint: str | None = None
    notes: tuple[str, ...] = ()

    @classmethod
    def reject(cls, proposal: Proposal, veto: Veto, constraint: str) -> RiskDecision:
        return cls(proposal.proposal_id, False, 0, veto, constraint)

    @classmethod
    def allow(cls, proposal: Proposal, quantity: int, constraint: str | None = None,
              notes: tuple[str, ...] = ()) -> RiskDecision:
        return cls(proposal.proposal_id, True, quantity, None, constraint, notes)
