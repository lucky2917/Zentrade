"""The Trading Core. Sole writer of positions, orders, risk, kill and reconciliation state."""

from __future__ import annotations

from dataclasses import dataclass, field

from pathlib import Path

from ..adapters.execution.paper import ExecutionConfig, PaperBroker, SessionBar
from .killswitch import KillReason, KillSwitch
from .orders import Fill, Order, OrderState, RejectReason
from .store import CoreStore
from .limits import RiskInputs, RiskLimits, SystemState
from .orders import Side
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
                 limits: RiskLimits | None = None, store: CoreStore | None = None) -> None:
        self._broker = broker
        self._store = store
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
        if self._store is not None:
            self.persist()

    def persist(self) -> None:
        """Checkpoint the whole authoritative state in one transaction. A."""
        if self._store is None:
            return
        self._store.checkpoint(
            cash=self._broker.account.cash,
            reserved=self._broker.account.reserved,
            equity_peak=self._equity_peak,
            positions=dict(self._broker.account.positions),
            kill=self.kill_switch.snapshot(),
            system_state=self._halted_state.value,
            session={"session_ts": self.counters.session_ts,
                     "trades": self.counters.trades,
                     "turnover": self.counters.turnover},
            orders=[{
                "order_id": o.order_id, "client_order_id": o.client_order_id,
                "symbol": o.symbol, "side": o.side.value, "quantity": o.quantity,
                "state": o.state.value, "filled_quantity": o.filled_quantity,
                "submitted_ts": o.submitted_ts, "sessions_open": o.sessions_open,
                "reject_reason": o.reject_reason.value if o.reject_reason else None,
            } for o in self._broker.orders()],
            fills=[{"order_id": f.order_id, "ts_utc": f.ts_utc, "quantity": f.quantity,
                    "price": f.price, "cost": f.cost} for f in self._broker.fills()],
        )

    @classmethod
    def recover(cls, store: CoreStore, risk: RiskCore | None = None,
                limits: RiskLimits | None = None,
                config: ExecutionConfig | None = None) -> tuple[TradingCore, tuple[str, ...]]:
        """Restart from the store. Orders that were in flight cannot be known."""
        state = store.load()
        broker = PaperBroker(state.starting_cash, config or ExecutionConfig())
        broker.account.cash = state.cash
        broker.account.reserved = 0
        broker.account.positions = dict(state.positions)

        ambiguous: list[str] = []
        fills_by_order: dict[str, list[Fill]] = {}
        for row in store.fills():
            fills_by_order.setdefault(row["order_id"], []).append(
                Fill(row["order_id"], row["ts_utc"], row["quantity"], row["price"], row["cost"]))

        highest = 0
        for row in store.orders():
            in_flight = row["state"] in ("NEW", "ACCEPTED", "PARTIALLY_FILLED")
            order = Order(
                order_id=row["order_id"], client_order_id=row["client_order_id"],
                symbol=row["symbol"], side=Side(row["side"]), quantity=row["quantity"],
                submitted_ts=row["submitted_ts"],
                expires_after_sessions=(config or ExecutionConfig()).expiry_sessions,
                state=OrderState.AMBIGUOUS if in_flight else OrderState(row["state"]),
                filled_quantity=row["filled_quantity"],
                fills=tuple(fills_by_order.get(row["order_id"], ())),
                reject_reason=RejectReason(row["reject_reason"]) if row["reject_reason"] else None,
                sessions_open=row["sessions_open"],
            )
            broker._orders[order.order_id] = order
            broker._by_client_id[order.client_order_id] = order.order_id
            if in_flight:
                ambiguous.append(order.order_id)
            suffix = order.order_id.rsplit("-", 1)[-1]
            if suffix.isdigit():
                highest = max(highest, int(suffix))
        broker._sequence = highest
        broker._fills = [f for fills in fills_by_order.values() for f in fills]

        core = cls(broker, risk, limits, store=None)
        core._equity_peak = state.equity_peak
        core.counters.session_ts = state.session["session_ts"]
        core.counters.trades = state.session["trades"]
        core.counters.turnover = state.session["turnover"]
        core.kill_switch.engaged = state.kill["engaged"]
        core.kill_switch.reason = (KillReason(state.kill["reason"])
                                   if state.kill["reason"] else None)
        core.kill_switch.engaged_ts = state.kill["engaged_ts"]
        core.kill_switch.trip_count = state.kill["trip_count"]
        core._halted_state = SystemState(state.kill["system_state"])
        core._store = store

        if ambiguous:
            core.engage_kill(KillReason.EXECUTION_DIVERGENCE, state.kill["engaged_ts"] or 0)
            store.record_event(0, "RECOVERY_AMBIGUOUS", ",".join(sorted(ambiguous)))
        core.persist()
        return core, tuple(sorted(ambiguous))

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
        if self._store is not None:
            self._store.record_decision(now_ts, decision)
        if not decision.approved:
            self.persist()
            return decision, None

        order = self._broker.submit(
            client_order_id=proposal.proposal_id, symbol=proposal.symbol,
            side=proposal.side, quantity=decision.quantity, ts_utc=now_ts,
            reference_price=self._prices[proposal.symbol],
        )
        if order.state.value != "REJECTED":
            self.counters.trades += 1
            self.counters.turnover += decision.quantity * self._prices[proposal.symbol]
        self.persist()
        return decision, order

    def advance(self, bars: dict[str, SessionBar]) -> tuple[Order, ...]:
        self.observe_prices(bars)
        worked = self._broker.advance(bars)
        self._check_account_limits(max((b.ts_utc for b in bars.values()), default=0))
        self.persist()
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
        if self._store is not None:
            self._store.record_event(ts_utc, "KILL", reason.value)
        for order in self._broker.open_orders():
            self._broker.cancel(order.order_id)
        self._halted_state = SystemState.HALTED
        self.persist()

    def reset_kill(self, operator: str) -> None:
        self.kill_switch.reset(operator)
        self._halted_state = SystemState.NORMAL
        if self._store is not None:
            self._store.record_event(0, "KILL_RESET", operator)
        self.persist()

    def reconcile_against(self, venue_positions: dict[str, int], venue_cash: int,
                          venue_orders: set[str], ts_utc: int) -> ReconciliationResult:
        result = reconcile(
            dict(self._broker.account.positions), venue_positions,
            self._broker.account.cash, venue_cash,
            {o.order_id for o in self._broker.open_orders()}, venue_orders,
        )
        self.journal.reconciliations.append((ts_utc, result.divergence.value))
        if self._store is not None:
            self._store.record_event(ts_utc, "RECONCILE",
                                     f"{result.divergence.value}:{';'.join(result.details)}")
        if not result.clean:
            self.engage_kill(KillReason.RECONCILIATION_DIVERGENCE, ts_utc)
        self.persist()
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
