"""The authoritative risk gate. Every proposal passes through it or does not execute."""

from __future__ import annotations

from dataclasses import dataclass, field

from .killswitch import KillSwitch
from .limits import (
    ABSORBING_STATES, RiskInputs, RiskLimits, SystemState, UNKNOWN_SECTOR,
    budget_multiplier,
)
from .orders import Side
from .proposals import Proposal, RiskDecision, Veto


@dataclass(frozen=True)
class PortfolioView:
    """A read-only snapshot. Research receives this and can mutate nothing."""

    cash: int
    positions: dict[str, int] = field(default_factory=dict)
    prices: dict[str, int] = field(default_factory=dict)
    price_ts: dict[str, int] = field(default_factory=dict)
    equity_peak: int = 0
    session_trades: int = 0
    session_turnover: int = 0
    open_client_ids: frozenset[str] = frozenset()

    def value_of(self, symbol: str) -> int:
        return self.positions.get(symbol, 0) * self.prices.get(symbol, 0)

    def gross_exposure(self) -> int:
        return sum(abs(self.value_of(s)) for s in self.positions)

    def net_exposure(self) -> int:
        return sum(self.value_of(s) for s in self.positions)

    def equity(self) -> int:
        return self.cash + self.net_exposure()


class RiskCore:
    """Deterministic, fail-closed, and the only path to execution."""

    def __init__(self, limits: RiskLimits | None = None,
                 sectors: dict[str, str] | None = None,
                 kill_switch: KillSwitch | None = None) -> None:
        self.limits = limits or RiskLimits()
        self.sectors = dict(sectors or {})
        self.kill_switch = kill_switch or KillSwitch()

    def sector_of(self, symbol: str) -> str:
        return self.sectors.get(symbol, UNKNOWN_SECTOR)

    def sector_exposure(self, portfolio: PortfolioView, sector: str) -> int:
        return sum(abs(portfolio.value_of(s)) for s in portfolio.positions
                   if self.sector_of(s) == sector)

    def evaluate(self, proposal: Proposal, *, portfolio: PortfolioView,
                 inputs: RiskInputs, now_ts: int) -> RiskDecision:
        limits = self.limits

        if self.kill_switch.engaged:
            return RiskDecision.reject(proposal, Veto.KILL_SWITCH,
                                       f"kill switch: {self.kill_switch.reason}")

        if not isinstance(proposal.quantity, int) or proposal.quantity <= 0:
            return RiskDecision.reject(proposal, Veto.MALFORMED, "quantity must be a positive int")
        if proposal.reference_price <= 0:
            return RiskDecision.reject(proposal, Veto.MALFORMED, "reference price must be positive")
        if not proposal.symbol:
            return RiskDecision.reject(proposal, Veto.MALFORMED, "symbol is required")
        if proposal.proposal_id in portfolio.open_client_ids:
            return RiskDecision.reject(proposal, Veto.DUPLICATE, "proposal already working")

        if inputs.state is SystemState.HALTED and not proposal.is_exit:
            return RiskDecision.reject(proposal, Veto.SYSTEM_HALTED, "system halted")
        if inputs.state in ABSORBING_STATES and not proposal.is_exit:
            return RiskDecision.reject(proposal, Veto.NO_NEW_ENTRIES, inputs.state.value)

        age = now_ts - proposal.created_ts
        if age < 0 or age > limits.max_proposal_age_us:
            return RiskDecision.reject(proposal, Veto.STALE_PROPOSAL, f"age {age}us")

        price = portfolio.prices.get(proposal.symbol)
        price_ts = portfolio.price_ts.get(proposal.symbol)
        if price is None or price <= 0 or price_ts is None:
            return RiskDecision.reject(proposal, Veto.STALE_MARKET_DATA,
                                       f"no usable price for {proposal.symbol}")
        data_age = now_ts - price_ts
        if data_age < 0 or data_age > limits.max_proposal_age_us:
            return RiskDecision.reject(proposal, Veto.STALE_MARKET_DATA, f"data age {data_age}us")

        drift_bps = abs(price - proposal.reference_price) / proposal.reference_price * 10_000
        if drift_bps > limits.max_price_drift_bps:
            return RiskDecision.reject(proposal, Veto.PRICE_DRIFT, f"{drift_bps:.1f}bps")

        held = portfolio.positions.get(proposal.symbol, 0)
        if proposal.side is Side.SELL and proposal.quantity > held:
            return RiskDecision.reject(proposal, Veto.INSUFFICIENT_POSITION,
                                       f"holds {held}, asked {proposal.quantity}")

        if proposal.side is Side.SELL:
            return RiskDecision.allow(proposal, proposal.quantity, "risk reducing")

        if portfolio.session_trades >= limits.max_trades_per_session:
            return RiskDecision.reject(proposal, Veto.TRADE_COUNT_EXHAUSTED,
                                       f"{portfolio.session_trades} trades used")
        if portfolio.session_turnover >= limits.max_turnover_per_session:
            return RiskDecision.reject(proposal, Veto.TURNOVER_EXHAUSTED,
                                       f"{portfolio.session_turnover} used")

        if held == 0 and len(portfolio.positions) >= limits.max_symbols_held:
            return RiskDecision.reject(proposal, Veto.SYMBOL_COUNT,
                                       f"{len(portfolio.positions)} symbols held")

        multiplier = budget_multiplier(inputs)
        if multiplier <= 0.0:
            return RiskDecision.reject(proposal, Veto.BUDGET_EXHAUSTED, "risk budget is zero")

        allowed, constraint = self._headroom(proposal, portfolio, price, multiplier)
        if allowed <= 0:
            return RiskDecision.reject(proposal, Veto.POSITION_LIMIT
                                       if constraint == "position" else _veto_for(constraint),
                                       constraint)

        quantity = min(proposal.quantity, allowed)
        if quantity * price < limits.viability_floor:
            return RiskDecision.reject(proposal, Veto.BELOW_VIABILITY_FLOOR,
                                       f"{quantity * price} below floor")

        notes = () if quantity == proposal.quantity else (f"clamped by {constraint}",)
        return RiskDecision.allow(proposal, quantity, constraint, notes)

    def _headroom(self, proposal: Proposal, portfolio: PortfolioView,
                  price: int, multiplier: float) -> tuple[int, str]:
        """Smallest headroom across every value limit, scaled by the budget."""
        limits = self.limits
        sector = self.sector_of(proposal.symbol)

        candidates = [
            (limits.max_position_value - abs(portfolio.value_of(proposal.symbol)), "position"),
            (limits.max_gross_exposure - portfolio.gross_exposure(), "gross_exposure"),
            (limits.max_net_exposure - abs(portfolio.net_exposure()), "net_exposure"),
            (limits.max_sector_exposure - self.sector_exposure(portfolio, sector), "sector"),
            (limits.max_turnover_per_session - portfolio.session_turnover, "turnover"),
            (max(0, portfolio.cash), "cash"),
        ]
        headroom, constraint = min(candidates, key=lambda pair: pair[0])
        headroom = int(headroom * multiplier)
        return max(0, headroom // price), constraint


_CONSTRAINT_VETO = {
    "position": Veto.POSITION_LIMIT,
    "gross_exposure": Veto.GROSS_EXPOSURE,
    "net_exposure": Veto.NET_EXPOSURE,
    "sector": Veto.SECTOR_LIMIT,
    "turnover": Veto.TURNOVER_EXHAUSTED,
    "cash": Veto.BUDGET_EXHAUSTED,
}


def _veto_for(constraint: str) -> Veto:
    return _CONSTRAINT_VETO.get(constraint, Veto.BUDGET_EXHAUSTED)
