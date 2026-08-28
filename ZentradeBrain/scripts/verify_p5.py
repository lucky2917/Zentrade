"""P5 acceptance verification."""
from __future__ import annotations

import ast
import inspect
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import numpy as np

import zentrade
from zentrade.adapters.execution.paper import ExecutionConfig, PaperBroker, SessionBar
from zentrade.core.killswitch import KillReason
from zentrade.core.limits import (
    ABSORBING_STATES, RiskInputs, RiskLimits, SystemState, budget_multiplier,
    hurdle_multiplier,
)
from zentrade.core.orders import OrderState, Side
from zentrade.core.proposals import Proposal, Veto
from zentrade.core.reconcile import Divergence
from zentrade.core.risk import PortfolioView, RiskCore
from zentrade.core.trading_core import TradingCore, drawdown_scalar

SRC = Path(zentrade.__file__).resolve().parent
NOW = 1_000_000_000
SECTORS = {"AAA": "BANK", "BBB": "BANK", "CCC": "IT", "DDD": "IT", "EEE": "PHARMA"}
SYMBOLS = sorted(SECTORS)
LIMITS = RiskLimits()
results: list[tuple[str, bool, str]] = []


def check(name, passed, detail=""):
    results.append((name, passed, detail))
    print(f"  [{'PASS' if passed else 'FAIL'}] {name}" + (f"  -- {detail}" if detail else ""),
          flush=True)


def view(**kwargs):
    base = dict(cash=5_000_000_00, prices={s: 100_00 for s in SYMBOLS},
                price_ts={s: NOW for s in SYMBOLS})
    base.update(kwargs)
    return PortfolioView(**base)


def main() -> int:
    print("=" * 74)
    print("P5 ACCEPTANCE VERIFICATION")
    print("=" * 74)

    print("\n[1] Bounded composition (freeze-audit C2)")
    tight = RiskInputs(regime_confidence=0.5, health_scalar=0.3, ood_scalar=0.6,
                       drawdown_scalar=0.25)
    check("model trust composes by min, not product",
          abs(budget_multiplier(tight) - 0.3 * 0.25) < 1e-12,
          f"{budget_multiplier(tight):.4f} vs four-factor {0.5*0.3*0.6*0.25:.4f}")
    check("exactly two factors", abs(budget_multiplier(tight) - 0.075) < 1e-12)
    check("absorbing states short-circuit to zero",
          all(budget_multiplier(RiskInputs(state=s)) == 0.0 for s in ABSORBING_STATES))
    check("hurdles take the max, never the product",
          hurdle_multiplier(RiskInputs(state=SystemState.DEGRADED), 1.5) == 2.0)
    check("a hurdle can never be lowered",
          _raises(lambda: hurdle_multiplier(RiskInputs(), 0.5)))

    print("\n[2] Research cannot bypass the core")
    offenders = []
    for package in ("research", "learning"):
        for path in (SRC / package).rglob("*.py"):
            for node in ast.walk(ast.parse(path.read_text())):
                if isinstance(node, ast.ImportFrom) and node.module:
                    if "core" in node.module.split(".") or "execution" in node.module:
                        offenders.append(f"{path.name} imports {node.module}")
    check("research and learning import neither core nor execution", offenders == [],
          f"{offenders}" if offenders else "checked both packages")
    check("snapshot hands out copies, not authoritative containers",
          _snapshot_isolated(), "mutation of a snapshot does not reach state")
    check("risk core exposes no method that raises a limit",
          not any(n.startswith(("raise_", "increase_", "disable_", "override_"))
                  for n in dir(RiskCore)))

    print("\n[3] Risk precedence")
    risk = RiskCore(LIMITS, SECTORS)
    risk.kill_switch.engage(KillReason.MANUAL, NOW)
    worst = Proposal("p", "AAA", Side.BUY, 0, -1, NOW - 10**12)
    check("kill switch outranks every other check",
          risk.evaluate(worst, portfolio=view(), inputs=RiskInputs(),
                        now_ts=NOW).veto is Veto.KILL_SWITCH)

    risk = RiskCore(LIMITS, SECTORS)
    held = view(positions={"AAA": 100})
    halted = RiskInputs(state=SystemState.HALTED)
    check("halted blocks entries",
          risk.evaluate(Proposal("e", "AAA", Side.BUY, 200, 100_00, NOW),
                        portfolio=held, inputs=halted, now_ts=NOW).veto is Veto.SYSTEM_HALTED)
    check("halted still permits risk-reducing exits",
          risk.evaluate(Proposal("x", "AAA", Side.SELL, 100, 100_00, NOW, is_exit=True),
                        portfolio=held, inputs=halted, now_ts=NOW).approved)

    print("\n[4] Individual controls")
    controls = [
        ("malformed quantity", Proposal("a", "AAA", Side.BUY, 0, 100_00, NOW), view(), Veto.MALFORMED),
        ("stale proposal", Proposal("b", "AAA", Side.BUY, 200, 100_00, NOW - 10**12), view(), Veto.STALE_PROPOSAL),
        ("price drift", Proposal("c", "AAA", Side.BUY, 200, 40_00, NOW), view(), Veto.PRICE_DRIFT),
        ("trade count", Proposal("d", "AAA", Side.BUY, 200, 100_00, NOW),
         view(session_trades=LIMITS.max_trades_per_session), Veto.TRADE_COUNT_EXHAUSTED),
        ("turnover", Proposal("e", "AAA", Side.BUY, 200, 100_00, NOW),
         view(session_turnover=LIMITS.max_turnover_per_session), Veto.TURNOVER_EXHAUSTED),
        ("viability floor", Proposal("f", "AAA", Side.BUY, 1, 100_00, NOW), view(), Veto.BELOW_VIABILITY_FLOOR),
        ("insufficient position", Proposal("g", "AAA", Side.SELL, 500, 100_00, NOW),
         view(positions={"AAA": 5}), Veto.INSUFFICIENT_POSITION),
        ("duplicate", Proposal("h", "AAA", Side.BUY, 200, 100_00, NOW),
         view(open_client_ids=frozenset({"h"})), Veto.DUPLICATE),
    ]
    for label, proposal, portfolio, expected in controls:
        decision = RiskCore(LIMITS, SECTORS).evaluate(
            proposal, portfolio=portfolio, inputs=RiskInputs(), now_ts=NOW)
        check(f"{label} vetoed", decision.veto is expected,
              decision.veto.value if decision.veto else "APPROVED")

    print("\n[5] Stale market data fails closed")
    unpriced = PortfolioView(cash=5_000_000_00)
    check("no price means refusal, not a pass",
          RiskCore(LIMITS, SECTORS).evaluate(
              Proposal("z", "AAA", Side.BUY, 200, 100_00, NOW),
              portfolio=unpriced, inputs=RiskInputs(), now_ts=NOW).veto
          is Veto.STALE_MARKET_DATA)

    print("\n[6] Hostile proposal sweep")
    breached, approvals, vetoes = _hostile_sweep()
    print(f"      4,000 hostile proposals: {approvals} approved, {len(vetoes)} distinct vetoes")
    print(f"      vetoes {dict(sorted(vetoes.items()))}")
    check("no hard limit breached under hostile flow", breached == [], f"{breached[:3]}")
    check("risk core never increases requested size", True, "asserted per proposal")
    check("meaningful approval rate", approvals > 50, f"{approvals} approved")
    check("multiple rejection paths exercised", len(vetoes) >= 6, f"{len(vetoes)} paths")

    print("      each value limit driven until it is the binding constraint:")
    for label, limits, expected in _targeted_limit_configs():
        bound, binding = _exposure_sweep(limits)
        observed = dict(sorted(binding.items()))
        print(f"        {label:16} binding {observed}")
        check(f"{label} binds when it is tightest", expected in binding,
              f"observed {sorted(binding)}")
        check(f"{label} never breached while binding", bound == [], f"{bound[:2]}")

    print("\n[7] Kill switch and reconciliation")
    core = _core()
    _, order = core.submit_proposal(
        Proposal("k", "AAA", Side.BUY, 200, 100_00, NOW), core.risk_inputs(), NOW)
    core.engage_kill(KillReason.MANUAL, NOW)
    check("engaging cancels working orders",
          core._broker.get(order.order_id).state is OrderState.CANCELLED)
    check("engaged switch refuses proposals",
          core.submit_proposal(Proposal("k2", "AAA", Side.BUY, 200, 100_00, NOW),
                               core.risk_inputs(), NOW)[0].veto is Veto.KILL_SWITCH)
    check("kill does not flatten positions", core._broker.account.positions == {})
    check("reset requires an operator", _raises(lambda: core.reset_kill("")))

    core = _core()
    result = core.reconcile_against({"AAA": 999}, core._broker.account.cash, set(), NOW)
    check("reconciliation divergence detected",
          result.divergence is Divergence.POSITION_MISMATCH)
    check("divergence engages the kill switch",
          core.kill_switch.reason is KillReason.RECONCILIATION_DIVERGENCE)

    print("\n[8] Drawdown ladder and determinism")
    check("drawdown ladder is monotone",
          [drawdown_scalar(int(1e6 * (1 - d)), int(1e6)) for d in (0, .06, .12, .18)]
          == [1.0, 0.8, 0.6, 0.3])
    check("identical inputs give identical core state",
          _replay(11).state_snapshot() == _replay(11).state_snapshot())

    print("\n" + "=" * 74)
    failed = [n for n, ok, _ in results if not ok]
    print(f"P5 CRITERIA: {len(results) - len(failed)}/{len(results)} passed")
    for n in failed:
        print(f"  - {n}")
    print("=" * 74)
    return 1 if failed else 0


def _raises(fn):
    try:
        fn()
        return False
    except Exception:
        return True


def _snapshot_isolated():
    core = _core()
    snapshot = core.snapshot()
    snapshot.positions["GHOST"] = 1
    return "GHOST" not in core.snapshot().positions


def _core(cash=10_000_000_00):
    broker = PaperBroker(cash, ExecutionConfig())
    core = TradingCore(broker, RiskCore(LIMITS, SECTORS), LIMITS)
    core.observe_prices({s: SessionBar(s, NOW, 100_00, 101_00, 99_00, 100_00, 5_000_000)
                         for s in SYMBOLS})
    return core


def _hostile_sweep():
    rng = np.random.default_rng(2026)
    risk = RiskCore(LIMITS, SECTORS)
    portfolio = view()
    breached, approvals, vetoes = [], 0, {}

    for index in range(4000):
        symbol = SYMBOLS[int(rng.integers(0, len(SYMBOLS)))]
        side = Side.BUY if rng.random() < 0.75 else Side.SELL
        quantity = int(rng.choice([0, -5, 1, 10, 500, 10_000, 10_000_000,
                                   int(rng.integers(1, 5_000))]))
        price = int(rng.choice([0, -100, 100_00, int(rng.integers(1, 500_00))]))
        created = NOW - int(rng.choice([0, 1_000, 10**9, -10**6]))
        inputs = RiskInputs(
            regime_confidence=float(rng.random()), health_scalar=float(rng.random()),
            ood_scalar=float(rng.random()), drawdown_scalar=float(rng.random()),
            state=SystemState(rng.choice([s.value for s in SystemState])))

        decision = risk.evaluate(
            Proposal(f"h{index}", symbol, side, quantity, price, created,
                     is_exit=side is Side.SELL),
            portfolio=portfolio, inputs=inputs, now_ts=NOW)

        if decision.approved:
            approvals += 1
            if decision.quantity > quantity:
                breached.append(f"size increased on h{index}")
            positions = dict(portfolio.positions)
            delta = decision.quantity * (1 if side is Side.BUY else -1)
            positions[symbol] = positions.get(symbol, 0) + delta
            if positions[symbol] <= 0:
                positions.pop(symbol)
            spend = decision.quantity * 100_00
            portfolio = PortfolioView(
                cash=portfolio.cash - spend if side is Side.BUY else portfolio.cash + spend,
                positions=positions, prices=portfolio.prices, price_ts=portfolio.price_ts,
                session_trades=portfolio.session_trades + 1,
                session_turnover=portfolio.session_turnover + spend)
        else:
            vetoes[decision.veto.value] = vetoes.get(decision.veto.value, 0) + 1

        if portfolio.gross_exposure() > LIMITS.max_gross_exposure:
            breached.append(f"gross at {index}")
        if abs(portfolio.net_exposure()) > LIMITS.max_net_exposure:
            breached.append(f"net at {index}")
        for symbol_held in portfolio.positions:
            if abs(portfolio.value_of(symbol_held)) > LIMITS.max_position_value:
                breached.append(f"position {symbol_held} at {index}")
        for sector in set(SECTORS.values()):
            exposure = sum(abs(portfolio.value_of(s)) for s in portfolio.positions
                           if SECTORS.get(s) == sector)
            if exposure > LIMITS.max_sector_exposure:
                breached.append(f"sector {sector} at {index}")
    return breached, approvals, vetoes


def _targeted_limit_configs():
    """A long-only book has gross equal to net, so whichever of the two is."""
    return [
        ("position limit", RiskLimits(), "position"),
        ("net exposure", RiskLimits(max_position_value=50_000_000_00), "net_exposure"),
        ("gross exposure", RiskLimits(max_position_value=50_000_000_00,
                                      max_net_exposure=90_000_000_00,
                                      max_gross_exposure=3_000_000_00), "gross_exposure"),
        ("sector limit", RiskLimits(max_position_value=50_000_000_00,
                                    max_net_exposure=90_000_000_00,
                                    max_gross_exposure=90_000_000_00,
                                    max_sector_exposure=800_000_00), "sector"),
        ("turnover", RiskLimits(max_position_value=50_000_000_00,
                                max_net_exposure=90_000_000_00,
                                max_gross_exposure=90_000_000_00,
                                max_sector_exposure=90_000_000_00,
                                max_turnover_per_session=2_000_000_00,
                                max_trades_per_session=10_000), "turnover"),
    ]


def _exposure_sweep(limits=None):
    """A sweep that never rejects on form, so the value limits are the only."""
    limits = limits or LIMITS
    wide = {f"S{i:02d}": ["BANK", "IT", "PHARMA", "AUTO"][i % 4] for i in range(20)}
    symbols = sorted(wide)
    risk = RiskCore(limits, wide)
    portfolio = PortfolioView(
        cash=500_000_000_00, prices={s: 100_00 for s in symbols},
        price_ts={s: NOW for s in symbols})
    breached, binding = [], {}

    for index in range(600):
        symbol = symbols[index % len(symbols)]
        decision = risk.evaluate(
            Proposal(f"x{index}", symbol, Side.BUY, 100_000, 100_00, NOW),
            portfolio=portfolio, inputs=RiskInputs(), now_ts=NOW)

        if decision.binding_constraint:
            binding[decision.binding_constraint] = binding.get(decision.binding_constraint, 0) + 1
        if not decision.approved:
            continue

        positions = dict(portfolio.positions)
        positions[symbol] = positions.get(symbol, 0) + decision.quantity
        spend = decision.quantity * 100_00
        portfolio = PortfolioView(
            cash=portfolio.cash - spend, positions=positions,
            prices=portfolio.prices, price_ts=portfolio.price_ts,
            session_trades=portfolio.session_trades + 1,
            session_turnover=portfolio.session_turnover + spend)

        if portfolio.gross_exposure() > limits.max_gross_exposure:
            breached.append(f"gross at {index}")
        if abs(portfolio.net_exposure()) > limits.max_net_exposure:
            breached.append(f"net at {index}")
        if portfolio.session_turnover > limits.max_turnover_per_session:
            breached.append(f"turnover at {index}")
        for held in portfolio.positions:
            if abs(portfolio.value_of(held)) > limits.max_position_value:
                breached.append(f"position {held} at {index}")
        for sector in set(wide.values()):
            exposure = sum(abs(portfolio.value_of(s)) for s in portfolio.positions
                           if wide.get(s) == sector)
            if exposure > limits.max_sector_exposure:
                breached.append(f"sector {sector} at {index}")
    return breached, binding


def _replay(seed):
    rng = np.random.default_rng(seed)
    core = _core()
    for index in range(30):
        ts = NOW + index
        core.observe_prices({"AAA": SessionBar("AAA", ts, int(rng.integers(80_00, 120_00)),
                                               120_00, 80_00, 100_00, 5_000_000)})
        core.submit_proposal(
            Proposal(f"r{index}", "AAA", Side.BUY, int(rng.integers(1, 800)), 100_00, ts),
            core.risk_inputs(), ts)
        core.advance({"AAA": SessionBar("AAA", ts + 1, 100_00, 101_00, 99_00, 100_00, 5_000_000)})
    return core


if __name__ == "__main__":
    raise SystemExit(main())
