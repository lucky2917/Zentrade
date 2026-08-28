"""Replay determinism and adapter equivalence."""
from datetime import date, datetime, timedelta, timezone

import numpy as np
import pyarrow as pa
import pytest

from zentrade.adapters.data.pit import InMemoryPitSource, SpinePitSource
from zentrade.features.engine import compute_features
from zentrade.features.schema import schema_hash
from zentrade.replay.harness import (
    replay_digest, run_replay, session_timestamps, snapshot_digest, to_records,
)
from zentrade.spine.semantics import BAR_SCHEMA
from zentrade.spine.writer import write_bars

BASE = datetime(2024, 1, 1, tzinfo=timezone.utc)


def ts(offset: int) -> int:
    return int((BASE + timedelta(days=offset)).timestamp() * 1_000_000)


def synth(symbol: str, sessions: int, seed: int):
    rng = np.random.default_rng(seed)
    price, rows = 100_00, []
    for index in range(sessions):
        price = max(100, int(price * (1 + rng.normal(0, 0.012))))
        rows.append({"symbol": symbol, "ts_utc": ts(index), "open": price,
                     "high": int(price * 1.01), "low": int(price * 0.99),
                     "close": price, "volume": int(rng.integers(1_000, 50_000))})
    return rows


@pytest.fixture
def populated(tmp_path):
    for index, symbol in enumerate(["AAA", "BBB", "CCC"]):
        write_bars(tmp_path, "NSE", "1d", synth(symbol, 320, seed=index))
    return tmp_path


class TestDeterminism:
    def test_repeated_runs_produce_an_identical_digest(self, populated):
        source = SpinePitSource(populated, adjust=False)
        stamps = [ts(n) for n in range(300, 315)]
        first = run_replay(source, stamps)
        second = run_replay(source, stamps)
        assert replay_digest(first) == replay_digest(second)

    def test_a_fresh_source_object_gives_the_same_digest(self, populated):
        stamps = [ts(n) for n in range(300, 315)]
        a = run_replay(SpinePitSource(populated, adjust=False), stamps)
        b = run_replay(SpinePitSource(populated, adjust=False), stamps)
        assert replay_digest(a) == replay_digest(b)

    def test_digest_changes_when_a_value_changes(self, populated):
        stamps = [ts(n) for n in range(300, 305)]
        before = replay_digest(run_replay(SpinePitSource(populated, adjust=False), stamps))
        write_bars(populated, "NSE", "1d", [{
            "symbol": "AAA", "ts_utc": ts(299), "open": 1, "high": 1,
            "low": 1, "close": 1, "volume": 1}])
        after = replay_digest(run_replay(SpinePitSource(populated, adjust=False), stamps))
        assert before != after, "digest must be sensitive to the data it covers"

    def test_snapshot_order_is_stable(self, populated):
        source = SpinePitSource(populated, adjust=False)
        snapshot = compute_features(source, as_of=ts(310))
        assert [row.symbol for row in snapshot.rows] == sorted(
            row.symbol for row in snapshot.rows)

    def test_replay_covers_every_requested_stamp(self, populated):
        stamps = [ts(n) for n in range(300, 310)]
        result = run_replay(SpinePitSource(populated, adjust=False), stamps)
        assert len(result) == len(stamps)
        assert [s.as_of for s in result.snapshots] == list(stamps)


class TestAdapterEquivalence:
    """One engine, several adapters. If the engine behaved differently per."""

    def test_spine_and_in_memory_sources_agree(self, populated):
        spine = SpinePitSource(populated, adjust=False)
        raw = spine.bars_before(as_of=ts(320), lookback_sessions=400)
        memory = InMemoryPitSource(raw)

        as_of = ts(310)
        from_spine = compute_features(spine, as_of=as_of)
        from_memory = compute_features(memory, as_of=as_of)
        assert snapshot_digest(from_spine) == snapshot_digest(from_memory)

    def test_engine_takes_no_mode_parameter(self):
        import inspect
        parameters = set(inspect.signature(compute_features).parameters)
        for forbidden in ("mode", "live", "paper", "replay", "is_backtest"):
            assert forbidden not in parameters, f"engine branches on {forbidden}"


class TestSessionStamps:
    def test_weekends_excluded(self):
        stamps = session_timestamps(date(2024, 1, 1), date(2024, 1, 7))
        assert len(stamps) == 5

    def test_sequence_is_a_pure_function_of_the_range(self):
        a = session_timestamps(date(2024, 1, 1), date(2024, 3, 1))
        b = session_timestamps(date(2024, 1, 1), date(2024, 3, 1))
        assert a == b


class TestRecords:
    def test_records_carry_schema_named_columns(self, populated):
        result = run_replay(SpinePitSource(populated, adjust=False), [ts(310)])
        records = to_records(result)
        assert records
        from zentrade.features.schema import FEATURE_NAMES
        for name in FEATURE_NAMES:
            assert name in records[0]

    def test_result_records_the_schema_hash(self, populated):
        result = run_replay(SpinePitSource(populated, adjust=False), [ts(310)])
        assert result.schema_hash == schema_hash()
