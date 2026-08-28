"""Holdout protocol, feature blocks and the paired ablation test."""
import numpy as np
import pytest

from zentrade.features.blocks import (
    ACTIVE, ALL_BLOCKS, BASE_BLOCK_NAME, MTF_ALIGNMENT_FEATURES, MTF_ALIGNMENT_NAME,
    MARKET_CONTEXT_FEATURES, MARKET_CONTEXT_NAME, MTF_HORIZONS, PENDING, REJECTED,
    SETUP_MIN_SAMPLES, SETUP_NONE, SETUP_TYPES, SETUP_TYPING_FEATURES, SETUP_TYPING_NAME,
    classify_setup, setup_typing,
    RELATIVE_STRENGTH_NAME, TRADE_LOCATION_FEATURES, TRADE_LOCATION_NAME,
    TRADE_LOCATION_FUTURE, RejectedBlock, active_blocks, block_feature_names,
    market_context, multi_timeframe_alignment, relative_strength, require_active,
    schema_hash_for, trade_location,
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

    def test_block_is_rejected_by_operator_ruling(self):
        """Held PENDING while two frozen rules disagreed, then ruled REJECTED."""
        assert ALL_BLOCKS[TRADE_LOCATION_NAME].status == REJECTED
        assert "Operator ruling" in ALL_BLOCKS[TRADE_LOCATION_NAME].verdict
        assert "anti-duplication" in ALL_BLOCKS[TRADE_LOCATION_NAME].verdict

    def test_pending_remains_a_usable_state_for_future_conflicts(self):
        assert PENDING != REJECTED and PENDING != ACTIVE

    def test_a_rejected_block_cannot_enter_an_active_schema(self):
        with pytest.raises(RejectedBlock, match=TRADE_LOCATION_NAME):
            require_active((BASE_BLOCK_NAME, TRADE_LOCATION_NAME))

    def test_only_the_base_block_is_active(self):
        assert active_blocks() == (BASE_BLOCK_NAME,)


class _Snap:
    def __init__(self, rows):
        self.rows = rows


def _mk(sma20, ret1d, ret21d, complete=True):
    values = [0.0] * len(FEATURE_NAMES)
    values[FEATURE_NAMES.index("sma20_ratio")] = sma20
    values[FEATURE_NAMES.index("return_1d")] = ret1d
    values[FEATURE_NAMES.index("return_21d")] = ret21d
    return _Row("S", tuple(values), complete)


class TestMarketContext:
    def test_breadth_counts_the_universe_not_the_symbol(self):
        rows = [_mk(0.01, 0.01, 0.02) for _ in range(8)] + \
               [_mk(-0.01, -0.01, -0.02) for _ in range(2)]
        above, advancing, _ = market_context(_Snap(rows))
        assert above == pytest.approx(0.8)
        assert advancing == pytest.approx(0.8)

    def test_breadth_is_bounded(self):
        rows = [_mk(0.01, 0.01, 0.02) for _ in range(12)]
        above, advancing, _ = market_context(_Snap(rows))
        assert 0.0 <= above <= 1.0 and 0.0 <= advancing <= 1.0

    def test_dispersion_is_zero_when_the_universe_moves_together(self):
        rows = [_mk(0.01, 0.01, 0.05) for _ in range(15)]
        assert market_context(_Snap(rows))[2] == pytest.approx(0.0)

    def test_dispersion_grows_when_returns_scatter(self):
        tight = [_mk(0.01, 0.01, 0.05 + i * 0.001) for i in range(15)]
        wide = [_mk(0.01, 0.01, 0.05 + i * 0.05) for i in range(15)]
        assert market_context(_Snap(wide))[2] > market_context(_Snap(tight))[2]

    def test_a_tiny_universe_yields_no_context(self):
        assert market_context(_Snap([_mk(0.01, 0.01, 0.02)] * 3)) == (None, None, None)

    def test_incomplete_rows_do_not_count_toward_breadth(self):
        rows = [_mk(0.01, 0.01, 0.02) for _ in range(10)] + \
               [_mk(-1.0, -1.0, -1.0, complete=False) for _ in range(10)]
        assert market_context(_Snap(rows))[0] == pytest.approx(1.0)

    def test_block_is_rejected_on_evidence_not_duplication(self):
        assert ALL_BLOCKS[MARKET_CONTEXT_NAME].status == REJECTED
        assert "anti-duplication gate cleanly" in ALL_BLOCKS[MARKET_CONTEXT_NAME].verdict

    def test_only_the_base_block_remains_active(self):
        assert active_blocks() == (BASE_BLOCK_NAME,)


class TestClusteredInference:
    def test_clustering_recovers_the_effective_sample_size(self):
        """With the improvement identical inside each session, the unclustered."""
        import numpy as np
        from zentrade.learning.ablation import paired_log_loss_test

        rng = np.random.default_rng(2)
        days, per_day = 200, 50
        cluster = np.repeat(np.arange(days), per_day)
        y = np.repeat((rng.random(days) < 0.4).astype(int), per_day)
        base = np.where(y == 1, 0.45, 0.35)
        shifted = np.clip(base + np.repeat(rng.normal(0.0005, 0.004, days), per_day),
                          0.02, 0.98)
        result = paired_log_loss_test(y, base, shifted, cluster_by=cluster)
        inflation = abs(result["t_unclustered"] / result["t_stat"])
        assert result["clusters"] == days
        assert inflation == pytest.approx(np.sqrt(per_day), rel=0.05)

    def test_unclustered_call_reports_no_clusters(self):
        import numpy as np
        from zentrade.learning.ablation import paired_log_loss_test
        y = np.array([1, 0, 1, 0])
        result = paired_log_loss_test(y, np.full(4, 0.5), np.full(4, 0.6))
        assert result["clusters"] is None
        assert result["t_stat"] == result["t_unclustered"]


class TestFutureVariants:
    def test_five_trade_location_variants_are_recorded_untested(self):
        assert len(TRADE_LOCATION_FUTURE) == 5
        names = {v.name for v in TRADE_LOCATION_FUTURE}
        assert names == {"distance_from_trigger", "time_since_trigger",
                         "distance_from_vwap", "time_since_catalyst", "session_phase"}

    def test_every_future_variant_names_what_blocks_it(self):
        assert all(v.blocked_on for v in TRADE_LOCATION_FUTURE)

    def test_no_future_variant_leaked_into_a_block(self):
        recorded = {v.name for v in TRADE_LOCATION_FUTURE}
        for block in ALL_BLOCKS.values():
            assert not (recorded & set(block.features))


def _setup_row(**kwargs):
    values = [0.0] * len(FEATURE_NAMES)
    for name, value in kwargs.items():
        values[FEATURE_NAMES.index(name)] = value
    return tuple(values)


class TestSetupTyping:
    def test_seven_types_declared_under_the_v4_ceiling_of_eight(self):
        assert len(SETUP_TYPES) == 7
        assert len(SETUP_TYPING_FEATURES) == 7

    def test_event_driven_is_absent_because_it_needs_the_event_store(self):
        assert not any("event" in name for name in SETUP_TYPES)

    @pytest.mark.parametrize("kwargs,expected", [
        ({"dist_from_252d_high": -0.05, "return_5d": -0.06}, "failed_breakout"),
        ({"dist_from_252d_high": -0.01, "volume_ratio_20d": 1.5}, "breakout"),
        ({"dist_from_252d_low": 0.01, "volume_ratio_20d": 1.5,
          "dist_from_252d_high": -0.5}, "breakdown"),
        ({"return_21d": 0.15, "volume_ratio_20d": 0.5,
          "dist_from_252d_high": -0.3}, "momentum_exhaustion"),
        ({"sma50_ratio": 0.05, "sma20_ratio": -0.02, "return_5d": -0.01,
          "dist_from_252d_high": -0.3}, "pullback_in_trend"),
        ({"sma20_ratio": -0.12, "return_1d": 0.01,
          "dist_from_252d_high": -0.3}, "mean_reversion"),
        ({"vol_compression": 1.5, "dist_from_252d_high": -0.3}, "volatility_expansion"),
        ({"dist_from_252d_high": -0.3}, SETUP_NONE),
    ])
    def test_classification(self, kwargs, expected):
        assert classify_setup(_setup_row(**kwargs)) == expected

    def test_types_are_mutually_exclusive(self):
        """Priority resolves overlap, so the per-type counts mean what they say."""
        overlapping = _setup_row(dist_from_252d_high=-0.01, return_5d=-0.06,
                                 volume_ratio_20d=1.5)
        encoded = setup_typing(overlapping)
        assert sum(encoded) == 1

    def test_none_is_the_reference_level_and_gets_no_column(self):
        assert sum(setup_typing(_setup_row(dist_from_252d_high=-0.3))) == 0
        assert SETUP_NONE not in SETUP_TYPES

    def test_encoding_width_matches_the_type_count(self):
        assert len(setup_typing(_setup_row())) == len(SETUP_TYPES)

    def test_encoding_is_binary(self):
        encoded = setup_typing(_setup_row(vol_compression=1.5,
                                          dist_from_252d_high=-0.3))
        assert set(encoded) <= {0.0, 1.0}

    def test_sparse_floor_is_declared(self):
        assert SETUP_MIN_SAMPLES == 200

    def test_block_is_held_pending_an_operator_ruling(self):
        assert ALL_BLOCKS[SETUP_TYPING_NAME].status == PENDING
        assert "KEEP" in ALL_BLOCKS[SETUP_TYPING_NAME].verdict

    def test_a_pending_block_cannot_enter_an_active_schema(self):
        with pytest.raises(RejectedBlock, match=SETUP_TYPING_NAME):
            require_active((BASE_BLOCK_NAME, SETUP_TYPING_NAME))

    def test_active_schema_is_still_base_only(self):
        assert active_blocks() == (BASE_BLOCK_NAME,)
