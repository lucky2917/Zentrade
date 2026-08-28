"""Single-block ablation, run entirely inside the development window."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from ..features.blocks import (
    BASE_BLOCK_NAME, active_blocks, block_feature_names, schema_hash_for,
)
from . import metrics as mx
from .calibration import calibrators
from .dataset import Dataset
from .experiment import (
    SELECTION_QUANTILES, random_entry, round_trip_cost_bps, top_quantile_outcome,
)
from .models import ladder
from .protocol import DevelopmentProtocol
from .registry import TrialRecord, TrialRegistry
from .splits import Split, SplitSpec, split_by_time


def paired_log_loss_test(y: np.ndarray, p_without: np.ndarray,
                         p_with: np.ndarray,
                         cluster_by: np.ndarray | None = None) -> dict:
    """Per-sample log loss, same rows, same model, only the block differs."""
    eps = 1e-15
    def loss(p):
        clipped = np.clip(p, eps, 1 - eps)
        return -(y * np.log(clipped) + (1 - y) * np.log(1 - clipped))

    difference = loss(p_without) - loss(p_with)

    def t_of(values: np.ndarray) -> float:
        if len(values) < 2:
            return float("nan")
        spread = float(np.std(values, ddof=1))
        if spread <= 0:
            return float("nan")
        return float(np.mean(values) / (spread / np.sqrt(len(values))))

    unclustered = t_of(difference)
    result = {"mean_improvement": float(np.mean(difference)),
              "t_stat": unclustered, "t_unclustered": unclustered,
              "n": int(len(difference)), "clusters": None}

    if cluster_by is not None:
        keys = np.asarray(cluster_by)
        cluster_means = np.array([difference[keys == key].mean()
                                  for key in np.unique(keys)])
        result["t_stat"] = t_of(cluster_means)
        result["clusters"] = int(len(cluster_means))
    return result


@dataclass(frozen=True)
class ArmResult:
    arm: str
    blocks: tuple[str, ...]
    schema_hash: str
    rows: list[dict]
    probabilities: dict = None

    def best(self) -> dict:
        return min(self.rows, key=lambda r: r["log_loss"])


def development_split(data: Dataset, protocol: DevelopmentProtocol,
                      spec: SplitSpec) -> tuple[Dataset, Split]:
    """Development data only. The guard runs before anything is fitted, so a."""
    development = data.take(protocol.development_indices(data.decision_ts))
    protocol.assert_no_holdout(development.decision_ts)
    return development, split_by_time(list(development.decision_ts), spec)


def run_arm(arm: str, blocks: tuple[str, ...], development: Dataset, split: Split,
            registry: TrialRegistry, spec: SplitSpec, cost_bps: float) -> ArmResult:
    X = development.columns_for(blocks)
    train_idx, calib_idx, valid_idx = split.train, split.calibration, split.evaluation
    train = development.take(train_idx)
    calibration = development.take(calib_idx)
    validation = development.take(valid_idx)

    common = dict(
        data_version=f"{development.data_version}:{arm}",
        feature_schema_hash=schema_hash_for(blocks),
        label_spec_hash=development.label_spec_hash,
        purge_sessions=spec.purge_sessions, embargo_sessions=spec.embargo_sessions,
        n_train=len(train_idx), n_calibration=len(calib_idx),
        n_evaluation=len(valid_idx), n_purged=split.purged,
        train_start=min(train.decision_ts), train_end=max(train.decision_ts),
        calibration_start=min(calibration.decision_ts),
        calibration_end=max(calibration.decision_ts),
        evaluation_start=min(validation.decision_ts),
        evaluation_end=max(validation.decision_ts))

    rows: list[dict] = []
    probabilities: dict[tuple[str, str], np.ndarray] = {}
    for model in ladder():
        try:
            model.fit(X[list(train_idx)], development.y[list(train_idx)])
            raw_cal = model.predict_proba(X[list(calib_idx)])
            raw_val = model.predict_proba(X[list(valid_idx)])
        except Exception as exc:
            registry.record(TrialRecord(
                model_name=f"{arm}:{model.name}", calibrator="-", status="failed",
                failure=f"{type(exc).__name__}: {exc}", **common))
            continue

        for calibrator in calibrators():
            try:
                calibrator.fit(raw_cal, development.y[list(calib_idx)])
                probability = np.clip(calibrator.transform(raw_val), 1e-6, 1 - 1e-6)
                card = mx.score(validation.y.tolist(), probability.tolist())
                selections = {
                    f"top{int(q * 100)}pct": top_quantile_outcome(
                        validation, probability, q, cost_bps).as_dict()
                    for q in SELECTION_QUANTILES}
                payload = {**card.as_dict(), "selections": selections,
                           "cost_bps": round(cost_bps, 3), "arm": arm}
                registry.record(TrialRecord(
                    model_name=f"{arm}:{model.name}", calibrator=calibrator.name,
                    status="completed", metrics=payload, **common))
                rows.append({"model": model.name, "calibrator": calibrator.name, **payload})
                probabilities[(model.name, calibrator.name)] = probability
            except Exception as exc:
                registry.record(TrialRecord(
                    model_name=f"{arm}:{model.name}", calibrator=calibrator.name,
                    status="failed", failure=f"{type(exc).__name__}: {exc}", **common))
    return ArmResult(arm, blocks, schema_hash_for(blocks), rows, probabilities)


def ablate(data: Dataset, block: str, registry: TrialRegistry,
           protocol: DevelopmentProtocol | None = None,
           spec: SplitSpec | None = None, cluster_by_day: bool = False) -> dict:
    protocol = protocol or DevelopmentProtocol()
    spec = spec or SplitSpec(train_fraction=protocol.train_fraction,
                             calibration_fraction=protocol.calibration_fraction,
                             purge_sessions=protocol.purge_sessions,
                             embargo_sessions=protocol.embargo_sessions)
    development, split = development_split(data, protocol, spec)
    cost_bps = round_trip_cost_bps()

    control = active_blocks()
    treatment = control + (block,)
    without = run_arm("without_" + block, control, development, split,
                      registry, spec, cost_bps)
    with_block = run_arm("with_" + block, treatment, development, split,
                         registry, spec, cost_bps)
    validation = development.take(split.evaluation)

    clusters = (np.asarray(validation.decision_ts) if cluster_by_day else None)
    paired = {}
    for key, p_without in (without.probabilities or {}).items():
        p_with = (with_block.probabilities or {}).get(key)
        if p_with is not None:
            paired[key] = paired_log_loss_test(validation.y, p_without, p_with,
                                               cluster_by=clusters)

    return {"development": development, "split": split, "validation": validation,
            "control_blocks": control, "treatment_blocks": treatment,
            "without": without, "with_block": with_block, "cost_bps": cost_bps,
            "paired": paired,
            "controls": {rate: random_entry(validation, rate, cost_bps)
                         for rate in (0.10, 0.25, 1.00)}}
