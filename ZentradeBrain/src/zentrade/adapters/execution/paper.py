"""Paper execution. An order submitted now can never fill now."""

from __future__ import annotations

from dataclasses import dataclass, field, replace

from ...core.costs import CostBreakdown, CostSchedule, ProductType, SlippageModel, compute_costs
from ...core.orders import (
    Fill, InvalidTransition, Order, OrderState, RejectReason, Side,
)

DEFAULT_MAX_PARTICIPATION = 0.05
DEFAULT_EXPIRY_SESSIONS = 3
PRICE_BAND = 0.20


class DuplicateOrder(RuntimeError):
    pass


class UnknownOrder(KeyError):
    pass


@dataclass(frozen=True)
class SessionBar:
    symbol: str
    ts_utc: int
    open: int
    high: int
    low: int
    close: int
    volume: int


@dataclass(frozen=True)
class ExecutionConfig:
    max_participation: float = DEFAULT_MAX_PARTICIPATION
    expiry_sessions: int = DEFAULT_EXPIRY_SESSIONS
    product: ProductType = ProductType.DELIVERY
    slippage: SlippageModel = field(default_factory=SlippageModel)
    schedule: CostSchedule = field(default_factory=CostSchedule)
    price_band: float = PRICE_BAND


@dataclass
class Account:
    cash: int
    reserved: int = 0
    positions: dict[str, int] = field(default_factory=dict)

    @property
    def available(self) -> int:
        return self.cash - self.reserved


class PaperBroker:
    """Deterministic execution against session bars."""

    def __init__(self, starting_cash: int, config: ExecutionConfig | None = None) -> None:
        self.config = config or ExecutionConfig()
        self.account = Account(cash=starting_cash)
        self.starting_cash = starting_cash
        self._orders: dict[str, Order] = {}
        self._by_client_id: dict[str, str] = {}
        self._sequence = 0
        self._fills: list[Fill] = []
        self._costs: list[CostBreakdown] = []
        self._reservations: dict[str, int] = {}

    def orders(self) -> tuple[Order, ...]:
        return tuple(self._orders[key] for key in sorted(self._orders))

    def open_orders(self) -> tuple[Order, ...]:
        return tuple(order for order in self.orders() if not order.terminal)

    def fills(self) -> tuple[Fill, ...]:
        return tuple(self._fills)

    def get(self, order_id: str) -> Order:
        try:
            return self._orders[order_id]
        except KeyError:
            raise UnknownOrder(order_id) from None

    def _next_id(self) -> str:
        self._sequence += 1
        return f"ord-{self._sequence:08d}"

    def _reserve_for(self, symbol: str, side: Side, quantity: int, reference: int) -> int:
        if side is Side.SELL:
            return 0
        worst = self.config.slippage.adjusted_price(
            reference, side, self.config.max_participation)
        turnover = worst * quantity
        costs = compute_costs(turnover, side, self.config.product, self.config.schedule)
        return turnover + costs.total

    def submit(self, *, client_order_id: str, symbol: str, side: Side, quantity: int,
               ts_utc: int, reference_price: int) -> Order:
        """Idempotent on client_order_id: resubmitting returns the original."""
        existing = self._by_client_id.get(client_order_id)
        if existing is not None:
            return self._orders[existing]

        order = Order(
            order_id=self._next_id(), client_order_id=client_order_id, symbol=symbol,
            side=side, quantity=quantity, submitted_ts=ts_utc,
            expires_after_sessions=self.config.expiry_sessions,
        )
        self._orders[order.order_id] = order
        self._by_client_id[client_order_id] = order.order_id

        rejection = self._pre_trade_reject(order, reference_price)
        if rejection is not None:
            return self._settle(order.transition(OrderState.REJECTED, reject_reason=rejection))

        reserve = self._reserve_for(symbol, side, quantity, reference_price)
        if side is Side.BUY and reserve > self.account.available:
            return self._settle(
                order.transition(OrderState.REJECTED,
                                 reject_reason=RejectReason.INSUFFICIENT_CASH))

        self.account.reserved += reserve
        order = order.transition(OrderState.ACCEPTED)
        self._orders[order.order_id] = order
        self._reservations[order.order_id] = reserve
        return order

    def _pre_trade_reject(self, order: Order, reference_price: int) -> RejectReason | None:
        if order.quantity <= 0:
            return RejectReason.ZERO_QUANTITY
        if reference_price <= 0:
            return RejectReason.NO_LIQUIDITY
        if order.side is Side.SELL:
            held = self.account.positions.get(order.symbol, 0)
            if held < order.quantity:
                return RejectReason.INSUFFICIENT_POSITION
        return None

    def _settle(self, order: Order) -> Order:
        self._orders[order.order_id] = order
        if order.terminal:
            self._release(order.order_id)
        return order

    def _release(self, order_id: str) -> None:
        released = self._reservations.pop(order_id, 0)
        self.account.reserved -= released

    def cancel(self, order_id: str) -> Order:
        order = self.get(order_id)
        if order.terminal:
            return order
        return self._settle(order.transition(OrderState.CANCELLED))

    def advance(self, bars: dict[str, SessionBar]) -> tuple[Order, ...]:
        """Work every open order against this session. Orders are processed in."""
        touched = []
        for order in self.open_orders():
            bar = bars.get(order.symbol)
            if bar is None or bar.ts_utc <= order.submitted_ts:
                continue
            touched.append(self._work(order, bar))
        return tuple(touched)

    def _work(self, order: Order, bar: SessionBar) -> Order:
        order = replace(order, sessions_open=order.sessions_open + 1)
        self._orders[order.order_id] = order

        if bar.volume <= 0 or int(bar.volume * self.config.max_participation) <= 0:
            return self._maybe_expire(order)

        capacity = int(bar.volume * self.config.max_participation)

        quantity = min(order.remaining, capacity)
        participation = quantity / bar.volume
        price = self.config.slippage.adjusted_price(bar.open, order.side, participation)

        if abs(price - bar.open) > int(bar.open * self.config.price_band):
            return self._settle(order.transition(
                OrderState.REJECTED, reject_reason=RejectReason.PRICE_BAND))

        turnover = price * quantity
        costs = compute_costs(turnover, order.side, self.config.product, self.config.schedule)

        if order.side is Side.BUY and turnover + costs.total > self.account.available + \
                self._reservations.get(order.order_id, 0):
            return self._maybe_expire(order)

        fill = Fill(order.order_id, bar.ts_utc, quantity, price, costs.total)
        order = order.with_fill(fill)
        self._apply_cash(order, fill, costs)
        self._orders[order.order_id] = order
        self._fills.append(fill)
        self._costs.append(costs)

        if order.state is OrderState.FILLED:
            return self._settle(order)
        return self._maybe_expire(order)

    def mark_ambiguous(self, order_id: str) -> Order:
        """Reconciliation could not determine what happened. The order stops."""
        order = self.get(order_id)
        if order.terminal:
            return order
        return self._settle(order.transition(OrderState.AMBIGUOUS))

    def _maybe_expire(self, order: Order) -> Order:
        if order.sessions_open >= order.expires_after_sessions:
            return self._settle(order.transition(OrderState.EXPIRED))
        self._orders[order.order_id] = order
        return order

    def _apply_cash(self, order: Order, fill: Fill, costs: CostBreakdown) -> None:
        gross = fill.gross
        if order.side is Side.BUY:
            self.account.cash -= gross + costs.total
            consumed = min(self._reservations.get(order.order_id, 0), gross + costs.total)
            self._reservations[order.order_id] = \
                self._reservations.get(order.order_id, 0) - consumed
            self.account.reserved -= consumed
            self.account.positions[order.symbol] = \
                self.account.positions.get(order.symbol, 0) + fill.quantity
        else:
            self.account.cash += gross - costs.total
            held = self.account.positions.get(order.symbol, 0) - fill.quantity
            if held:
                self.account.positions[order.symbol] = held
            else:
                self.account.positions.pop(order.symbol, None)

    def audit(self) -> dict[str, int]:
        """Recompute cash and positions from the fill log alone."""
        cash = self.starting_cash
        positions: dict[str, int] = {}
        for fill in self._fills:
            order = self._orders[fill.order_id]
            if order.side is Side.BUY:
                cash -= fill.gross + fill.cost
                positions[order.symbol] = positions.get(order.symbol, 0) + fill.quantity
            else:
                cash += fill.gross - fill.cost
                positions[order.symbol] = positions.get(order.symbol, 0) - fill.quantity
        return {"cash": cash, "positions": {k: v for k, v in positions.items() if v}}

    def conservation_holds(self) -> bool:
        recomputed = self.audit()
        return (recomputed["cash"] == self.account.cash
                and recomputed["positions"] == self.account.positions)
