"""Trading Core authority, kill behaviour, reconciliation and recovery."""
import numpy as np
import pytest

from zentrade.adapters.execution.paper import ExecutionConfig, PaperBroker, SessionBar
from zentrade.core.killswitch import KillReason
from zentrade.core.limits import RiskInputs, RiskLimits, SystemState
from zentrade.core.orders import OrderState, Side
from zentrade.core.proposals import Proposal, Veto
from zentrade.core.reconcile import Divergence
from zentrade.core.risk import RiskCore
from zentrade.core.trading_core import TradingCore, drawdown_scalar

CASH = 10_000_000_00
NOW = 1_000_000_000
SECTORS = {"AAA": "BANK", "BBB": "IT"}


def bar(symbol="AAA", ts=NOW, price=100_00, volume=5_000_000):
    return SessionBar(symbol, ts, price, int(price * 1.01), int(price * 0.99), price, volume)


def build(cash=CASH, limits=None):
    limits = limits or RiskLimits()
    broker = PaperBroker(cash, ExecutionConfig())
    core = TradingCore(broker, RiskCore(limits, SECTORS), limits)
    core.observe_prices({"AAA": bar(), "BBB": bar("BBB")})
    return core


def propose(core, pid="p1", symbol="AAA", side=Side.BUY, quantity=200, ts=NOW, **kw):
    return core.submit_proposal(
        Proposal(pid, symbol, side, quantity, 100_00, ts, **kw),
        core.risk_inputs(), ts)


class TestSoleWriter:
    def test_snapshot_mutation_cannot_reach_core_state(self):
        core = build()
        snapshot = core.snapshot()
        snapshot.positions["GHOST"] = 10_000
        snapshot.prices["AAA"] = 1
        assert "GHOST" not in core.snapshot().positions
        assert core.snapshot().prices["AAA"] == 100_00

    def test_every_approved_order_came_through_the_core(self):
        core = build()
        decision, order = propose(core)
        assert decision.approved and order is not None
        assert len(core._broker.orders()) == 1

    def test_rejected_proposal_creates_no_order(self):
        core = build()
        decision, order = propose(core, quantity=0)
        assert not decision.approved and order is None
        assert core._broker.orders() == ()

    def test_decisions_are_journalled(self):
        core = build()
        propose(core, pid="a")
        propose(core, pid="b", quantity=0)
        assert len(core.journal.decisions) == 2


class TestKillSwitch:
    def test_engaging_cancels_working_orders(self):
        core = build()
        _, order = propose(core)
        assert order.state is OrderState.ACCEPTED
        core.engage_kill(KillReason.MANUAL, NOW)
        assert core._broker.get(order.order_id).state is OrderState.CANCELLED

    def test_engaged_switch_refuses_every_proposal(self):
        core = build()
        core.engage_kill(KillReason.MANUAL, NOW)
        decision, order = propose(core, pid="after")
        assert decision.veto is Veto.KILL_SWITCH and order is None

    def test_kill_does_not_flatten_existing_positions(self):
        """Paper policy: hold, never auto-liquidate into a dislocation."""
        core = build()
        propose(core)
        core.advance({"AAA": bar(ts=NOW + 1)})
        held = dict(core._broker.account.positions)
        assert held
        core.engage_kill(KillReason.MANUAL, NOW + 2)
        assert core._broker.account.positions == held

    def test_reset_requires_an_operator(self):
        core = build()
        core.engage_kill(KillReason.MANUAL, NOW)
        with pytest.raises(ValueError):
            core.reset_kill("")

    def test_reset_restores_trading(self):
        core = build()
        core.engage_kill(KillReason.MANUAL, NOW)
        core.reset_kill("ravi")
        assert propose(core, pid="resumed")[0].approved

    def test_daily_loss_engages_the_switch(self):
        limits = RiskLimits(max_daily_loss=1_000_00, max_drawdown_pct=0.9)
        core = build(limits=limits)
        propose(core, quantity=2_000)
        core.advance({"AAA": bar(ts=NOW + 1)})
        core.advance({"AAA": bar(ts=NOW + 2, price=50_00)})
        assert core.kill_switch.engaged

    def test_trip_count_records_repeat_engagements(self):
        core = build()
        core.engage_kill(KillReason.MANUAL, NOW)
        core.reset_kill("ravi")
        core.engage_kill(KillReason.DAILY_LOSS_LIMIT, NOW + 1)
        assert core.kill_switch.trip_count == 2


class TestReconciliation:
    def test_matching_state_is_clean(self):
        core = build()
        result = core.reconcile_against({}, core._broker.account.cash, set(), NOW)
        assert result.clean and not core.kill_switch.engaged

    def test_position_divergence_engages_the_kill_switch(self):
        core = build()
        result = core.reconcile_against({"AAA": 999}, core._broker.account.cash, set(), NOW)
        assert result.divergence is Divergence.POSITION_MISMATCH
        assert core.kill_switch.engaged
        assert core.kill_switch.reason is KillReason.RECONCILIATION_DIVERGENCE

    def test_cash_divergence_engages_the_kill_switch(self):
        core = build()
        core.reconcile_against({}, core._broker.account.cash - 1, set(), NOW)
        assert core.kill_switch.engaged

    def test_unknown_venue_order_engages_the_kill_switch(self):
        core = build()
        core.reconcile_against({}, core._broker.account.cash, {"ghost"}, NOW)
        assert core.kill_switch.engaged

    def test_reconciliations_are_journalled(self):
        core = build()
        core.reconcile_against({}, core._broker.account.cash, set(), NOW)
        assert core.journal.reconciliations


class TestDrawdown:
    @pytest.mark.parametrize("drop,expected", [
        (0.00, 1.0), (0.04, 1.0), (0.06, 0.8), (0.12, 0.6), (0.18, 0.3), (0.50, 0.3)])
    def test_ladder(self, drop, expected):
        assert drawdown_scalar(int(1_000_000 * (1 - drop)), 1_000_000) == expected

    def test_no_peak_means_no_penalty(self):
        assert drawdown_scalar(100, 0) == 1.0

    def test_equity_above_peak_is_not_a_drawdown(self):
        assert drawdown_scalar(200, 100) == 1.0

    def test_drawdown_reduces_approved_size(self):
        core = build()
        healthy = core.risk.evaluate(
            Proposal("a", "AAA", Side.BUY, 100_000, 100_00, NOW),
            portfolio=core.snapshot(), inputs=RiskInputs(), now_ts=NOW)
        drawn = core.risk.evaluate(
            Proposal("b", "AAA", Side.BUY, 100_000, 100_00, NOW),
            portfolio=core.snapshot(), inputs=RiskInputs(drawdown_scalar=0.3), now_ts=NOW)
        assert drawn.quantity < healthy.quantity


class TestSessionBudgets:
    def test_trade_count_exhausts(self):
        limits = RiskLimits(max_trades_per_session=2)
        core = build(limits=limits)
        approved = [propose(core, pid=f"p{i}")[0].approved for i in range(4)]
        assert approved[:2] == [True, True]
        assert approved[2:] == [False, False]

    def test_counters_reset_on_a_new_session(self):
        limits = RiskLimits(max_trades_per_session=1)
        core = build(limits=limits)
        assert propose(core, pid="s1", ts=NOW)[0].approved
        assert not propose(core, pid="s2", ts=NOW)[0].approved
        assert propose(core, pid="s3", ts=NOW + 1)[0].approved


class TestRecoveryAndDeterminism:
    def _run(self, seed):
        rng = np.random.default_rng(seed)
        core = build()
        for index in range(30):
            ts = NOW + index
            core.observe_prices({"AAA": bar(ts=ts, price=int(rng.integers(80_00, 120_00)))})
            propose(core, pid=f"r{index}", quantity=int(rng.integers(1, 800)), ts=ts)
            core.advance({"AAA": bar(ts=ts + 1)})
        return core

    def test_identical_seeds_give_identical_state(self):
        assert self._run(5).state_snapshot() == self._run(5).state_snapshot()

    def test_state_snapshot_is_serialisable_for_restart(self):
        snapshot = self._run(6).state_snapshot()
        assert set(snapshot) >= {"cash", "positions", "kill", "system_state",
                                 "session_trades", "session_turnover"}

    def test_restart_after_kill_stays_halted_until_reset(self):
        core = self._run(7)
        core.engage_kill(KillReason.MAX_DRAWDOWN, NOW)
        snapshot = core.state_snapshot()
        assert snapshot["kill"]["engaged"] and snapshot["system_state"] == "HALTED"
        core.reset_kill("ravi")
        assert core.state_snapshot()["system_state"] == "NORMAL"
