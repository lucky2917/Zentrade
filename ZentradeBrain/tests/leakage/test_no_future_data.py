"""Leakage proofs for the canonical engine."""
from datetime import datetime, timedelta, timezone

import numpy as np
import pyarrow as pa
import pytest

from zentrade.adapters.data.pit import FutureDataRequested, InMemoryPitSource, SpinePitSource
from zentrade.features.engine import compute_features
from zentrade.features.schema import FEATURE_NAMES
from zentrade.spine.semantics import BAR_SCHEMA
from zentrade.spine.writer import write_bars

BASE = datetime(2024, 1, 1, tzinfo=timezone.utc)


def ts(offset_days: int) -> int:
    return int((BASE + timedelta(days=offset_days)).timestamp() * 1_000_000)


def synth(symbol: str, sessions: int, seed: int = 0, start: int = 0):
    rng = np.random.default_rng(seed)
    price = 100_00
    rows = []
    for index in range(sessions):
        price = max(100, int(price * (1 + rng.normal(0, 0.015))))
        high = int(price * 1.01)
        low = int(price * 0.99)
        rows.append({"symbol": symbol, "ts_utc": ts(start + index), "open": price,
                     "high": high, "low": low, "close": price,
                     "volume": int(rng.integers(10_000, 100_000))})
    return rows


class TestFutureInvariance:
    """The strongest point-in-time proof: what the engine computes at as_of must."""

    def test_features_identical_with_and_without_future_bars(self, tmp_path):
        history = synth("AAA", 300, seed=1)
        future = synth("AAA", 60, seed=2, start=300)

        past_only = InMemoryPitSource(pa.Table.from_pylist(history, schema=BAR_SCHEMA))
        with_future = InMemoryPitSource(
            pa.Table.from_pylist(history + future, schema=BAR_SCHEMA))

        as_of = ts(300)
        a = compute_features(past_only, as_of=as_of).rows[0]
        b = compute_features(with_future, as_of=as_of).rows[0]
        assert a.values == b.values, "future bars changed a past feature vector"

    def test_source_rejects_a_bar_at_or_after_as_of(self, tmp_path):
        write_bars(tmp_path, "NSE", "1d", synth("AAA", 10))
        source = SpinePitSource(tmp_path, adjust=False)
        table = source.bars_before(as_of=ts(5))
        assert max(table.column("ts_utc").to_pylist()) < ts(5)

    def test_boundary_is_strict_not_inclusive(self):
        rows = synth("AAA", 10)
        source = InMemoryPitSource(pa.Table.from_pylist(rows, schema=BAR_SCHEMA))
        table = source.bars_before(as_of=ts(5))
        stamps = table.column("ts_utc").to_pylist()
        assert ts(5) not in stamps, "as_of bar must be excluded"
        assert ts(4) in stamps


class TestShuffle:
    """Permuted labels must destroy predictability. A positive control proves."""

    def _dataset(self, seed: int):
        from sklearn.linear_model import LogisticRegression
        from sklearn.metrics import roc_auc_score

        rows = synth("AAA", 500, seed=seed)
        source = InMemoryPitSource(pa.Table.from_pylist(rows, schema=BAR_SCHEMA))
        closes = {r["ts_utc"]: r["close"] for r in rows}
        stamps = sorted(closes)

        features, forward = [], []
        for index in range(300, len(stamps) - 1):
            as_of = stamps[index]
            row = compute_features(source, as_of=as_of).rows[0]
            if not row.complete:
                continue
            features.append(list(row.values))
            forward.append(1 if closes[stamps[index]] > closes[stamps[index - 1]] else 0)
        return np.array(features), np.array(forward), LogisticRegression, roc_auc_score

    def test_shuffled_labels_give_no_edge(self):
        X, y, LogisticRegression, roc_auc_score = self._dataset(seed=7)
        assert len(X) > 100, "not enough samples to make the test meaningful"
        rng = np.random.default_rng(0)
        shuffled = rng.permutation(y)
        model = LogisticRegression(max_iter=2000).fit(X, shuffled)
        auc = roc_auc_score(shuffled, model.predict_proba(X)[:, 1])
        assert auc < 0.72, f"shuffled labels still predictable, AUC {auc:.3f}"

    def test_positive_control_detects_injected_leakage(self):
        """Feed the label in as a feature; the test must light up. Without this,."""
        X, y, LogisticRegression, roc_auc_score = self._dataset(seed=7)
        leaked = np.column_stack([X, y])
        model = LogisticRegression(max_iter=2000).fit(leaked, y)
        auc = roc_auc_score(y, model.predict_proba(leaked)[:, 1])
        assert auc > 0.95, f"positive control failed to detect leakage, AUC {auc:.3f}"


class TestInsufficientHistory:
    def test_short_history_yields_none_not_a_guess(self):
        rows = synth("AAA", 5)
        source = InMemoryPitSource(pa.Table.from_pylist(rows, schema=BAR_SCHEMA))
        row = compute_features(source, as_of=ts(5)).rows[0]
        values = row.as_dict()
        assert values["return_21d"] is None
        assert values["dist_from_252d_high"] is None
        assert not row.complete

    def test_no_bars_yields_no_rows(self):
        source = InMemoryPitSource(BAR_SCHEMA.empty_table())
        assert len(compute_features(source, as_of=ts(1))) == 0
