"""Paper execution under adversarial and degenerate conditions."""
import numpy as np
import pytest

from zentrade.adapters.execution.paper import (
    ExecutionConfig, PaperBroker, SessionBar, UnknownOrder,
)
from zentrade.core.costs import ProductType, SlippageModel
from zentrade.core.orders import OrderState, RejectReason, Side

CASH = 100_000_000_00


def broker(cash=CASH, **kwargs):
    return PaperBroker(cash, ExecutionConfig(**kwargs))


def bar(symbol="AAA", ts=2, price=100_00, volume=1_000_000):
    return SessionBar(symbol, ts, price, int(price * 1.02), int(price * 0.98),
                      price, volume)


def buy(b, quantity=100, ts=1, client="c1", symbol="AAA", price=100_00):
    return b.submit(client_order_id=client, symbol=symbol, side=Side.BUY,
                    quantity=quantity, ts_utc=ts, reference_price=price)


class TestNoInstantFill:
    def test_submission_alone_never_fills(self):
        b = broker()
        order = buy(b)
        assert order.state is OrderState.ACCEPTED
        assert order.filled_quantity == 0
        assert b.fills() == ()

    def test_a_bar_at_the_submission_timestamp_is_not_eligible(self):
        b = broker()
        order = buy(b, ts=5)
        b.advance({"AAA": bar(ts=5)})
        assert b.get(order.order_id).filled_quantity == 0

    def test_a_bar_before_submission_is_not_eligible(self):
        b = broker()
        order = buy(b, ts=5)
        b.advance({"AAA": bar(ts=4)})
        assert b.get(order.order_id).filled_quantity == 0

    def test_the_next_session_fills(self):
        b = broker()
        order = buy(b, ts=1)
        b.advance({"AAA": bar(ts=2)})
        assert b.get(order.order_id).state is OrderState.FILLED


class TestPartialFills:
    def test_participation_cap_forces_a_partial(self):
        b = broker(max_participation=0.01)
        order = buy(b, quantity=10_000)
        b.advance({"AAA": bar(volume=100_000)})
        working = b.get(order.order_id)
        assert working.state is OrderState.PARTIALLY_FILLED
        assert working.filled_quantity == 1_000

    def test_partials_accumulate_across_sessions(self):
        b = broker(max_participation=0.01, expiry_sessions=10)
        order = buy(b, quantity=3_000)
        for session in range(2, 5):
            b.advance({"AAA": bar(ts=session, volume=100_000)})
        assert b.get(order.order_id).state is OrderState.FILLED
        assert len(b.get(order.order_id).fills) == 3

    def test_unfilled_remainder_expires(self):
        b = broker(max_participation=0.001, expiry_sessions=2)
        order = buy(b, quantity=100_000)
        for session in (2, 3):
            b.advance({"AAA": bar(ts=session, volume=100_000)})
        assert b.get(order.order_id).state is OrderState.EXPIRED
        assert 0 < b.get(order.order_id).filled_quantity < 100_000


class TestRejections:
    def test_zero_quantity(self):
        b = broker()
        assert buy(b, quantity=0).reject_reason is RejectReason.ZERO_QUANTITY

    def test_negative_quantity(self):
        b = broker()
        assert buy(b, quantity=-5).state is OrderState.REJECTED

    def test_insufficient_cash(self):
        b = broker(cash=1_000)
        assert buy(b, quantity=10_000).reject_reason is RejectReason.INSUFFICIENT_CASH

    def test_selling_what_is_not_held(self):
        b = broker()
        order = b.submit(client_order_id="s1", symbol="AAA", side=Side.SELL,
                         quantity=10, ts_utc=1, reference_price=100_00)
        assert order.reject_reason is RejectReason.INSUFFICIENT_POSITION

    def test_zero_volume_session_does_not_reject_an_accepted_order(self):
        """A session with no trading means the order could not fill, not that."""
        b = broker(expiry_sessions=3)
        order = buy(b)
        b.advance({"AAA": bar(volume=0)})
        working = b.get(order.order_id)
        assert working.state is OrderState.ACCEPTED
        assert working.filled_quantity == 0

    def test_a_permanently_untradeable_symbol_expires_the_order(self):
        b = broker(expiry_sessions=2)
        order = buy(b)
        for session in (2, 3):
            b.advance({"AAA": bar(ts=session, volume=0)})
        assert b.get(order.order_id).state is OrderState.EXPIRED

    def test_nonpositive_reference_price(self):
        b = broker()
        assert buy(b, price=0).reject_reason is RejectReason.NO_LIQUIDITY


class TestAmbiguous:
    def test_ambiguous_stops_the_order_being_worked(self):
        b = broker()
        order = buy(b)
        b.mark_ambiguous(order.order_id)
        assert b.get(order.order_id).state is OrderState.AMBIGUOUS
        b.advance({"AAA": bar()})
        assert b.get(order.order_id).filled_quantity == 0

    def test_ambiguous_releases_the_reservation(self):
        b = broker()
        order = buy(b, quantity=1_000)
        b.mark_ambiguous(order.order_id)
        assert b.account.reserved == 0

    def test_ambiguous_on_a_terminal_order_is_a_no_op(self):
        b = broker()
        order = buy(b)
        b.advance({"AAA": bar()})
        assert b.mark_ambiguous(order.order_id).state is OrderState.FILLED


class TestCancellation:
    def test_cancel_releases_the_reservation(self):
        b = broker()
        order = buy(b, quantity=1_000)
        assert b.account.reserved > 0
        b.cancel(order.order_id)
        assert b.get(order.order_id).state is OrderState.CANCELLED
        assert b.account.reserved == 0

    def test_cancelled_order_never_fills(self):
        b = broker()
        order = buy(b)
        b.cancel(order.order_id)
        b.advance({"AAA": bar()})
        assert b.get(order.order_id).filled_quantity == 0

    def test_cancelling_twice_is_harmless(self):
        b = broker()
        order = buy(b)
        b.cancel(order.order_id)
        assert b.cancel(order.order_id).state is OrderState.CANCELLED

    def test_cancelling_a_filled_order_is_a_no_op(self):
        b = broker()
        order = buy(b)
        b.advance({"AAA": bar()})
        assert b.cancel(order.order_id).state is OrderState.FILLED

    def test_unknown_order_raises(self):
        with pytest.raises(UnknownOrder):
            broker().cancel("nope")


class TestIdempotency:
    def test_duplicate_client_id_returns_the_original(self):
        b = broker()
        first = buy(b, client="dup")
        second = buy(b, client="dup")
        assert first.order_id == second.order_id
        assert len(b.orders()) == 1

    def test_duplicate_after_fill_does_not_reopen(self):
        b = broker()
        first = buy(b, client="dup")
        b.advance({"AAA": bar()})
        again = buy(b, client="dup")
        assert again.state is OrderState.FILLED
        assert len(b.orders()) == 1

    def test_duplicate_does_not_double_reserve(self):
        b = broker()
        buy(b, quantity=1_000, client="dup")
        reserved = b.account.reserved
        buy(b, quantity=1_000, client="dup")
        assert b.account.reserved == reserved


class TestConservation:
    def _random_session(self, b, rng, session, symbols):
        for symbol in symbols:
            b.advance({symbol: bar(symbol=symbol, ts=session,
                                   price=int(rng.integers(50_00, 200_00)),
                                   volume=int(rng.integers(10_000, 500_000)))})

    def test_cash_and_quantity_conserved_under_random_activity(self):
        rng = np.random.default_rng(11)
        b = broker()
        symbols = ["AAA", "BBB", "CCC"]
        counter = 0
        for session in range(2, 40):
            for symbol in symbols:
                counter += 1
                side = Side.BUY if rng.random() < 0.6 else Side.SELL
                quantity = int(rng.integers(1, 500))
                if side is Side.SELL and b.account.positions.get(symbol, 0) < quantity:
                    continue
                b.submit(client_order_id=f"c{counter}", symbol=symbol, side=side,
                         quantity=quantity, ts_utc=session - 1,
                         reference_price=int(rng.integers(50_00, 200_00)))
            self._random_session(b, rng, session, symbols)
            assert b.conservation_holds(), f"broke at session {session}"

        assert b.fills(), "test did nothing"
        assert b.conservation_holds()

    def test_position_never_goes_negative(self):
        rng = np.random.default_rng(12)
        b = broker()
        for session in range(2, 30):
            b.submit(client_order_id=f"x{session}", symbol="AAA",
                     side=Side.BUY if session % 2 else Side.SELL,
                     quantity=int(rng.integers(1, 100)), ts_utc=session - 1,
                     reference_price=100_00)
            b.advance({"AAA": bar(ts=session)})
            assert all(q > 0 for q in b.account.positions.values())

    def test_reservations_return_to_zero_when_the_book_is_flat(self):
        b = broker()
        for index in range(5):
            buy(b, quantity=100, client=f"c{index}", ts=1)
        b.advance({"AAA": bar(ts=2)})
        assert all(o.terminal for o in b.orders())
        assert b.account.reserved == 0

    def test_audit_recomputes_state_from_fills_alone(self):
        b = broker()
        buy(b, quantity=500)
        b.advance({"AAA": bar()})
        recomputed = b.audit()
        assert recomputed["cash"] == b.account.cash
        assert recomputed["positions"] == b.account.positions


class TestDeterminism:
    def _run(self):
        b = broker()
        for index in range(10):
            b.submit(client_order_id=f"c{index}", symbol="AAA", side=Side.BUY,
                     quantity=100 + index, ts_utc=1, reference_price=100_00)
        b.advance({"AAA": bar(ts=2, volume=50_000)})
        return [(o.order_id, o.state.value, o.filled_quantity,
                 o.average_price, o.total_cost) for o in b.orders()], b.account.cash

    def test_identical_inputs_give_identical_execution(self):
        assert self._run() == self._run()

    def test_no_randomness_in_the_slippage_model(self):
        model = SlippageModel()
        assert model.adjusted_price(100_00, Side.BUY, 0.03) == \
               model.adjusted_price(100_00, Side.BUY, 0.03)


class TestStaleAndDegenerate:
    def test_order_for_a_symbol_with_no_bar_stays_open(self):
        b = broker()
        order = buy(b)
        b.advance({"BBB": bar(symbol="BBB")})
        assert b.get(order.order_id).state is OrderState.ACCEPTED

    def test_expiry_counts_only_sessions_the_order_was_workable(self):
        b = broker(expiry_sessions=2)
        order = buy(b, quantity=100)
        b.advance({"BBB": bar(symbol="BBB", ts=2)})
        assert b.get(order.order_id).state is OrderState.ACCEPTED
        assert b.get(order.order_id).sessions_open == 0

    def test_buy_costs_more_than_the_reference_and_sell_less(self):
        model = SlippageModel()
        assert model.adjusted_price(100_00, Side.BUY, 0.05) > 100_00
        assert model.adjusted_price(100_00, Side.SELL, 0.05) < 100_00
