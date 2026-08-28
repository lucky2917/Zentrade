"""Holdout protocol, feature blocks and the paired ablation test."""
import numpy as np
import pytest

from zentrade.features.blocks import (
    ACTIVE, ALL_BLOCKS, BASE_BLOCK_NAME, MTF_ALIGNMENT_FEATURES, MTF_ALIGNMENT_NAME,
    MTF_HORIZONS, PENDING, REJECTED, RELATIVE_STRENGTH_NAME, TRADE_LOCATION_FEATURES,
    TRADE_LOCATION_NAME, RejectedBlock, active_blocks, block_feature_names,
    multi_timeframe_alignment, relative_strength, require_active, schema_hash_for,
    trade_location,
)
from zentrade.features.schema import FEATURE_NAMES, schema_hash
from zentrade.learning.ablation import paired_log_loss_test
from zentrade.learning.protocol import (
    DEV_END, HOLDOUT_END, HOLDOUT_START, DevelopmentProtocol, HoldoutLedger,
    HoldoutViolation, describe,
)

DAY = 24 * 60 * 60 * 1_000_000


def ts(year, month, day):
    from datetime import datetime, timezone
    return int(datetime(year, month, day, tzinfo=timezone.utc).timestamp() * 1_000_000)


class TestHoldoutProtocol:
    def test_holdout_window_is_recognised(self):
        protocol = DevelopmentProtocol()
        assert protocol.is_holdout(ts(2025, 12, 1))
        assert not protocol.is_holdout(ts(2024, 12, 1))

    def test_boundaries_are_inclusive_of_the_start(self):
        protocol = DevelopmentProtocol()
        assert protocol.is_holdout(ts(HOLDOUT_START.year, HOLDOUT_START.month,
                                      HOLDOUT_START.day))

    def test_development_ends_before_the_holdout_begins(self):
        assert DEV_END < HOLDOUT_START

    def test_guard_raises_on_any_holdout_row(self):
        protocol = DevelopmentProtocol()
        with pytest.raises(HoldoutViolation, match="frozen holdout"):
            protocol.assert_no_holdout([ts(2024, 1, 1), ts(2026, 1, 1)])

    def test_guard_passes_on_a_clean_development_slice(self):
        DevelopmentProtocol().assert_no_holdout([ts(2023, 1, 1), ts(2024, 6, 1)])

    def test_guard_names_the_earliest_leak(self):
        protocol = DevelopmentProtocol()
        with pytest.raises(HoldoutViolation) as excinfo:
            protocol.assert_no_holdout([ts(2026, 5, 1), ts(2025, 9, 1)])
        assert "2025-09-01" in str(excinfo.value)

    def test_index_partition_is_complete_and_disjoint(self):
        stamps = [ts(2023, 1, 1), ts(2026, 1, 1), ts(2024, 1, 1)]
        protocol = DevelopmentProtocol()
        dev = set(protocol.development_indices(stamps))
        hold = set(protocol.holdout_indices(stamps))
        assert dev | hold == {0, 1, 2}
        assert dev & hold == set()

    def test_describe_names_both_windows(self):
        described = describe()
        assert described["frozen_holdout"]["start"] == HOLDOUT_START.isoformat()
        assert described["frozen_holdout"]["end"] == HOLDOUT_END.isoformat()


class TestHoldoutLedger:
    def test_empty_ledger_counts_zero(self, tmp_path):
        assert HoldoutLedger(tmp_path / "looks.jsonl").count() == 0

    def test_a_look_is_recorded_and_persists(self, tmp_path):
        ledger = HoldoutLedger(tmp_path / "looks.jsonl")
        ledger.record_look("final confirmation", "logistic", "abc", "2026-08-28")
        assert HoldoutLedger(tmp_path / "looks.jsonl").count() == 1
        assert ledger.looks()[0]["reason"] == "final confirmation"

    def test_looks_accumulate(self, tmp_path):
        ledger = HoldoutLedger(tmp_path / "looks.jsonl")
        for index in range(3):
            ledger.record_look("r", "m", str(index), "t")
        assert ledger.count() == 3


class TestBlocks:
    def test_base_only_keeps_the_features_v1_identity(self):
        assert schema_hash_for((BASE_BLOCK_NAME,)) == schema_hash()

    def test_adding_a_block_changes_the_schema_hash(self):
        assert schema_hash_for((BASE_BLOCK_NAME, RELATIVE_STRENGTH_NAME)) != schema_hash()

    def test_feature_names_concatenate_in_block_order(self):
        names = block_feature_names((BASE_BLOCK_NAME, RELATIVE_STRENGTH_NAME))
        assert names[:len(FEATURE_NAMES)] == FEATURE_NAMES
        assert len(names) == len(FEATURE_NAMES) + 3

    def test_relative_strength_is_marked_rejected(self):
        assert ALL_BLOCKS[RELATIVE_STRENGTH_NAME].status == REJECTED
        assert ALL_BLOCKS[RELATIVE_STRENGTH_NAME].verdict

    def test_active_blocks_excludes_rejected_ones(self):
        assert RELATIVE_STRENGTH_NAME not in active_blocks()
        assert BASE_BLOCK_NAME in active_blocks()

    def test_a_rejected_block_cannot_enter_an_active_schema(self):
        with pytest.raises(RejectedBlock, match=RELATIVE_STRENGTH_NAME):
            require_active((BASE_BLOCK_NAME, RELATIVE_STRENGTH_NAME))

    def test_active_only_schema_is_permitted(self):
        require_active((BASE_BLOCK_NAME,))


class _Row:
    def __init__(self, symbol, values, complete=True):
        self.symbol, self.values, self.complete = symbol, values, complete


class _Snapshot:
    def __init__(self, rows):
        self.rows = rows


def _row(symbol, r5, r21):
    values = [0.0] * len(FEATURE_NAMES)
    values[FEATURE_NAMES.index("return_5d")] = r5
    values[FEATURE_NAMES.index("return_21d")] = r21
    return _Row(symbol, tuple(values))


class TestRelativeStrength:
    def test_excess_return_is_measured_against_the_cross_section(self):
        rows = [_row(f"S{i}", 0.01 * i, 0.02 * i) for i in range(5)]
        out = relative_strength(_Snapshot(rows))
        assert out["S0"][0] == pytest.approx(0.0 - np.mean([0.0, .01, .02, .03, .04]))

    def test_excess_returns_sum_to_zero_across_the_universe(self):
        rows = [_row(f"S{i}", 0.01 * i, 0.02 * i) for i in range(6)]
        out = relative_strength(_Snapshot(rows))
        assert sum(v[0] for v in out.values()) == pytest.approx(0.0, abs=1e-12)

    def test_rank_is_bounded_and_ordered(self):
        rows = [_row(f"S{i}", 0.0, 0.01 * i) for i in range(10)]
        out = relative_strength(_Snapshot(rows))
        ranks = [out[f"S{i}"][2] for i in range(10)]
        assert all(0.0 <= r <= 1.0 for r in ranks)
        assert ranks == sorted(ranks)

    def test_a_tiny_universe_yields_no_relative_features(self):
        rows = [_row("A", 0.01, 0.02), _row("B", 0.02, 0.03)]
        assert all(v is None for v in relative_strength(_Snapshot(rows))["A"])

    def test_incomplete_rows_get_no_relative_features(self):
        rows = [_row(f"S{i}", 0.01 * i, 0.02 * i) for i in range(6)]
        rows.append(_Row("BAD", tuple([0.0] * len(FEATURE_NAMES)), complete=False))
        assert all(v is None for v in relative_strength(_Snapshot(rows))["BAD"])


class TestPairedTest:
    def test_identical_predictions_show_no_improvement(self):
        y = np.array([1, 0, 1, 0])
        p = np.array([0.6, 0.4, 0.7, 0.3])
        result = paired_log_loss_test(y, p, p)
        assert result["mean_improvement"] == pytest.approx(0.0)

    def test_a_better_arm_shows_positive_improvement(self):
        rng = np.random.default_rng(0)
        y = (rng.random(2000) < 0.4).astype(int)
        worse = np.full(2000, 0.5)
        better = np.where(y == 1, 0.6, 0.3)
        result = paired_log_loss_test(y, worse, better)
        assert result["mean_improvement"] > 0 and result["t_stat"] > 3

    def test_a_worse_arm_shows_negative_improvement(self):
        rng = np.random.default_rng(1)
        y = (rng.random(2000) < 0.4).astype(int)
        result = paired_log_loss_test(y, np.full(2000, 0.4), np.where(y == 1, 0.2, 0.8))
        assert result["mean_improvement"] < 0

    def test_sample_count_is_reported(self):
        y = np.array([1, 0, 1])
        assert paired_log_loss_test(y, np.full(3, 0.5), np.full(3, 0.5))["n"] == 3


def _horizons(**kwargs):
    values = [0.0] * len(FEATURE_NAMES)
    for name, value in kwargs.items():
        values[FEATURE_NAMES.index(name)] = value
    return tuple(values)


class TestMultiTimeframeAlignment:
    def test_all_horizons_up_is_full_positive_alignment(self):
        values = _horizons(**{h: 0.01 for h in MTF_HORIZONS})
        alignment, conflict, dispersion = multi_timeframe_alignment(values)
        assert alignment == pytest.approx(1.0)
        assert conflict == 0.0 and dispersion == 0.0

    def test_all_horizons_down_is_full_negative_alignment(self):
        values = _horizons(**{h: -0.01 for h in MTF_HORIZONS})
        assert multi_timeframe_alignment(values)[0] == pytest.approx(-1.0)

    def test_alignment_is_bounded(self):
        import itertools
        for signs in itertools.product((-0.01, 0.0, 0.01), repeat=len(MTF_HORIZONS)):
            values = _horizons(**dict(zip(MTF_HORIZONS, signs)))
            alignment, _, dispersion = multi_timeframe_alignment(values)
            assert -1.0 <= alignment <= 1.0
            assert 0.0 <= dispersion <= 1.0

    def test_conflict_fires_when_shortest_disagrees_with_longest(self):
        values = _horizons(return_1d=0.01, return_5d=0.01, return_21d=0.01,
                           sma20_ratio=0.01, sma50_ratio=-0.01)
        assert multi_timeframe_alignment(values)[1] == 1.0

    def test_conflict_does_not_fire_when_they_agree(self):
        values = _horizons(**{h: 0.01 for h in MTF_HORIZONS})
        assert multi_timeframe_alignment(values)[1] == 0.0

    def test_a_zero_horizon_cannot_create_a_conflict(self):
        """Zero is not a direction, so it must not be read as disagreement."""
        values = _horizons(return_1d=0.0, sma50_ratio=0.01)
        assert multi_timeframe_alignment(values)[1] == 0.0

    def test_dispersion_counts_adjacent_disagreements(self):
        values = _horizons(return_1d=0.01, return_5d=-0.01, return_21d=0.01,
                           sma20_ratio=-0.01, sma50_ratio=0.01)
        assert multi_timeframe_alignment(values)[2] == pytest.approx(1.0)

    def test_block_declares_three_features(self):
        assert len(MTF_ALIGNMENT_FEATURES) == 3
        assert multi_timeframe_alignment(_horizons()) is not None

    def test_block_is_marked_rejected(self):
        assert ALL_BLOCKS[MTF_ALIGNMENT_NAME].status == REJECTED
        assert "intraday" in ALL_BLOCKS[MTF_ALIGNMENT_NAME].verdict

    def test_rejected_block_two_cannot_enter_an_active_schema(self):
        with pytest.raises(RejectedBlock, match=MTF_ALIGNMENT_NAME):
            require_active((BASE_BLOCK_NAME, MTF_ALIGNMENT_NAME))

    def test_no_block_is_active_beyond_the_base(self):
        assert active_blocks() == (BASE_BLOCK_NAME,)

    def test_compression_is_not_duplicated_from_the_base_block(self):
        """v4 6.2 lists compression_state; the base block already carries."""
        assert "vol_compression" in FEATURE_NAMES
        assert not any("compression" in f for f in MTF_ALIGNMENT_FEATURES)


class TestTradeLocation:
    def test_volatility_normalisation_separates_quiet_from_loud_names(self):
        """The same percent extension is a different trade location depending."""
        quiet = _horizons(sma20_ratio=0.05, atr14_pct=0.01)
        loud = _horizons(sma20_ratio=0.05, atr14_pct=0.05)
        assert trade_location(quiet)[0] == pytest.approx(5.0)
        assert trade_location(loud)[0] == pytest.approx(1.0)

    def test_a_degenerate_atr_makes_the_feature_undefined(self):
        """A near-zero ATR makes the ratio meaningless rather than large."""
        assert trade_location(_horizons(sma20_ratio=0.05, atr14_pct=0.0)) == (None, None, None)
        assert trade_location(_horizons(sma20_ratio=0.05, atr14_pct=-1.0)) == (None, None, None)

    def test_sign_is_preserved(self):
        below = trade_location(_horizons(sma20_ratio=-0.04, atr14_pct=0.02))
        assert below[0] == pytest.approx(-2.0)

    def test_three_features_declared(self):
        assert len(TRADE_LOCATION_FEATURES) == 3

    def test_block_is_held_pending_not_silently_activated(self):
        assert ALL_BLOCKS[TRADE_LOCATION_NAME].status == PENDING
        assert "anti-duplication" in ALL_BLOCKS[TRADE_LOCATION_NAME].verdict

    def test_a_pending_block_cannot_enter_an_active_schema(self):
        with pytest.raises(RejectedBlock, match=TRADE_LOCATION_NAME):
            require_active((BASE_BLOCK_NAME, TRADE_LOCATION_NAME))

    def test_only_the_base_block_is_active(self):
        assert active_blocks() == (BASE_BLOCK_NAME,)
