"""Feature engine behaviour."""
from datetime import datetime, timedelta, timezone

import pyarrow as pa
import pytest

from zentrade.adapters.data.pit import InMemoryPitSource, SpinePitSource
from zentrade.features.engine import compute_features
from zentrade.features.schema import FEATURE_NAMES, schema_hash
from zentrade.spine.semantics import ADJUSTMENT_SCHEMA, BAR_SCHEMA
from zentrade.spine.writer import write_adjustments, write_bars

BASE = datetime(2024, 1, 1, tzinfo=timezone.utc)
ts = lambda n: int((BASE + timedelta(days=n)).timestamp() * 1_000_000)


def flat(symbol, sessions, price=100_00, start=0):
    return [{"symbol": symbol, "ts_utc": ts(start + i), "open": price, "high": price,
             "low": price, "close": price, "volume": 1_000} for i in range(sessions)]


class TestOutputShape:
    def test_values_match_schema_length_and_order(self):
        source = InMemoryPitSource(pa.Table.from_pylist(flat("AAA", 60), schema=BAR_SCHEMA))
        row = compute_features(source, as_of=ts(60)).rows[0]
        assert len(row.values) == len(FEATURE_NAMES)
        assert list(row.as_dict()) == list(FEATURE_NAMES)

    def test_snapshot_records_the_schema_hash(self):
        source = InMemoryPitSource(pa.Table.from_pylist(flat("AAA", 10), schema=BAR_SCHEMA))
        assert compute_features(source, as_of=ts(10)).schema_hash == schema_hash()

    def test_symbol_filter_is_honoured(self):
        rows = flat("AAA", 30) + flat("BBB", 30)
        source = InMemoryPitSource(pa.Table.from_pylist(rows, schema=BAR_SCHEMA))
        snapshot = compute_features(source, as_of=ts(30), symbols=["BBB"])
        assert [r.symbol for r in snapshot.rows] == ["BBB"]


class TestFlatSeries:
    def test_flat_prices_give_zero_returns_and_zero_vol(self):
        source = InMemoryPitSource(pa.Table.from_pylist(flat("AAA", 300), schema=BAR_SCHEMA))
        values = compute_features(source, as_of=ts(300)).rows[0].as_dict()
        assert values["return_1d"] == 0.0
        assert values["return_21d"] == 0.0
        assert values["realized_vol_20d"] == 0.0
        assert values["sma20_ratio"] == 0.0

    def test_zero_range_day_gives_no_range_position(self):
        source = InMemoryPitSource(pa.Table.from_pylist(flat("AAA", 30), schema=BAR_SCHEMA))
        assert compute_features(source, as_of=ts(30)).rows[0].as_dict()["range_position"] is None


class TestAdjustmentApplied:
    def test_a_split_does_not_appear_as_a_price_collapse(self, tmp_path):
        """Without adjustment a 1:10 split reads as a 90 percent crash."""
        pre = flat("AAA", 250, price=1000_00, start=0)
        post = flat("AAA", 30, price=100_00, start=250)
        write_bars(tmp_path, "NSE", "1d", pre + post)
        write_adjustments(tmp_path, "NSE", [{
            "symbol": "AAA", "effective_ts_utc": ts(250), "kind": "split",
            "numerator": 1, "denominator": 10, "source": "test"}])

        raw = compute_features(SpinePitSource(tmp_path, adjust=False),
                               as_of=ts(280)).rows[0].as_dict()
        adjusted = compute_features(SpinePitSource(tmp_path, adjust=True),
                                    as_of=ts(280)).rows[0].as_dict()

        assert raw["dist_from_252d_high"] < -0.85, "raw series should show the artefact"
        assert adjusted["dist_from_252d_high"] == pytest.approx(0.0, abs=1e-9)

    def test_adjustment_is_bounded_by_as_of(self, tmp_path):
        """An action effective after as_of must not be applied."""
        write_bars(tmp_path, "NSE", "1d", flat("AAA", 300))
        write_adjustments(tmp_path, "NSE", [{
            "symbol": "AAA", "effective_ts_utc": ts(400), "kind": "split",
            "numerator": 1, "denominator": 10, "source": "test"}])
        before = compute_features(SpinePitSource(tmp_path, adjust=True),
                                  as_of=ts(300)).rows[0].as_dict()
        assert before["return_21d"] == 0.0, "a future split leaked into the past"

    def test_turnover_is_invariant_under_adjustment(self, tmp_path):
        """Price scales down and volume up by the same factor."""
        write_bars(tmp_path, "NSE", "1d", flat("AAA", 100, price=1000_00))
        write_adjustments(tmp_path, "NSE", [{
            "symbol": "AAA", "effective_ts_utc": ts(50), "kind": "split",
            "numerator": 1, "denominator": 10, "source": "test"}])
        source = SpinePitSource(tmp_path, adjust=True)
        table = source.bars_before(as_of=ts(100), lookback_sessions=200)
        closes = table.column("close").to_pylist()
        volumes = table.column("volume").to_pylist()
        turnovers = {c * v for c, v in zip(closes, volumes)}
        assert len(turnovers) == 1, f"turnover changed across the split: {turnovers}"
