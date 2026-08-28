"""Order state machine, exhaustively."""
import pytest

from zentrade.core.orders import (
    Fill, InvalidTransition, Order, OrderState, RejectReason, Side, TERMINAL_STATES,
    VALID_TRANSITIONS,
)

ALL_STATES = list(OrderState)


def order(state=OrderState.NEW, quantity=100, filled=0, fills=()):
    return Order("o1", "c1", "AAA", Side.BUY, quantity, submitted_ts=1,
                 expires_after_sessions=3, state=state,
                 filled_quantity=filled, fills=fills)


class TestTransitionTable:
    @pytest.mark.parametrize("state", ALL_STATES)
    def test_every_state_is_in_the_table(self, state):
        assert state in VALID_TRANSITIONS

    @pytest.mark.parametrize("state", sorted(TERMINAL_STATES, key=lambda s: s.value))
    def test_terminal_states_have_no_exits(self, state):
        assert VALID_TRANSITIONS[state] == frozenset()
        assert order(state).terminal

    @pytest.mark.parametrize("source", ALL_STATES)
    @pytest.mark.parametrize("target", ALL_STATES)
    def test_only_tabled_transitions_are_permitted(self, source, target):
        candidate = order(source)
        if target in VALID_TRANSITIONS[source]:
            assert candidate.transition(target).state is target
        else:
            with pytest.raises(InvalidTransition):
                candidate.transition(target)

    def test_new_can_never_jump_straight_to_filled(self):
        with pytest.raises(InvalidTransition):
            order(OrderState.NEW).transition(OrderState.FILLED)

    def test_rejected_is_terminal(self):
        rejected = order(OrderState.NEW).transition(
            OrderState.REJECTED, reject_reason=RejectReason.ZERO_QUANTITY)
        assert rejected.terminal
        with pytest.raises(InvalidTransition):
            rejected.transition(OrderState.ACCEPTED)


class TestFillAccounting:
    def test_partial_then_complete(self):
        working = order(OrderState.ACCEPTED)
        working = working.with_fill(Fill("o1", 2, 40, 100_00, 10))
        assert working.state is OrderState.PARTIALLY_FILLED
        assert working.remaining == 60
        working = working.with_fill(Fill("o1", 3, 60, 101_00, 10))
        assert working.state is OrderState.FILLED
        assert working.remaining == 0

    def test_overfill_is_impossible(self):
        working = order(OrderState.ACCEPTED)
        with pytest.raises(ValueError, match="exceeds remaining"):
            working.with_fill(Fill("o1", 2, 101, 100_00, 10))

    def test_sum_of_fills_equals_filled_quantity(self):
        working = order(OrderState.ACCEPTED)
        for quantity in (10, 20, 30, 40):
            working = working.with_fill(Fill("o1", 2, quantity, 100_00, 1))
        assert sum(f.quantity for f in working.fills) == working.filled_quantity == 100

    def test_average_price_is_quantity_weighted(self):
        working = order(OrderState.ACCEPTED, quantity=100)
        working = working.with_fill(Fill("o1", 2, 50, 100_00, 0))
        working = working.with_fill(Fill("o1", 3, 50, 200_00, 0))
        assert working.average_price == 150_00

    def test_total_cost_sums_fills(self):
        working = order(OrderState.ACCEPTED)
        working = working.with_fill(Fill("o1", 2, 50, 100_00, 111))
        working = working.with_fill(Fill("o1", 3, 50, 100_00, 222))
        assert working.total_cost == 333


class TestSide:
    def test_signs(self):
        assert Side.BUY.sign == 1 and Side.SELL.sign == -1
