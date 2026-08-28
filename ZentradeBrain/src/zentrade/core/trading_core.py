"""The Trading Core. Sole writer of positions, orders, risk, kill and reconciliation state."""

from __future__ import annotations

from dataclasses import dataclass, field

from ..adapters.execution.paper import PaperBroker, SessionBar
from .killswitch import KillReason, KillSwitch
from .limits import RiskInputs, RiskLimits, SystemState
from .orders import Order, Side
from .proposals import Proposal, RiskDecision, Veto
from .reconcile import Divergence, ReconciliationResult, reconcile
from .risk import PortfolioView, RiskCore

DRAWDOWN_LADDER = ((0.15, 0.3), (0.10, 0.6), (0.05, 0.8))


def drawdown_scalar(equity: int, peak: int) -> float:
    """Account axis. Separate from model trust by construction."""
    if peak <= 0 or equity >= peak:
        return 1.0
    drop = (peak - equity) / peak
    for threshold, scalar in DRAWDOWN_LADDER:
        if drop >= threshold:
            return scalar
    return 1.0


@dataclass
class SessionCounters:
    trades: int = 0
    turnover: int = 0
    session_ts: int = 0

    def roll_to(self, session_ts: int) -> None:
        if session_ts != self.session_ts:
            self.session_ts = session_ts
            self.trades = 0
            self.turnover = 0


@dataclass
class CoreJournal:
    """Append-only record of every authoritative change, and the only thing a."""

    decisions: list[tuple[int, RiskDecision]] = field(default_factory=list)
    kill_events: list[tuple[int, str]] = field(default_factory=list)
    reconciliations: list[tuple[int, str]] = field(default_factory=list)


class TradingCore:
    def __init__(self, broker: PaperBroker, risk: RiskCore | None = None,
                 limits: RiskLimits | None = None) -> None:
        self._broker = broker
        self.limits = limits or RiskLimits()
        self.risk = risk or RiskCore(self.limits)
        self.risk.limits = self.limits
        self.kill_switch = self.risk.kill_switch
        self.counters = SessionCounters()
        self.journal = CoreJournal()
        self._prices: dict[str, int] = {}
        self._price_ts: dict[str, int] = {}
        self._equity_peak = broker.account.cash
        self._halted_state = SystemState.NORMAL

    def observe_prices(self, bars: dict[str, SessionBar]) -> None:
        for symbol, bar in bars.items():
            self._prices[symbol] = bar.close
            self._price_ts[symbol] = bar.ts_utc

    def snapshot(self) -> PortfolioView:
        """Fresh containers every call, so a consumer mutating what it receives."""
        return PortfolioView(
            cash=self._broker.account.cash,
            positions=dict(self._broker.account.positions),
            prices=dict(self._prices),
            price_ts=dict(self._price_ts),
            equity_peak=self._equity_peak,
            session_trades=self.counters.trades,
            session_turnover=self.counters.turnover,
            open_client_ids=frozenset(
                order.client_order_id for order in self._broker.open_orders()),
        )

    def equity(self) -> int:
        return self.snapshot().equity()

    def risk_inputs(self, *, regime_confidence: float = 1.0, health_scalar: float = 1.0,
                    ood_scalar: float = 1.0, state: SystemState | None = None) -> RiskInputs:
        equity = self.equity()
        self._equity_peak = max(self._equity_peak, equity)
        return RiskInputs(
            regime_confidence=regime_confidence,
            health_scalar=health_scalar,
            ood_scalar=ood_scalar,
            drawdown_scalar=drawdown_scalar(equity, self._equity_peak),
            state=state or self._halted_state,
        )

    def submit_proposal(self, proposal: Proposal, inputs: RiskInputs,
                        now_ts: int) -> tuple[RiskDecision, Order | None]:
        """The only path from a proposal to an order."""
        self.counters.roll_to(now_ts)
        decision = self.risk.evaluate(proposal, portfolio=self.snapshot(),
                                      inputs=inputs, now_ts=now_ts)
        self.journal.decisions.append((now_ts, decision))
        if not decision.approved:
            return decision, None

        order = self._broker.submit(
            client_order_id=proposal.proposal_id, symbol=proposal.symbol,
            side=proposal.side, quantity=decision.quantity, ts_utc=now_ts,
            reference_price=self._prices[proposal.symbol],
        )
        if order.state.value != "REJECTED":
            self.counters.trades += 1
            self.counters.turnover += decision.quantity * self._prices[proposal.symbol]
        return decision, order

    def advance(self, bars: dict[str, SessionBar]) -> tuple[Order, ...]:
        self.observe_prices(bars)
        worked = self._broker.advance(bars)
        self._check_account_limits(max((b.ts_utc for b in bars.values()), default=0))
        return worked

    def _check_account_limits(self, ts_utc: int) -> None:
        equity = self.equity()
        self._equity_peak = max(self._equity_peak, equity)
        if self._equity_peak <= 0:
            return
        drop = (self._equity_peak - equity) / self._equity_peak
        if drop >= self.limits.max_drawdown_pct:
            self.engage_kill(KillReason.MAX_DRAWDOWN, ts_utc)
        elif self._equity_peak - equity >= self.limits.max_daily_loss:
            self.engage_kill(KillReason.DAILY_LOSS_LIMIT, ts_utc)

    def engage_kill(self, reason: KillReason, ts_utc: int) -> None:
        """Engaging cancels working orders and stops new entries. It never."""
        already = self.kill_switch.engaged
        self.kill_switch.engage(reason, ts_utc)
        if already:
            return
        self.journal.kill_events.append((ts_utc, reason.value))
        for order in self._broker.open_orders():
            self._broker.cancel(order.order_id)
        self._halted_state = SystemState.HALTED

    def reset_kill(self, operator: str) -> None:
        self.kill_switch.reset(operator)
        self._halted_state = SystemState.NORMAL

    def reconcile_against(self, venue_positions: dict[str, int], venue_cash: int,
                          venue_orders: set[str], ts_utc: int) -> ReconciliationResult:
        result = reconcile(
            dict(self._broker.account.positions), venue_positions,
            self._broker.account.cash, venue_cash,
            {o.order_id for o in self._broker.open_orders()}, venue_orders,
        )
        self.journal.reconciliations.append((ts_utc, result.divergence.value))
        if not result.clean:
            self.engage_kill(KillReason.RECONCILIATION_DIVERGENCE, ts_utc)
        return result

    def state_snapshot(self) -> dict:
        return {
            "cash": self._broker.account.cash,
            "positions": dict(self._broker.account.positions),
            "reserved": self._broker.account.reserved,
            "equity_peak": self._equity_peak,
            "kill": self.kill_switch.snapshot(),
            "session_trades": self.counters.trades,
            "session_turnover": self.counters.turnover,
            "system_state": self._halted_state.value,
        }
