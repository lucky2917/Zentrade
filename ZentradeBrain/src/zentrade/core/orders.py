"""Order lifecycle. Transitions are an explicit table, never implied by code paths."""

from __future__ import annotations

from dataclasses import dataclass, field, replace
from enum import Enum


class OrderState(str, Enum):
    NEW = "NEW"
    ACCEPTED = "ACCEPTED"
    PARTIALLY_FILLED = "PARTIALLY_FILLED"
    FILLED = "FILLED"
    CANCELLED = "CANCELLED"
    REJECTED = "REJECTED"
    EXPIRED = "EXPIRED"
    AMBIGUOUS = "AMBIGUOUS"


TERMINAL_STATES = frozenset({
    OrderState.FILLED, OrderState.CANCELLED, OrderState.REJECTED,
    OrderState.EXPIRED, OrderState.AMBIGUOUS,
})

VALID_TRANSITIONS: dict[OrderState, frozenset[OrderState]] = {
    OrderState.NEW: frozenset({
        OrderState.ACCEPTED, OrderState.REJECTED, OrderState.AMBIGUOUS}),
    OrderState.ACCEPTED: frozenset({
        OrderState.PARTIALLY_FILLED, OrderState.FILLED, OrderState.CANCELLED,
        OrderState.EXPIRED, OrderState.AMBIGUOUS}),
    OrderState.PARTIALLY_FILLED: frozenset({
        OrderState.PARTIALLY_FILLED, OrderState.FILLED, OrderState.CANCELLED,
        OrderState.EXPIRED, OrderState.AMBIGUOUS}),
    OrderState.FILLED: frozenset(),
    OrderState.CANCELLED: frozenset(),
    OrderState.REJECTED: frozenset(),
    OrderState.EXPIRED: frozenset(),
    OrderState.AMBIGUOUS: frozenset(),
}


class Side(str, Enum):
    BUY = "BUY"
    SELL = "SELL"

    @property
    def sign(self) -> int:
        return 1 if self is Side.BUY else -1


class RejectReason(str, Enum):
    NO_LIQUIDITY = "NO_LIQUIDITY"
    PRICE_BAND = "PRICE_BAND"
    ZERO_QUANTITY = "ZERO_QUANTITY"
    UNKNOWN_SYMBOL = "UNKNOWN_SYMBOL"
    INSUFFICIENT_CASH = "INSUFFICIENT_CASH"
    INSUFFICIENT_POSITION = "INSUFFICIENT_POSITION"


class InvalidTransition(RuntimeError):
    def __init__(self, order_id: str, current: OrderState, requested: OrderState) -> None:
        super().__init__(f"order {order_id}: {current.value} cannot become {requested.value}")
        self.order_id = order_id
        self.current = current
        self.requested = requested


@dataclass(frozen=True)
class Fill:
    order_id: str
    ts_utc: int
    quantity: int
    price: int
    cost: int

    @property
    def gross(self) -> int:
        return self.quantity * self.price


@dataclass(frozen=True)
class Order:
    order_id: str
    client_order_id: str
    symbol: str
    side: Side
    quantity: int
    submitted_ts: int
    expires_after_sessions: int
    state: OrderState = OrderState.NEW
    filled_quantity: int = 0
    fills: tuple[Fill, ...] = field(default_factory=tuple)
    reject_reason: RejectReason | None = None
    sessions_open: int = 0

    @property
    def remaining(self) -> int:
        return self.quantity - self.filled_quantity

    @property
    def terminal(self) -> bool:
        return self.state in TERMINAL_STATES

    @property
    def average_price(self) -> int | None:
        if not self.fills:
            return None
        value = sum(fill.quantity * fill.price for fill in self.fills)
        return value // self.filled_quantity

    @property
    def total_cost(self) -> int:
        return sum(fill.cost for fill in self.fills)

    def transition(self, target: OrderState, **updates) -> Order:
        if target not in VALID_TRANSITIONS[self.state]:
            raise InvalidTransition(self.order_id, self.state, target)
        return replace(self, state=target, **updates)

    def with_fill(self, fill: Fill) -> Order:
        filled = self.filled_quantity + fill.quantity
        if filled > self.quantity:
            raise ValueError(
                f"order {self.order_id}: fill of {fill.quantity} exceeds remaining {self.remaining}"
            )
        target = OrderState.FILLED if filled == self.quantity else OrderState.PARTIALLY_FILLED
        return self.transition(target, filled_quantity=filled, fills=self.fills + (fill,))
