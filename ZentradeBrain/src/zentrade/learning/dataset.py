"""Build the modelling dataset from the canonical engine and the shadow labels."""

from __future__ import annotations

import hashlib
import json
import time
from dataclasses import dataclass
from datetime import date, datetime, timezone
from pathlib import Path

import numpy as np
import polars as pl

from ..adapters.data.pit import PitDataSource
from ..features.blocks import (
    BASE_BLOCK_NAME, MTF_ALIGNMENT_NAME, RELATIVE_STRENGTH_FEATURES,
    RELATIVE_STRENGTH_NAME, block_feature_names, multi_timeframe_alignment,
    relative_strength, schema_hash_for,
)
from ..features.engine import compute_features
from ..features.schema import FEATURE_NAMES, schema_hash
from .labeler import LabelSpec, label_population
from .outcomes import Outcome

TARGET_OUTCOME = Outcome.TARGET.value


@dataclass(frozen=True)
class Dataset:
    X: np.ndarray
    y: np.ndarray
    symbols: tuple[str, ...]
    decision_ts: tuple[int, ...]
    entry: np.ndarray
    target: np.ndarray
    stop: np.ndarray
    forward_return: np.ndarray
    outcome: tuple[str, ...]
    feature_schema_hash: str
    label_spec_hash: str
    data_version: str
    feature_names: tuple[str, ...] = FEATURE_NAMES
    blocks: tuple[str, ...] = (BASE_BLOCK_NAME,)

    def columns_for(self, blocks: tuple[str, ...]) -> np.ndarray:
        """Ablation is a column selection, so the shared features are bit."""
        wanted = block_feature_names(blocks)
        index = [self.feature_names.index(name) for name in wanted]
        return self.X[:, index]

    def __len__(self) -> int:
        return len(self.y)

    def take(self, index) -> Dataset:
        idx = list(index)
        return Dataset(
            X=self.X[idx], y=self.y[idx],
            symbols=tuple(self.symbols[i] for i in idx),
            decision_ts=tuple(self.decision_ts[i] for i in idx),
            entry=self.entry[idx], target=self.target[idx], stop=self.stop[idx],
            forward_return=self.forward_return[idx],
            outcome=tuple(self.outcome[i] for i in idx),
            feature_schema_hash=self.feature_schema_hash,
            label_spec_hash=self.label_spec_hash, data_version=self.data_version,
            feature_names=self.feature_names, blocks=self.blocks,
        )


def _ts(day: date) -> int:
    return int(datetime(day.year, day.month, day.day, tzinfo=timezone.utc).timestamp() * 1_000_000)


def build(source: PitDataSource, symbols: list[str], as_of: date,
          spec: LabelSpec | None = None, log=print,
          blocks: tuple[str, ...] = (BASE_BLOCK_NAME,)) -> Dataset:
    """Features at a decision session are computed with as_of one microsecond."""
    spec = spec or LabelSpec()
    labels = label_population(source, as_of=_ts(as_of), spec=spec, symbols=symbols)
    final = [label for label in labels.final()]
    log(f"  labels: {len(labels):,} total, {len(final):,} final")

    by_session: dict[int, list] = {}
    for label in final:
        by_session.setdefault(label.decision_ts, []).append(label)

    rows_X, rows_y, syms, stamps = [], [], [], []
    entry, target, stop, forward, outcomes = [], [], [], [], []
    started = time.perf_counter()

    for index, session in enumerate(sorted(by_session)):
        session_labels = {label.symbol: label for label in by_session[session]}
        snapshot = compute_features(source, as_of=session + 1,
                                    symbols=sorted(session_labels))
        extra = (relative_strength(snapshot)
                 if RELATIVE_STRENGTH_NAME in blocks else {})
        for row in snapshot.rows:
            if not row.complete:
                continue
            label = session_labels.get(row.symbol)
            if label is None:
                continue
            values = row.values
            if RELATIVE_STRENGTH_NAME in blocks:
                addition = extra.get(row.symbol)
                if addition is None or any(v is None for v in addition):
                    continue
                values = values + tuple(addition)
            if MTF_ALIGNMENT_NAME in blocks:
                addition = multi_timeframe_alignment(row.values)
                if any(v is None for v in addition):
                    continue
                values = values + tuple(addition)
            rows_X.append(values)
            rows_y.append(1 if label.outcome == TARGET_OUTCOME else 0)
            syms.append(row.symbol)
            stamps.append(session)
            entry.append(label.entry)
            target.append(label.target)
            stop.append(label.stop)
            forward.append(label.forward_return)
            outcomes.append(label.outcome)
        if index % 200 == 0 and index:
            log(f"    {index}/{len(by_session)} sessions, {len(rows_y):,} rows, "
                f"{time.perf_counter() - started:.0f}s")

    X = np.asarray(rows_X, dtype=float)
    y = np.asarray(rows_y, dtype=int)
    version = hashlib.sha256(json.dumps({
        "symbols": sorted(symbols), "as_of": as_of.isoformat(),
        "rows": len(y), "schema": schema_hash_for(blocks), "label": spec.spec_hash(),
        "blocks": list(blocks),
    }, sort_keys=True).encode()).hexdigest()[:16]

    return Dataset(
        X=X, y=y, symbols=tuple(syms), decision_ts=tuple(stamps),
        entry=np.asarray(entry), target=np.asarray(target), stop=np.asarray(stop),
        forward_return=np.asarray(forward, dtype=float), outcome=tuple(outcomes),
        feature_schema_hash=schema_hash_for(blocks), label_spec_hash=spec.spec_hash(),
        data_version=version, feature_names=block_feature_names(blocks), blocks=blocks,
    )


def save(dataset: Dataset, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    frame = pl.DataFrame({
        "symbol": list(dataset.symbols), "decision_ts": list(dataset.decision_ts),
        "y": dataset.y.tolist(), "entry": dataset.entry.tolist(),
        "target": dataset.target.tolist(), "stop": dataset.stop.tolist(),
        "forward_return": dataset.forward_return.tolist(),
        "outcome": list(dataset.outcome),
        **{name: dataset.X[:, i].tolist()
           for i, name in enumerate(dataset.feature_names)},
    })
    frame.write_parquet(path)
    path.with_suffix(".json").write_text(json.dumps({
        "feature_schema_hash": dataset.feature_schema_hash,
        "label_spec_hash": dataset.label_spec_hash,
        "data_version": dataset.data_version, "rows": len(dataset),
        "feature_names": list(dataset.feature_names), "blocks": list(dataset.blocks),
    }, indent=2))


def load(path: Path) -> Dataset:
    frame = pl.read_parquet(path)
    meta = json.loads(path.with_suffix(".json").read_text())
    names = tuple(meta.get("feature_names", FEATURE_NAMES))
    return Dataset(
        X=np.column_stack([frame[name].to_numpy() for name in names]),
        y=frame["y"].to_numpy(), symbols=tuple(frame["symbol"].to_list()),
        decision_ts=tuple(frame["decision_ts"].to_list()),
        entry=frame["entry"].to_numpy(), target=frame["target"].to_numpy(),
        stop=frame["stop"].to_numpy(),
        forward_return=frame["forward_return"].to_numpy(),
        outcome=tuple(frame["outcome"].to_list()),
        feature_schema_hash=meta["feature_schema_hash"],
        label_spec_hash=meta["label_spec_hash"], data_version=meta["data_version"],
        feature_names=names, blocks=tuple(meta.get("blocks", (BASE_BLOCK_NAME,))),
    )
