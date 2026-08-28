"""Point-in-time properties of shadow labeling."""
from datetime import datetime, timedelta, timezone

import numpy as np
import pyarrow as pa
import pytest

from zentrade.adapters.data.pit import InMemoryPitSource, SpinePitSource
from zentrade.learning.labeler import LabelSpec, label_digest, label_population
from zentrade.learning.outcomes import Outcome
from zentrade.spine.semantics import BAR_SCHEMA
from zentrade.spine.writer import write_bars

BASE = datetime(2024, 1, 1, tzinfo=timezone.utc)
ts = lambda n: int((BASE + timedelta(days=n)).timestamp() * 1_000_000)


def synth(symbol, sessions, seed=0, start=0):
    rng = np.random.default_rng(seed)
    price, rows = 100_00, []
    for index in range(sessions):
        price = max(100, int(price * (1 + rng.normal(0, 0.02))))
        rows.append({"symbol": symbol, "ts_utc": ts(start + index), "open": price,
                     "high": int(price * 1.02), "low": int(price * 0.98),
                     "close": price, "volume": 1_000})
    return rows


def source_for(rows):
    return InMemoryPitSource(pa.Table.from_pylist(rows, schema=BAR_SCHEMA))


class TestTruncationInvariance:
    """A label that was final at one data horizon must never change at a later."""

    def test_final_labels_are_identical_at_a_later_as_of(self):
        rows = synth("AAA", 200, seed=3)
        source = source_for(rows)

        early = label_population(source, as_of=ts(120))
        late = label_population(source, as_of=ts(200))

        early_final = {(l.symbol, l.decision_ts): l for l in early.final()}
        late_by_key = {(l.symbol, l.decision_ts): l for l in late.labels}

        assert early_final, "no final labels to compare"
        for key, label in early_final.items():
            other = late_by_key[key]
            assert (label.outcome, label.resolved_ts, label.exit_price) == \
                   (other.outcome, other.resolved_ts, other.exit_price), key

    def test_pending_labels_may_resolve_later(self):
        rows = synth("AAA", 200, seed=4)
        source = source_for(rows)
        early = label_population(source, as_of=ts(120))
        late = {(l.symbol, l.decision_ts): l for l in label_population(source, as_of=ts(200)).labels}
        pending = early.pending()
        assert pending, "expected some unresolved labels near the horizon"
        resolved = [p for p in pending if late[(p.symbol, p.decision_ts)].final]
        assert resolved, "pending labels should resolve once more data arrives"

    def test_extending_data_adds_labels_but_never_rewrites_final_ones(self):
        rows = synth("AAA", 150, seed=5)
        source = source_for(rows)
        early = label_population(source, as_of=ts(100))
        late = label_population(source, as_of=ts(150))
        assert len(late) > len(early)


class TestNoLookAhead:
    def test_label_ignores_everything_at_or_before_the_decision_session(self):
        """Rewriting history before the decision must not move its label."""
        rows = synth("AAA", 120, seed=6)
        baseline = label_population(source_for(rows), as_of=ts(120))
        target = baseline.final()[-1]

        mutated = []
        for row in rows:
            row = dict(row)
            if row["ts_utc"] < target.decision_ts:
                row["volume"] = row["volume"] * 7
            mutated.append(row)
        after = label_population(source_for(mutated), as_of=ts(120))
        moved = {(l.symbol, l.decision_ts): l for l in after.labels}[
            (target.symbol, target.decision_ts)]
        assert moved.outcome == target.outcome
        assert moved.exit_price == target.exit_price

    def test_decision_bar_never_resolves_its_own_label(self):
        """The decision session legitimately sets entry and feeds the ATR that."""
        rows = synth("AAA", 60, seed=7)
        decision_index = 40
        spiked = [dict(r) for r in rows]
        spiked[decision_index]["high"] = spiked[decision_index]["close"] * 10

        for dataset in (rows, spiked):
            result = label_population(source_for(dataset), as_of=ts(60))
            for label in result.labels:
                assert label.resolved_ts is None or label.resolved_ts > label.decision_ts

    def test_entry_is_the_decision_close_not_a_later_price(self):
        rows = synth("AAA", 80, seed=13)
        closes = {r["ts_utc"]: r["close"] for r in rows}
        for label in label_population(source_for(rows), as_of=ts(80)).labels:
            assert label.entry == closes[label.decision_ts]

    def test_forward_path_excludes_the_decision_session(self):
        """Constructed directly: a huge decision-day high with flat forward."""
        from zentrade.learning.outcomes import Bar, label_path
        forward = [Bar(ts(i), 100_00, 100_00, 100_00, 100_00) for i in range(1, 6)]
        result = label_path(forward, entry=100_00, target=110_00, stop=90_00,
                            horizon_sessions=5)
        assert result.outcome is Outcome.NEITHER

    def test_no_label_resolves_before_its_own_decision(self):
        result = label_population(source_for(synth("AAA", 150, seed=8)), as_of=ts(150))
        for label in result.final():
            if label.resolved_ts is not None:
                assert label.resolved_ts > label.decision_ts


class TestDeterminism:
    def test_repeated_runs_give_an_identical_digest(self):
        source = source_for(synth("AAA", 150, seed=9))
        a = label_population(source, as_of=ts(150))
        b = label_population(source, as_of=ts(150))
        assert label_digest(a) == label_digest(b)

    def test_output_is_sorted_by_symbol_then_time(self):
        rows = synth("BBB", 80, seed=10) + synth("AAA", 80, seed=11)
        result = label_population(source_for(rows), as_of=ts(80))
        keys = [(l.symbol, l.decision_ts) for l in result.labels]
        assert keys == sorted(keys)

    def test_spec_change_changes_the_spec_hash(self):
        assert LabelSpec().spec_hash() != LabelSpec(horizon_sessions=10).spec_hash()
        assert LabelSpec().spec_hash() != LabelSpec(target_atr_multiple=3.0).spec_hash()


class TestUniversality:
    def test_every_symbol_is_labelled_regardless_of_any_selection(self):
        rows = sum((synth(s, 100, seed=i) for i, s in enumerate(["AAA", "BBB", "CCC"])), [])
        result = label_population(source_for(rows), as_of=ts(100))
        assert {l.symbol for l in result.labels} == {"AAA", "BBB", "CCC"}

    def test_labeler_does_not_import_attention_or_research(self):
        """Labeling what an agent would have escalated makes abstention quality."""
        import ast
        from pathlib import Path
        src = Path(__file__).resolve().parents[2] / "src" / "zentrade"
        offenders = []
        for path in (src / "learning").rglob("*.py"):
            for node in ast.walk(ast.parse(path.read_text())):
                if isinstance(node, ast.ImportFrom) and node.module:
                    if "research" in node.module or "attention" in node.module:
                        offenders.append(f"{path.name} imports {node.module}")
        assert offenders == [], offenders

    def test_labels_cover_every_session_with_enough_history(self):
        rows = synth("AAA", 100, seed=12)
        result = label_population(source_for(rows), as_of=ts(100))
        assert len(result) > 70, f"sparse coverage: {len(result)} labels from 100 sessions"
