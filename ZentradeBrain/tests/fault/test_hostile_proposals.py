"""Adversarial proposals. No hard limit may be breached, whatever is asked for."""
import numpy as np
import pytest

from zentrade.core.killswitch import KillReason, KillSwitch
from zentrade.core.limits import RiskInputs, RiskLimits, SystemState
from zentrade.core.orders import Side
from zentrade.core.proposals import Proposal, Veto
from zentrade.core.risk import PortfolioView, RiskCore

NOW = 1_000_000_000
SECTORS = {"AAA": "BANK", "BBB": "BANK", "CCC": "IT", "DDD": "IT", "EEE": "PHARMA"}
SYMBOLS = sorted(SECTORS)
LIMITS = RiskLimits()


def portfolio(cash=5_000_000_00, positions=None, **kwargs):
    positions = positions or {}
    return PortfolioView(
        cash=cash, positions=positions,
        prices={s: 100_00 for s in SYMBOLS},
        price_ts={s: NOW for s in SYMBOLS},
        **kwargs,
    )


def core():
    return RiskCore(LIMITS, SECTORS, KillSwitch())


class TestMalformed:
    @pytest.mark.parametrize("quantity", [0, -1, -10_000])
    def test_nonpositive_quantity(self, quantity):
        decision = core().evaluate(
            Proposal("p", "AAA", Side.BUY, quantity, 100_00, NOW),
            portfolio=portfolio(), inputs=RiskInputs(), now_ts=NOW)
        assert not decision.approved and decision.veto is Veto.MALFORMED

    @pytest.mark.parametrize("price", [0, -100])
    def test_nonpositive_reference_price(self, price):
        decision = core().evaluate(
            Proposal("p", "AAA", Side.BUY, 10, price, NOW),
            portfolio=portfolio(), inputs=RiskInputs(), now_ts=NOW)
        assert decision.veto is Veto.MALFORMED

    def test_empty_symbol(self):
        decision = core().evaluate(
            Proposal("p", "", Side.BUY, 10, 100_00, NOW),
            portfolio=portfolio(), inputs=RiskInputs(), now_ts=NOW)
        assert decision.veto is Veto.MALFORMED

    def test_unknown_symbol_has_no_price_and_is_refused(self):
        decision = core().evaluate(
            Proposal("p", "ZZZ", Side.BUY, 10, 100_00, NOW),
            portfolio=portfolio(), inputs=RiskInputs(), now_ts=NOW)
        assert decision.veto is Veto.STALE_MARKET_DATA


class TestStalenessAndDrift:
    def test_ancient_proposal_refused(self):
        old = NOW - LIMITS.max_proposal_age_us - 1
        decision = core().evaluate(
            Proposal("p", "AAA", Side.BUY, 10, 100_00, old),
            portfolio=portfolio(), inputs=RiskInputs(), now_ts=NOW)
        assert decision.veto is Veto.STALE_PROPOSAL

    def test_proposal_from_the_future_refused(self):
        decision = core().evaluate(
            Proposal("p", "AAA", Side.BUY, 10, 100_00, NOW + 1_000),
            portfolio=portfolio(), inputs=RiskInputs(), now_ts=NOW)
        assert decision.veto is Veto.STALE_PROPOSAL

    def test_stale_market_data_refused(self):
        view = PortfolioView(cash=5_000_000_00, prices={"AAA": 100_00},
                             price_ts={"AAA": NOW - LIMITS.max_proposal_age_us - 1})
        decision = core().evaluate(Proposal("p", "AAA", Side.BUY, 10, 100_00, NOW),
                                   portfolio=view, inputs=RiskInputs(), now_ts=NOW)
        assert decision.veto is Veto.STALE_MARKET_DATA

    def test_price_drift_veto(self):
        decision = core().evaluate(
            Proposal("p", "AAA", Side.BUY, 10, 50_00, NOW),
            portfolio=portfolio(), inputs=RiskInputs(), now_ts=NOW)
        assert decision.veto is Veto.PRICE_DRIFT

    def test_small_drift_permitted(self):
        """Quantity is above the viability floor so drift is the only thing."""
        decision = core().evaluate(
            Proposal("p", "AAA", Side.BUY, 200, 100_50, NOW),
            portfolio=portfolio(), inputs=RiskInputs(), now_ts=NOW)
        assert decision.approved

    def test_order_below_the_viability_floor_is_refused(self):
        decision = core().evaluate(
            Proposal("p", "AAA", Side.BUY, 1, 100_00, NOW),
            portfolio=portfolio(), inputs=RiskInputs(), now_ts=NOW)
        assert decision.veto is Veto.BELOW_VIABILITY_FLOOR


class TestPrecedence:
    def test_kill_switch_outranks_everything(self):
        risk = core()
        risk.kill_switch.engage(KillReason.MANUAL, NOW)
        decision = risk.evaluate(Proposal("p", "AAA", Side.BUY, 0, -1, NOW - 10**12),
                                 portfolio=portfolio(), inputs=RiskInputs(), now_ts=NOW)
        assert decision.veto is Veto.KILL_SWITCH

    def test_halted_blocks_entries_but_not_exits(self):
        risk = core()
        held = portfolio(positions={"AAA": 100})
        entry = Proposal("p1", "AAA", Side.BUY, 10, 100_00, NOW)
        exit_ = Proposal("p2", "AAA", Side.SELL, 10, 100_00, NOW, is_exit=True)
        halted = RiskInputs(state=SystemState.HALTED)
        assert risk.evaluate(entry, portfolio=held, inputs=halted, now_ts=NOW).veto \
               is Veto.SYSTEM_HALTED
        assert risk.evaluate(exit_, portfolio=held, inputs=halted, now_ts=NOW).approved

    def test_abstain_only_blocks_entries_but_not_exits(self):
        risk = core()
        held = portfolio(positions={"AAA": 100})
        inputs = RiskInputs(state=SystemState.ABSTAIN_ONLY)
        assert risk.evaluate(Proposal("p1", "AAA", Side.BUY, 10, 100_00, NOW),
                             portfolio=held, inputs=inputs, now_ts=NOW).veto \
               is Veto.NO_NEW_ENTRIES
        assert risk.evaluate(Proposal("p2", "AAA", Side.SELL, 10, 100_00, NOW, is_exit=True),
                             portfolio=held, inputs=inputs, now_ts=NOW).approved

    def test_duplicate_proposal_refused(self):
        view = portfolio()
        view = PortfolioView(cash=view.cash, prices=view.prices, price_ts=view.price_ts,
                             open_client_ids=frozenset({"p"}))
        decision = core().evaluate(Proposal("p", "AAA", Side.BUY, 10, 100_00, NOW),
                                   portfolio=view, inputs=RiskInputs(), now_ts=NOW)
        assert decision.veto is Veto.DUPLICATE


class TestBudgets:
    def test_trade_count_exhaustion(self):
        view = portfolio(session_trades=LIMITS.max_trades_per_session)
        assert core().evaluate(Proposal("p", "AAA", Side.BUY, 10, 100_00, NOW),
                               portfolio=view, inputs=RiskInputs(), now_ts=NOW).veto \
               is Veto.TRADE_COUNT_EXHAUSTED

    def test_turnover_exhaustion(self):
        view = portfolio(session_turnover=LIMITS.max_turnover_per_session)
        assert core().evaluate(Proposal("p", "AAA", Side.BUY, 10, 100_00, NOW),
                               portfolio=view, inputs=RiskInputs(), now_ts=NOW).veto \
               is Veto.TURNOVER_EXHAUSTED

    def test_zero_budget_refuses(self):
        assert core().evaluate(
            Proposal("p", "AAA", Side.BUY, 10, 100_00, NOW), portfolio=portfolio(),
            inputs=RiskInputs(health_scalar=0.0), now_ts=NOW).veto is Veto.BUDGET_EXHAUSTED

    def test_symbol_count_limit(self):
        positions = {f"S{i}": 1 for i in range(LIMITS.max_symbols_held)}
        view = PortfolioView(cash=5_000_000_00, positions=positions,
                             prices={**{s: 1 for s in positions}, "AAA": 100_00},
                             price_ts={**{s: NOW for s in positions}, "AAA": NOW})
        assert core().evaluate(Proposal("p", "AAA", Side.BUY, 10, 100_00, NOW),
                               portfolio=view, inputs=RiskInputs(), now_ts=NOW).veto \
               is Veto.SYMBOL_COUNT


class TestExits:
    def test_cannot_sell_more_than_held(self):
        view = portfolio(positions={"AAA": 5})
        assert core().evaluate(Proposal("p", "AAA", Side.SELL, 100, 100_00, NOW),
                               portfolio=view, inputs=RiskInputs(), now_ts=NOW).veto \
               is Veto.INSUFFICIENT_POSITION

    def test_risk_reducing_sells_bypass_budget_limits(self):
        view = portfolio(positions={"AAA": 50},
                         session_trades=LIMITS.max_trades_per_session,
                         session_turnover=LIMITS.max_turnover_per_session)
        assert core().evaluate(Proposal("p", "AAA", Side.SELL, 50, 100_00, NOW),
                               portfolio=view, inputs=RiskInputs(), now_ts=NOW).approved


class TestHostileFuzz:
    """The acceptance test: whatever is proposed, no hard limit may be breached."""

    def _apply(self, view: PortfolioView, decision, side, symbol, price) -> PortfolioView:
        if not decision.approved:
            return view
        positions = dict(view.positions)
        delta = decision.quantity * (1 if side is Side.BUY else -1)
        positions[symbol] = positions.get(symbol, 0) + delta
        if positions[symbol] <= 0:
            positions.pop(symbol)
        spend = decision.quantity * price
        return PortfolioView(
            cash=view.cash - spend if side is Side.BUY else view.cash + spend,
            positions=positions, prices=view.prices, price_ts=view.price_ts,
            session_trades=view.session_trades + 1,
            session_turnover=view.session_turnover + spend,
        )

    def test_no_hard_limit_breached_under_hostile_flow(self):
        rng = np.random.default_rng(2026)
        risk = core()
        view = portfolio()
        approvals = 0
        vetoes: dict[str, int] = {}

        for index in range(4000):
            symbol = SYMBOLS[int(rng.integers(0, len(SYMBOLS)))]
            side = Side.BUY if rng.random() < 0.75 else Side.SELL
            quantity = int(rng.choice([
                0, -5, 1, 10, 500, 10_000, 10_000_000, int(rng.integers(1, 5_000))]))
            price = int(rng.choice([0, -100, 100_00, int(rng.integers(1, 500_00))]))
            created = NOW - int(rng.choice([0, 1_000, 10**9, -10**6]))
            state = SystemState(rng.choice([s.value for s in SystemState]))
            inputs = RiskInputs(
                regime_confidence=float(rng.random()), health_scalar=float(rng.random()),
                ood_scalar=float(rng.random()), drawdown_scalar=float(rng.random()),
                state=state)

            decision = risk.evaluate(
                Proposal(f"h{index}", symbol, side, quantity, price, created,
                         is_exit=side is Side.SELL),
                portfolio=view, inputs=inputs, now_ts=NOW)

            if decision.approved:
                approvals += 1
                assert decision.quantity > 0
                assert decision.quantity <= quantity, "risk core may never increase size"
            else:
                vetoes[decision.veto.value] = vetoes.get(decision.veto.value, 0) + 1

            view = self._apply(view, decision, side, symbol, view.prices[symbol])

            assert view.gross_exposure() <= LIMITS.max_gross_exposure, "gross breached"
            assert abs(view.net_exposure()) <= LIMITS.max_net_exposure, "net breached"
            assert all(q > 0 for q in view.positions.values()), "negative position"
            for held in view.positions:
                assert abs(view.value_of(held)) <= LIMITS.max_position_value, \
                    f"position limit breached on {held}"
            for sector in set(SECTORS.values()):
                exposure = sum(abs(view.value_of(s)) for s in view.positions
                               if SECTORS.get(s) == sector)
                assert exposure <= LIMITS.max_sector_exposure, f"sector {sector} breached"

        assert approvals > 50, f"fuzz approved too little to be meaningful: {approvals}"
        assert len(vetoes) >= 6, f"too few rejection paths exercised: {sorted(vetoes)}"

    def test_risk_core_never_increases_requested_size(self):
        rng = np.random.default_rng(7)
        risk = core()
        for index in range(500):
            quantity = int(rng.integers(1, 100_000))
            decision = risk.evaluate(
                Proposal(f"q{index}", "AAA", Side.BUY, quantity, 100_00, NOW),
                portfolio=portfolio(), inputs=RiskInputs(), now_ts=NOW)
            if decision.approved:
                assert decision.quantity <= quantity
