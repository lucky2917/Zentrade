"""Persisted Core state, restart recovery, and read-only enforcement."""
import sqlite3

import pytest

from zentrade.adapters.execution.paper import ExecutionConfig, PaperBroker, SessionBar
from zentrade.core.killswitch import KillReason
from zentrade.core.limits import RiskLimits, SystemState
from zentrade.core.orders import OrderState, Side
from zentrade.core.proposals import Proposal, Veto
from zentrade.core.reconcile import Divergence
from zentrade.core.risk import RiskCore
from zentrade.core.store import CoreStore, ReadOnlyViolation, SchemaMismatch
from zentrade.core.trading_core import TradingCore

CASH = 10_000_000_00
NOW = 1_000_000_000
SECTORS = {"AAA": "BANK", "BBB": "IT"}


def bar(symbol="AAA", ts=NOW, price=100_00, volume=5_000_000):
    return SessionBar(symbol, ts, price, int(price * 1.01), int(price * 0.99), price, volume)


def build(tmp_path, cash=CASH):
    store = CoreStore(tmp_path / "core.db", starting_cash=cash)
    limits = RiskLimits()
    core = TradingCore(PaperBroker(cash, ExecutionConfig()), RiskCore(limits, SECTORS),
                       limits, store=store)
    core.observe_prices({"AAA": bar(), "BBB": bar("BBB")})
    return core, store


def trade(core, pid="p1", quantity=200, ts=NOW, side=Side.BUY, **kw):
    return core.submit_proposal(
        Proposal(pid, "AAA", side, quantity, 100_00, ts, **kw), core.risk_inputs(), ts)


class TestStoreItself:
    def test_wal_mode_is_enabled(self, tmp_path):
        store = CoreStore(tmp_path / "core.db", starting_cash=1)
        assert store._db.execute("PRAGMA journal_mode").fetchone()[0] == "wal"

    def test_schema_is_stamped_and_checked(self, tmp_path):
        path = tmp_path / "core.db"
        CoreStore(path, starting_cash=1).close()
        tamper = sqlite3.connect(path)
        try:
            tamper.execute("UPDATE meta SET value='core_v0' WHERE key='schema'")
            tamper.commit()
        finally:
            tamper.close()
        with pytest.raises(SchemaMismatch):
            CoreStore(path, starting_cash=1)

    def test_a_second_writer_is_refused_by_the_database(self, tmp_path):
        """Sole-writer is enforced by SQLite, not by convention. Both stores."""
        path = tmp_path / "core.db"
        first = CoreStore(path, starting_cash=1)
        second = CoreStore(path, starting_cash=1)
        try:
            first._db.execute("BEGIN IMMEDIATE")
            with pytest.raises(sqlite3.OperationalError, match="locked"):
                second._db.execute("BEGIN IMMEDIATE")
        finally:
            first._db.execute("ROLLBACK")
            first.close()
            second.close()

    def test_duplicate_client_order_id_is_impossible_at_the_database(self, tmp_path):
        store = CoreStore(tmp_path / "core.db", starting_cash=1)
        row = dict(order_id="o1", client_order_id="c1", symbol="AAA", side="BUY",
                   quantity=1, state="ACCEPTED", filled_quantity=0, submitted_ts=1,
                   sessions_open=0, reject_reason=None)
        store.checkpoint(cash=1, reserved=0, equity_peak=1, positions={},
                         kill={"engaged": False, "reason": None, "engaged_ts": None,
                               "trip_count": 0},
                         system_state="NORMAL",
                         session={"session_ts": 0, "trades": 0, "turnover": 0},
                         orders=[row], fills=[])
        with pytest.raises(sqlite3.IntegrityError):
            store._db.execute(
                "INSERT INTO orders(order_id, client_order_id, symbol, side, quantity,"
                " state, filled_quantity, submitted_ts, sessions_open, reject_reason)"
                " VALUES ('o2','c1','AAA','BUY',1,'ACCEPTED',0,1,0,NULL)")

    def test_negative_position_rejected_by_a_check_constraint(self, tmp_path):
        store = CoreStore(tmp_path / "core.db", starting_cash=1)
        with pytest.raises(sqlite3.IntegrityError):
            store._db.execute("INSERT INTO positions(symbol, quantity) VALUES ('AAA', -1)")

    def test_overfill_rejected_by_a_check_constraint(self, tmp_path):
        store = CoreStore(tmp_path / "core.db", starting_cash=1)
        with pytest.raises(sqlite3.IntegrityError):
            store._db.execute(
                "INSERT INTO orders(order_id, client_order_id, symbol, side, quantity,"
                " state, filled_quantity, submitted_ts, sessions_open, reject_reason)"
                " VALUES ('o1','c1','AAA','BUY',10,'FILLED',11,1,0,NULL)")


class TestReadOnlyEnforcement:
    def test_read_only_store_cannot_write(self, tmp_path):
        path = tmp_path / "core.db"
        CoreStore(path, starting_cash=1).close()
        ro = CoreStore.read_only_at(path)
        with pytest.raises(ReadOnlyViolation):
            ro.record_event(1, "x", "y")

    def test_read_only_store_cannot_checkpoint(self, tmp_path):
        path = tmp_path / "core.db"
        CoreStore(path, starting_cash=1).close()
        with pytest.raises(ReadOnlyViolation):
            CoreStore.read_only_at(path).checkpoint(
                cash=0, reserved=0, equity_peak=0, positions={},
                kill={"engaged": False, "reason": None, "engaged_ts": None, "trip_count": 0},
                system_state="NORMAL",
                session={"session_ts": 0, "trades": 0, "turnover": 0}, orders=[], fills=[])

    def test_sqlite_itself_refuses_the_write(self, tmp_path):
        path = tmp_path / "core.db"
        CoreStore(path, starting_cash=1).close()
        ro = CoreStore.read_only_at(path)
        with pytest.raises(sqlite3.OperationalError):
            ro._db.execute("INSERT INTO positions(symbol, quantity) VALUES ('X', 1)")

    def test_read_only_store_can_still_read(self, tmp_path):
        path = tmp_path / "core.db"
        CoreStore(path, starting_cash=555).close()
        assert CoreStore.read_only_at(path).load().cash == 555


class TestPersistenceAcrossRestart:
    def test_cash_and_positions_survive(self, tmp_path):
        core, store = build(tmp_path)
        trade(core)
        core.advance({"AAA": bar(ts=NOW + 1)})
        before = (core._broker.account.cash, dict(core._broker.account.positions))
        store.close()

        recovered, _ = TradingCore.recover(CoreStore(tmp_path / "core.db"))
        assert (recovered._broker.account.cash, recovered._broker.account.positions) == before

    def test_journal_agrees_with_materialised_state(self, tmp_path):
        core, store = build(tmp_path)
        for index in range(3):
            trade(core, pid=f"p{index}", ts=NOW + index)
            core.advance({"AAA": bar(ts=NOW + index + 1)})
        assert store.journal_agrees_with_state()

    def test_decisions_are_persisted_not_just_in_memory(self, tmp_path):
        core, store = build(tmp_path)
        trade(core, pid="ok")
        trade(core, pid="bad", quantity=0)
        persisted = store.decisions()
        assert len(persisted) == 2
        assert {d["proposal_id"] for d in persisted} == {"ok", "bad"}
        assert any(d["veto"] == Veto.MALFORMED.value for d in persisted)

    def test_equity_peak_and_counters_survive(self, tmp_path):
        core, store = build(tmp_path)
        trade(core)
        peak, trades = core._equity_peak, core.counters.trades
        store.close()
        recovered, _ = TradingCore.recover(CoreStore(tmp_path / "core.db"))
        assert recovered._equity_peak == peak
        assert recovered.counters.trades == trades

    def test_recovery_is_deterministic(self, tmp_path):
        core, store = build(tmp_path)
        trade(core)
        core.advance({"AAA": bar(ts=NOW + 1)})
        store.close()
        first, _ = TradingCore.recover(CoreStore(tmp_path / "core.db"))
        second, _ = TradingCore.recover(CoreStore(tmp_path / "core.db"))
        assert first.state_snapshot() == second.state_snapshot()


class TestKillStatePersistence:
    def test_kill_survives_restart(self, tmp_path):
        core, store = build(tmp_path)
        core.engage_kill(KillReason.MAX_DRAWDOWN, NOW)
        store.close()
        recovered, _ = TradingCore.recover(CoreStore(tmp_path / "core.db"))
        assert recovered.kill_switch.engaged
        assert recovered.kill_switch.reason is KillReason.MAX_DRAWDOWN
        assert recovered._halted_state is SystemState.HALTED

    def test_a_restart_cannot_clear_a_kill(self, tmp_path):
        """Restarting is not a reset. Only an operator is."""
        core, store = build(tmp_path)
        core.engage_kill(KillReason.MANUAL, NOW)
        store.close()
        recovered, _ = TradingCore.recover(CoreStore(tmp_path / "core.db"))
        recovered.observe_prices({"AAA": bar(ts=NOW + 10)})
        decision, order = recovered.submit_proposal(
            Proposal("after", "AAA", Side.BUY, 200, 100_00, NOW + 10),
            recovered.risk_inputs(), NOW + 10)
        assert decision.veto is Veto.KILL_SWITCH and order is None

    def test_reconciliation_divergence_persists_into_kill_state(self, tmp_path):
        core, store = build(tmp_path)
        result = core.reconcile_against({"AAA": 999}, core._broker.account.cash, set(), NOW)
        assert result.divergence is Divergence.POSITION_MISMATCH
        store.close()

        reopened = CoreStore(tmp_path / "core.db")
        assert reopened.load().kill["reason"] == KillReason.RECONCILIATION_DIVERGENCE.value
        recovered, _ = TradingCore.recover(reopened)
        assert recovered.kill_switch.engaged
        assert any(e["kind"] == "RECONCILE" for e in reopened.events())

    def test_operator_reset_is_journalled(self, tmp_path):
        core, store = build(tmp_path)
        core.engage_kill(KillReason.MANUAL, NOW)
        core.reset_kill("ravi")
        assert any(e["kind"] == "KILL_RESET" and e["detail"] == "ravi"
                   for e in store.events())


class TestAmbiguousRecovery:
    def test_in_flight_orders_become_ambiguous_and_halt(self, tmp_path):
        """A process that died with orders working cannot know whether they."""
        core, store = build(tmp_path)
        _, order = trade(core)
        assert order.state is OrderState.ACCEPTED
        store.close()

        recovered, ambiguous = TradingCore.recover(CoreStore(tmp_path / "core.db"))
        assert ambiguous == (order.order_id,)
        assert recovered._broker.get(order.order_id).state is OrderState.AMBIGUOUS
        assert recovered.kill_switch.engaged
        assert recovered.kill_switch.reason is KillReason.EXECUTION_DIVERGENCE

    def test_settled_orders_recover_without_halting(self, tmp_path):
        core, store = build(tmp_path)
        trade(core)
        core.advance({"AAA": bar(ts=NOW + 1)})
        assert all(o.terminal for o in core._broker.orders())
        store.close()

        recovered, ambiguous = TradingCore.recover(CoreStore(tmp_path / "core.db"))
        assert ambiguous == ()
        assert not recovered.kill_switch.engaged

    def test_ambiguous_recovery_is_recorded(self, tmp_path):
        core, store = build(tmp_path)
        trade(core)
        store.close()
        reopened = CoreStore(tmp_path / "core.db")
        TradingCore.recover(reopened)
        assert any(e["kind"] == "RECOVERY_AMBIGUOUS" for e in reopened.events())


class TestExitsUnderHalt:
    def test_exit_during_halt_still_obeys_position_correctness(self, tmp_path):
        core, store = build(tmp_path)
        trade(core, pid="entry", quantity=200)
        core.advance({"AAA": bar(ts=NOW + 1)})
        held = core._broker.account.positions["AAA"]

        core._halted_state = SystemState.ABSTAIN_ONLY
        core.observe_prices({"AAA": bar(ts=NOW + 2)})

        oversized = core.submit_proposal(
            Proposal("over", "AAA", Side.SELL, held + 1, 100_00, NOW + 2, is_exit=True),
            core.risk_inputs(state=SystemState.ABSTAIN_ONLY), NOW + 2)[0]
        assert oversized.veto is Veto.INSUFFICIENT_POSITION

        valid = core.submit_proposal(
            Proposal("exit", "AAA", Side.SELL, held, 100_00, NOW + 2, is_exit=True),
            core.risk_inputs(state=SystemState.ABSTAIN_ONLY), NOW + 2)[0]
        assert valid.approved and valid.quantity == held

    def test_exit_during_halt_still_conserves_cash_and_quantity(self, tmp_path):
        core, store = build(tmp_path)
        trade(core, pid="entry", quantity=200)
        core.advance({"AAA": bar(ts=NOW + 1)})
        core._halted_state = SystemState.ABSTAIN_ONLY
        core.observe_prices({"AAA": bar(ts=NOW + 2)})
        core.submit_proposal(
            Proposal("exit", "AAA", Side.SELL, 200, 100_00, NOW + 2, is_exit=True),
            core.risk_inputs(state=SystemState.ABSTAIN_ONLY), NOW + 2)
        core.advance({"AAA": bar(ts=NOW + 3)})
        assert core._broker.conservation_holds()
        assert store.journal_agrees_with_state()
