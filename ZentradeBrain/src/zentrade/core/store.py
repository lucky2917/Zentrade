"""Authoritative Core state on SQLite in WAL mode. Single writer, by construction."""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from pathlib import Path

SCHEMA_VERSION = "core_v1"

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS account (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    cash INTEGER NOT NULL,
    reserved INTEGER NOT NULL,
    equity_peak INTEGER NOT NULL,
    starting_cash INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS positions (
    symbol TEXT PRIMARY KEY,
    quantity INTEGER NOT NULL CHECK (quantity > 0)
);
CREATE TABLE IF NOT EXISTS kill_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    engaged INTEGER NOT NULL CHECK (engaged IN (0, 1)),
    reason TEXT,
    engaged_ts INTEGER,
    trip_count INTEGER NOT NULL,
    system_state TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS session_counters (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    session_ts INTEGER NOT NULL,
    trades INTEGER NOT NULL,
    turnover INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS orders (
    order_id TEXT PRIMARY KEY,
    client_order_id TEXT NOT NULL UNIQUE,
    symbol TEXT NOT NULL,
    side TEXT NOT NULL,
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    state TEXT NOT NULL,
    filled_quantity INTEGER NOT NULL CHECK (filled_quantity >= 0),
    submitted_ts INTEGER NOT NULL,
    sessions_open INTEGER NOT NULL,
    reject_reason TEXT,
    CHECK (filled_quantity <= quantity)
);
CREATE TABLE IF NOT EXISTS fills (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id TEXT NOT NULL REFERENCES orders(order_id),
    ts_utc INTEGER NOT NULL,
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    price INTEGER NOT NULL CHECK (price > 0),
    cost INTEGER NOT NULL CHECK (cost >= 0)
);
CREATE TABLE IF NOT EXISTS journal_decisions (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    proposal_id TEXT NOT NULL,
    approved INTEGER NOT NULL,
    quantity INTEGER NOT NULL,
    veto TEXT,
    binding_constraint TEXT
);
CREATE TABLE IF NOT EXISTS journal_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    kind TEXT NOT NULL,
    detail TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fills_order ON fills(order_id);
"""


class SchemaMismatch(RuntimeError):
    pass


class ReadOnlyViolation(RuntimeError):
    pass


@dataclass(frozen=True)
class PersistedState:
    cash: int
    reserved: int
    equity_peak: int
    starting_cash: int
    positions: dict[str, int]
    kill: dict
    session: dict


def _connect(path: Path, read_only: bool) -> sqlite3.Connection:
    if read_only:
        connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    else:
        connection = sqlite3.connect(str(path), isolation_level=None)
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA synchronous=FULL")
    connection.execute("PRAGMA foreign_keys=ON")
    connection.row_factory = sqlite3.Row
    return connection


class CoreStore:
    """The Core's authoritative store. Opened read-write by the Trading Core and."""

    def __init__(self, path: Path, starting_cash: int = 0, read_only: bool = False) -> None:
        self.path = Path(path)
        self.read_only = read_only
        if not read_only:
            self.path.parent.mkdir(parents=True, exist_ok=True)
        self._db = _connect(self.path, read_only)
        if not read_only:
            self._db.executescript(SCHEMA)
            self._bootstrap(starting_cash)
        self._check_schema()

    @classmethod
    def read_only_at(cls, path: Path) -> CoreStore:
        return cls(path, read_only=True)

    def _check_schema(self) -> None:
        row = self._db.execute("SELECT value FROM meta WHERE key='schema'").fetchone()
        if row is None:
            raise SchemaMismatch("core store has no schema stamp")
        if row["value"] != SCHEMA_VERSION:
            raise SchemaMismatch(f"store is {row['value']}, code expects {SCHEMA_VERSION}")

    def _bootstrap(self, starting_cash: int) -> None:
        self._db.execute(
            "INSERT OR IGNORE INTO meta(key, value) VALUES ('schema', ?)", (SCHEMA_VERSION,))
        self._db.execute(
            "INSERT OR IGNORE INTO account(id, cash, reserved, equity_peak, starting_cash)"
            " VALUES (1, ?, 0, ?, ?)", (starting_cash, starting_cash, starting_cash))
        self._db.execute(
            "INSERT OR IGNORE INTO kill_state(id, engaged, reason, engaged_ts, trip_count,"
            " system_state) VALUES (1, 0, NULL, NULL, 0, 'NORMAL')")
        self._db.execute(
            "INSERT OR IGNORE INTO session_counters(id, session_ts, trades, turnover)"
            " VALUES (1, 0, 0, 0)")

    def _guard(self) -> None:
        if self.read_only:
            raise ReadOnlyViolation("this store was opened read-only")

    def checkpoint(self, *, cash: int, reserved: int, equity_peak: int,
                   positions: dict[str, int], kill: dict, system_state: str,
                   session: dict, orders: list[dict], fills: list[dict]) -> None:
        """One transaction for the whole state. A partial write is not a state."""
        self._guard()
        db = self._db
        db.execute("BEGIN IMMEDIATE")
        try:
            db.execute("UPDATE account SET cash=?, reserved=?, equity_peak=? WHERE id=1",
                       (cash, reserved, equity_peak))
            db.execute("DELETE FROM positions")
            db.executemany("INSERT INTO positions(symbol, quantity) VALUES (?, ?)",
                           sorted(positions.items()))
            db.execute(
                "UPDATE kill_state SET engaged=?, reason=?, engaged_ts=?, trip_count=?,"
                " system_state=? WHERE id=1",
                (int(kill["engaged"]), kill["reason"], kill["engaged_ts"],
                 kill["trip_count"], system_state))
            db.execute(
                "UPDATE session_counters SET session_ts=?, trades=?, turnover=? WHERE id=1",
                (session["session_ts"], session["trades"], session["turnover"]))
            for order in orders:
                db.execute(
                    "INSERT INTO orders(order_id, client_order_id, symbol, side, quantity,"
                    " state, filled_quantity, submitted_ts, sessions_open, reject_reason)"
                    " VALUES (:order_id,:client_order_id,:symbol,:side,:quantity,:state,"
                    ":filled_quantity,:submitted_ts,:sessions_open,:reject_reason)"
                    " ON CONFLICT(order_id) DO UPDATE SET state=excluded.state,"
                    " filled_quantity=excluded.filled_quantity,"
                    " sessions_open=excluded.sessions_open,"
                    " reject_reason=excluded.reject_reason", order)
            existing = {row["seq"] for row in db.execute("SELECT seq FROM fills")}
            for index, fill in enumerate(fills, start=1):
                if index not in existing:
                    db.execute(
                        "INSERT INTO fills(seq, order_id, ts_utc, quantity, price, cost)"
                        " VALUES (?,?,?,?,?,?)",
                        (index, fill["order_id"], fill["ts_utc"], fill["quantity"],
                         fill["price"], fill["cost"]))
            db.execute("COMMIT")
        except Exception:
            db.execute("ROLLBACK")
            raise

    def record_decision(self, ts: int, decision) -> None:
        self._guard()
        self._db.execute(
            "INSERT INTO journal_decisions(ts, proposal_id, approved, quantity, veto,"
            " binding_constraint) VALUES (?,?,?,?,?,?)",
            (ts, decision.proposal_id, int(decision.approved), decision.quantity,
             decision.veto.value if decision.veto else None, decision.binding_constraint))

    def record_event(self, ts: int, kind: str, detail: str) -> None:
        self._guard()
        self._db.execute("INSERT INTO journal_events(ts, kind, detail) VALUES (?,?,?)",
                         (ts, kind, detail))

    def load(self) -> PersistedState:
        account = self._db.execute("SELECT * FROM account WHERE id=1").fetchone()
        kill = self._db.execute("SELECT * FROM kill_state WHERE id=1").fetchone()
        session = self._db.execute("SELECT * FROM session_counters WHERE id=1").fetchone()
        positions = {row["symbol"]: row["quantity"]
                     for row in self._db.execute("SELECT * FROM positions")}
        return PersistedState(
            cash=account["cash"], reserved=account["reserved"],
            equity_peak=account["equity_peak"], starting_cash=account["starting_cash"],
            positions=positions,
            kill={"engaged": bool(kill["engaged"]), "reason": kill["reason"],
                  "engaged_ts": kill["engaged_ts"], "trip_count": kill["trip_count"],
                  "system_state": kill["system_state"]},
            session={"session_ts": session["session_ts"], "trades": session["trades"],
                     "turnover": session["turnover"]},
        )

    def orders(self) -> list[dict]:
        return [dict(row) for row in
                self._db.execute("SELECT * FROM orders ORDER BY order_id")]

    def fills(self) -> list[dict]:
        return [dict(row) for row in self._db.execute("SELECT * FROM fills ORDER BY seq")]

    def decisions(self) -> list[dict]:
        return [dict(row) for row in
                self._db.execute("SELECT * FROM journal_decisions ORDER BY seq")]

    def events(self, kind: str | None = None) -> list[dict]:
        sql = "SELECT * FROM journal_events"
        params: tuple = ()
        if kind:
            sql += " WHERE kind=?"
            params = (kind,)
        return [dict(row) for row in self._db.execute(sql + " ORDER BY seq", params)]

    def replay_positions(self) -> tuple[int, dict[str, int]]:
        """Rebuild cash and positions from the fill log alone. The materialised."""
        state = self.load()
        cash = state.starting_cash
        positions: dict[str, int] = {}
        sides = {row["order_id"]: row["side"] for row in self.orders()}
        for fill in self.fills():
            side = sides[fill["order_id"]]
            symbol = next(o["symbol"] for o in self.orders()
                          if o["order_id"] == fill["order_id"])
            gross = fill["quantity"] * fill["price"]
            if side == "BUY":
                cash -= gross + fill["cost"]
                positions[symbol] = positions.get(symbol, 0) + fill["quantity"]
            else:
                cash += gross - fill["cost"]
                positions[symbol] = positions.get(symbol, 0) - fill["quantity"]
        return cash, {k: v for k, v in positions.items() if v}

    def journal_agrees_with_state(self) -> bool:
        cash, positions = self.replay_positions()
        state = self.load()
        return cash == state.cash and positions == state.positions

    def close(self) -> None:
        self._db.close()
