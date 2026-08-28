"""Splits, metrics, ladder, calibration and trial accounting."""
import math

import numpy as np
import pytest

from zentrade.learning import metrics as mx
from zentrade.learning.calibration import (
    IdentityCalibrator, IsotonicCalibrator, PlattCalibrator, calibrators,
)
from zentrade.learning.dataset import Dataset
from zentrade.learning.experiment import (
    decision_outcome, random_entry, top_quantile_outcome,
)
from zentrade.learning.models import ConstantNull, LogisticModel, RuleBaseline, ladder
from zentrade.learning.registry import TrialRecord, TrialRegistry, deflated_threshold
from zentrade.learning.splits import SplitSpec, split_by_time

DAY = 24 * 60 * 60 * 1_000_000


class TestSplits:
    def _stamps(self, sessions=300, per_session=3):
        return [i * DAY for i in range(sessions) for _ in range(per_session)]

    def test_blocks_are_chronological_and_disjoint(self):
        stamps = self._stamps()
        split = split_by_time(stamps, SplitSpec())
        train = [stamps[i] for i in split.train]
        calib = [stamps[i] for i in split.calibration]
        evaluation = [stamps[i] for i in split.evaluation]
        assert max(train) < min(calib) < max(calib) < min(evaluation)
        assert set(split.train).isdisjoint(split.calibration)
        assert set(split.calibration).isdisjoint(split.evaluation)

    def test_purge_removes_samples_at_the_boundary(self):
        assert split_by_time(self._stamps(), SplitSpec()).purged > 0

    def test_no_purge_and_no_embargo_loses_nothing(self):
        split = split_by_time(self._stamps(),
                              SplitSpec(purge_sessions=0, embargo_sessions=0))
        assert split.purged == 0

    def test_a_larger_gap_purges_more(self):
        small = split_by_time(self._stamps(), SplitSpec(purge_sessions=5, embargo_sessions=0))
        large = split_by_time(self._stamps(), SplitSpec(purge_sessions=40, embargo_sessions=0))
        assert large.purged > small.purged

    def test_every_sample_is_kept_or_purged_exactly_once(self):
        stamps = self._stamps()
        split = split_by_time(stamps, SplitSpec())
        assert (len(split.train) + len(split.calibration) + len(split.evaluation)
                + split.purged) == len(stamps)

    @pytest.mark.parametrize("bad", [
        {"train_fraction": 0.0}, {"train_fraction": 1.0},
        {"train_fraction": 0.9, "calibration_fraction": 0.2},
        {"purge_sessions": -1},
    ])
    def test_invalid_specs_rejected(self, bad):
        with pytest.raises(ValueError):
            SplitSpec(**bad)

    def test_too_few_sessions_rejected(self):
        with pytest.raises(ValueError):
            split_by_time([0, DAY], SplitSpec())


class TestMetrics:
    def test_log_loss_of_a_perfect_prediction_is_near_zero(self):
        assert mx.log_loss([1, 0], [1 - 1e-12, 1e-12]) < 1e-6

    def test_log_loss_of_a_coin_flip_is_ln_two(self):
        assert mx.log_loss([1, 0, 1, 0], [0.5] * 4) == pytest.approx(math.log(2))

    def test_brier_of_a_perfect_prediction_is_zero(self):
        assert mx.brier([1, 0], [1.0, 0.0]) == 0.0

    def test_auc_is_half_for_a_constant_predictor(self):
        assert mx.auc([1, 0, 1, 0], [0.5] * 4) == 0.5

    def test_auc_is_one_for_perfect_separation(self):
        assert mx.auc([0, 0, 1, 1], [0.1, 0.2, 0.8, 0.9]) == 1.0

    def test_ece_is_zero_when_predictions_match_frequency(self):
        y = [1] * 30 + [0] * 70
        assert mx.expected_calibration_error(y, [0.3] * 100) == pytest.approx(0.0, abs=1e-9)

    def test_ece_grows_with_miscalibration(self):
        y = [1] * 30 + [0] * 70
        assert mx.expected_calibration_error(y, [0.9] * 100) > \
               mx.expected_calibration_error(y, [0.4] * 100)

    def test_reliability_bins_cover_the_unit_interval(self):
        bins = mx.reliability([1, 0], [0.05, 0.95], bins=10)
        assert len(bins) == 10 and bins[0].count == 1 and bins[-1].count == 1


class TestLadder:
    def _data(self, n=600, seed=0):
        rng = np.random.default_rng(seed)
        X = rng.normal(size=(n, 12))
        y = (X[:, 2] + rng.normal(0, 1, n) > 0).astype(int)
        return X, y

    def test_ladder_is_in_dependency_order(self):
        assert [m.name for m in ladder()] == [
            "constant_null", "rule_momentum_trend",
            "logistic_unpenalised", "logistic_elasticnet"]

    def test_constant_null_predicts_the_base_rate(self):
        X, y = self._data()
        model = ConstantNull()
        model.fit(X, y)
        p = model.predict_proba(X)
        assert np.allclose(p, y.mean())
        assert p.std() == 0.0

    def test_rule_baseline_is_deterministic_and_two_valued(self):
        X, y = self._data()
        model = RuleBaseline()
        model.fit(X, y)
        assert len(np.unique(model.predict_proba(X))) <= 2

    def test_logistic_learns_a_planted_signal_in_sample(self):
        X, y = self._data()
        model = LogisticModel(penalty=None)
        model.fit(X, y)
        assert mx.auc(y.tolist(), model.predict_proba(X).tolist()) > 0.7

    def test_scaler_is_fitted_on_training_data_only(self):
        X, y = self._data()
        model = LogisticModel(penalty=None)
        model.fit(X[:300], y[:300])
        assert np.allclose(model.scaler.mean, X[:300].mean(axis=0))

    def test_probabilities_stay_within_the_unit_interval(self):
        X, y = self._data()
        for model in ladder():
            model.fit(X, y)
            p = model.predict_proba(X)
            assert p.min() >= 0.0 and p.max() <= 1.0


class TestCalibration:
    def test_identity_leaves_probabilities_untouched(self):
        p = np.array([0.2, 0.5, 0.8])
        assert np.array_equal(IdentityCalibrator().transform(p), p)

    def test_platt_pulls_a_biased_score_toward_the_observed_rate(self):
        rng = np.random.default_rng(1)
        y = (rng.random(2000) < 0.3).astype(int)
        p = np.clip(y * 0.4 + rng.random(2000) * 0.5 + 0.3, 0.01, 0.99)
        model = PlattCalibrator()
        model.fit(p, y)
        assert abs(model.transform(p).mean() - y.mean()) < abs(p.mean() - y.mean())

    def test_isotonic_is_monotone(self):
        rng = np.random.default_rng(2)
        y = (rng.random(1000) < 0.4).astype(int)
        p = np.clip(rng.random(1000), 0.01, 0.99)
        model = IsotonicCalibrator()
        model.fit(p, y)
        grid = np.linspace(0.05, 0.95, 20)
        out = model.transform(grid)
        assert all(a <= b + 1e-9 for a, b in zip(out, out[1:]))

    def test_single_class_calibration_degrades_to_identity(self):
        for calibrator in (PlattCalibrator(), IsotonicCalibrator()):
            calibrator.fit(np.array([0.3, 0.4]), np.array([1, 1]))
            assert np.allclose(calibrator.transform(np.array([0.5])), [0.5])

    def test_three_calibrators_offered(self):
        assert [c.name for c in calibrators()] == ["identity", "platt", "isotonic"]


def _dataset(n=1000, seed=3):
    rng = np.random.default_rng(seed)
    return Dataset(
        X=rng.normal(size=(n, 12)), y=(rng.random(n) < 0.4).astype(int),
        symbols=tuple(f"S{i%5}" for i in range(n)),
        decision_ts=tuple(i * DAY for i in range(n)),
        entry=np.full(n, 100_00), target=np.full(n, 110_00), stop=np.full(n, 95_00),
        forward_return=rng.normal(0.001, 0.05, n), outcome=("TARGET",) * n,
        feature_schema_hash="fh", label_spec_hash="lh", data_version="dv")


class TestDecisionMetrics:
    def test_a_flat_predictor_is_flagged_as_unable_to_rank(self):
        """Its top decile would be whatever argsort left first, which is an."""
        data = _dataset()
        flat = np.full(len(data), 0.37)
        assert top_quantile_outcome(data, flat, 0.1, 70.0).degenerate

    def test_a_spread_predictor_is_not_flagged(self):
        data = _dataset()
        rng = np.random.default_rng(4)
        assert not top_quantile_outcome(data, rng.random(len(data)), 0.1, 70.0).degenerate

    def test_costs_are_subtracted_from_gross(self):
        data = _dataset()
        rng = np.random.default_rng(5)
        outcome = top_quantile_outcome(data, rng.random(len(data)), 0.1, 70.0)
        assert outcome.net_bps == pytest.approx(outcome.gross_bps - 70.0)

    def test_t_statistic_is_reported(self):
        data = _dataset()
        rng = np.random.default_rng(6)
        assert not math.isnan(top_quantile_outcome(data, rng.random(len(data)), 0.1, 70.0).t_stat)

    def test_threshold_above_every_probability_takes_no_trade(self):
        data = _dataset()
        assert decision_outcome(data, np.full(len(data), 0.2), 0.9, 70.0).trades == 0

    def test_random_entry_is_reproducible(self):
        data = _dataset()
        assert random_entry(data, 0.25, 70.0).as_dict() == random_entry(data, 0.25, 70.0).as_dict()

    def test_random_entry_respects_its_rate(self):
        data = _dataset()
        outcome = random_entry(data, 0.25, 70.0)
        assert 0.20 * len(data) < outcome.trades < 0.30 * len(data)


class TestRegistry:
    def test_completed_and_failed_trials_both_recorded(self, tmp_path):
        registry = TrialRegistry(tmp_path / "trials.db")
        registry.record(TrialRecord("m", "platt", "completed", "dv", "fh", "lh"))
        registry.record(TrialRecord("m", "isotonic", "failed", "dv", "fh", "lh",
                                    failure="singular"))
        assert registry.trial_count() == 2
        assert registry.counts_by_status() == {"completed": 1, "failed": 1}

    def test_trial_id_is_deterministic(self):
        a = TrialRecord("m", "platt", "completed", "dv", "fh", "lh")
        b = TrialRecord("m", "platt", "completed", "dv", "fh", "lh")
        assert a.trial_id() == b.trial_id()

    def test_trial_id_changes_with_the_data_version(self):
        a = TrialRecord("m", "platt", "completed", "dv1", "fh", "lh")
        b = TrialRecord("m", "platt", "completed", "dv2", "fh", "lh")
        assert a.trial_id() != b.trial_id()

    def test_metadata_round_trips(self, tmp_path):
        registry = TrialRegistry(tmp_path / "trials.db")
        registry.record(TrialRecord(
            "m", "platt", "completed", "dv", "fh", "lh", train_start=1, train_end=2,
            purge_sessions=21, embargo_sessions=5, metrics={"log_loss": 0.65}))
        row = registry.trials()[0]
        assert row["purge_sessions"] == 21 and row["metrics"]["log_loss"] == 0.65

    def test_deflated_threshold_grows_with_trial_count(self):
        assert deflated_threshold(1) == 0.0
        assert deflated_threshold(1000) > deflated_threshold(10)
        assert deflated_threshold(1_000_000) == pytest.approx(math.sqrt(2 * math.log(1e6)))
