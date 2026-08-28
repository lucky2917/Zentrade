"""P4 acceptance verification against real session bars."""
from __future__ import annotations

import sys
from datetime import date, datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import zentrade
from zentrade.adapters.data.pit import SpinePitSource
from zentrade.adapters.execution.paper import (
    ExecutionConfig, PaperBroker, SessionBar,
)
from zentrade.costs import CALIBRATION_STAGE, ProductType, SlippageModel, compute_costs
from zentrade.core.orders import OrderState, Side, TERMINAL_STATES, VALID_TRANSITIONS
from zentrade.features.universe import liquidity_screen

ROOT = Path(zentrade.__file__).resolve().parents[2]
SPINE = ROOT / "data" / "spine"
results: list[tuple[str, bool, str]] = []


def check(name, passed, detail=""):
    results.append((name, passed, detail))
    print(f"  [{'PASS' if passed else 'FAIL'}] {name}" + (f"  -- {detail}" if detail else ""),
          flush=True)


def ts(day: date) -> int:
    return int(datetime(day.year, day.month, day.day, tzinfo=timezone.utc).timestamp() * 1_000_000)


def load_sessions(source, symbols, as_of, sessions=40):
    table = source.bars_before(as_of=ts(as_of), symbols=symbols, lookback_sessions=sessions)
    columns = {n: table.column(n).to_pylist()
               for n in ("symbol", "ts_utc", "open", "high", "low", "close", "volume")}
    by_ts: dict[int, dict[str, SessionBar]] = {}
    for i in range(table.num_rows):
        by_ts.setdefault(columns["ts_utc"][i], {})[columns["symbol"][i]] = SessionBar(
            columns["symbol"][i], columns["ts_utc"][i], columns["open"][i],
            columns["high"][i], columns["low"][i], columns["close"][i], columns["volume"][i])
    return [by_ts[k] for k in sorted(by_ts)]


def simulate(symbols, sessions, cash=500_000_000_00, config=None):
    """Deliberately mixed order flow. A simulation that only fills cleanly."""
    broker = PaperBroker(cash, config or ExecutionConfig(
        max_participation=0.002, expiry_sessions=2))
    counter = 0
    for index, session in enumerate(sessions[:-1]):
        for position, symbol in enumerate(symbols):
            bar = session.get(symbol)
            if bar is None:
                continue
            counter += 1
            held = broker.account.positions.get(symbol, 0)
            kind = (index + position) % 5

            if kind == 0 and held >= 20:
                side, quantity = Side.SELL, 20
            elif kind == 1:
                side, quantity = Side.SELL, held + 10_000
            elif kind == 2:
                capacity = max(1, int(bar.volume * broker.config.max_participation))
                side, quantity = Side.BUY, capacity * 6
            else:
                side, quantity = Side.BUY, max(1, 2_000_00 // max(bar.close, 1))

            order = broker.submit(client_order_id=f"c{counter}", symbol=symbol, side=side,
                                  quantity=quantity, ts_utc=bar.ts_utc,
                                  reference_price=bar.close)
            if kind == 3 and not order.terminal:
                broker.cancel(order.order_id)
        broker.advance(sessions[index + 1])
    return broker


def main() -> int:
    print("=" * 74)
    print("P4 ACCEPTANCE VERIFICATION")
    print("=" * 74)

    source = SpinePitSource(SPINE)
    as_of = date(2026, 8, 27)
    symbols = list(liquidity_screen(source, as_of, size=12).symbols)
    sessions = load_sessions(source, symbols, as_of, sessions=45)
    print(f"\n  universe {len(symbols)} symbols, {len(sessions)} sessions of real bars")

    print("\n[1] Order state machine")
    check("every state is in the transition table", set(VALID_TRANSITIONS) == set(OrderState))
    check("terminal states have no exits",
          all(VALID_TRANSITIONS[s] == frozenset() for s in TERMINAL_STATES),
          f"{len(TERMINAL_STATES)} terminal states")
    check("NEW cannot reach FILLED directly",
          OrderState.FILLED not in VALID_TRANSITIONS[OrderState.NEW])

    print("\n[2] No signal-to-instant-fill")
    broker = PaperBroker(10_000_000_00)
    first = sessions[0][symbols[0]]
    order = broker.submit(client_order_id="x", symbol=symbols[0], side=Side.BUY,
                          quantity=10, ts_utc=first.ts_utc, reference_price=first.close)
    check("submission does not fill", order.filled_quantity == 0 and broker.fills() == ())
    broker.advance(sessions[0])
    check("a bar at the submission timestamp does not fill",
          broker.get(order.order_id).filled_quantity == 0)
    broker.advance(sessions[1])
    check("the next session fills", broker.get(order.order_id).filled_quantity > 0)

    print("\n[3] Simulated execution over real bars")
    book = simulate(symbols, sessions)
    states: dict[str, int] = {}
    for o in book.orders():
        states[o.state.value] = states.get(o.state.value, 0) + 1
    filled = [o for o in book.orders() if o.state is OrderState.FILLED]
    partial = [o for o in book.orders() if o.fills and o.state is not OrderState.FILLED]
    print(f"      orders {len(book.orders()):,}  fills {len(book.fills()):,}")
    print(f"      states {dict(sorted(states.items()))}")
    total_cost = sum(f.cost for f in book.fills())
    turnover = sum(f.gross for f in book.fills())
    print(f"      turnover Rs{turnover/100:,.0f}  costs Rs{total_cost/100:,.0f} "
          f"({total_cost/turnover*100:.4f}% of turnover)")
    check("orders actually executed", len(book.fills()) > 100, f"{len(book.fills()):,} fills")
    check("multiple terminal states exercised", len(states) >= 3, f"{sorted(states)}")
    check("costs charged on every fill", all(f.cost > 0 for f in book.fills()))
    multi = [o for o in book.orders() if len(o.fills) > 1]
    check("partial fills occurred across sessions", len(multi) > 0,
          f"{len(multi)} orders filled over multiple sessions")
    expired_partial = [o for o in book.orders()
                       if o.state is OrderState.EXPIRED and o.filled_quantity > 0]
    check("orders expired holding a partial fill", len(expired_partial) > 0,
          f"{len(expired_partial)} expired part-filled")

    amb = PaperBroker(10_000_000_00)
    stuck = amb.submit(client_order_id="amb", symbol=symbols[0], side=Side.BUY,
                       quantity=10, ts_utc=first.ts_utc, reference_price=first.close)
    amb.mark_ambiguous(stuck.order_id)
    amb.advance(sessions[1])
    check("ambiguous orders stop being worked",
          amb.get(stuck.order_id).state is OrderState.AMBIGUOUS
          and amb.get(stuck.order_id).filled_quantity == 0)
    check("ambiguous releases its reservation", amb.account.reserved == 0)

    print("\n[4] Conservation")
    check("cash and positions reconcile with the fill log", book.conservation_holds(),
          f"cash Rs{book.account.cash/100:,.0f}")
    audited = book.audit()
    check("audited cash matches", audited["cash"] == book.account.cash)
    check("audited positions match", audited["positions"] == book.account.positions)
    check("no negative position", all(q > 0 for q in book.account.positions.values()))
    per_order_ok = all(sum(f.quantity for f in o.fills) == o.filled_quantity
                       for o in book.orders())
    check("fills sum to filled quantity on every order", per_order_ok)
    check("no order overfills", all(o.filled_quantity <= o.quantity for o in book.orders()))
    flat_reserved = all(o.terminal for o in book.orders())
    check("reservations released for terminal orders",
          not flat_reserved or book.account.reserved == 0,
          f"reserved {book.account.reserved}")

    print("\n[5] Idempotency")
    b2 = PaperBroker(10_000_000_00)
    a = b2.submit(client_order_id="dup", symbol=symbols[0], side=Side.BUY, quantity=10,
                  ts_utc=first.ts_utc, reference_price=first.close)
    reserved = b2.account.reserved
    c = b2.submit(client_order_id="dup", symbol=symbols[0], side=Side.BUY, quantity=10,
                  ts_utc=first.ts_utc, reference_price=first.close)
    check("duplicate client id returns the original order", a.order_id == c.order_id)
    check("duplicate does not create a second order", len(b2.orders()) == 1)
    check("duplicate does not double-reserve", b2.account.reserved == reserved)

    print("\n[6] Replay determinism")
    again = simulate(symbols, sessions)
    signature = lambda bk: [(o.order_id, o.state.value, o.filled_quantity,
                             o.average_price, o.total_cost) for o in bk.orders()]
    check("identical inputs give identical execution", signature(book) == signature(again))
    check("identical ending cash", book.account.cash == again.account.cash)
    check("identical positions", book.account.positions == again.account.positions)

    print("\n[7] Cost model is bootstrap, not calibrated")
    check("calibration stage declared bootstrap", CALIBRATION_STAGE == "bootstrap")
    model = SlippageModel()
    check("slippage is paid even at zero participation", model.slippage_bps(0.0) > 0,
          f"{model.slippage_bps(0.0):.2f} bps")
    check("slippage rises with participation",
          model.slippage_bps(0.5) > model.slippage_bps(0.01))
    check("buy fills above and sell fills below reference",
          model.adjusted_price(100_00, Side.BUY, 0.05) > 100_00 >
          model.adjusted_price(100_00, Side.SELL, 0.05))

    print("\n" + "=" * 74)
    failed = [n for n, ok, _ in results if not ok]
    print(f"P4 CRITERIA: {len(results) - len(failed)}/{len(results)} passed")
    for n in failed:
        print(f"  - {n}")
    print("=" * 74)
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
