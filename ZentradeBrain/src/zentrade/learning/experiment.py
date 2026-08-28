"""The P6 experiment: prediction ladder, calibration, and the random-entry control."""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from ..costs import ProductType, SlippageModel, compute_costs
from ..kernel.side import Side
from ..features.schema import FEATURE_NAMES
from . import metrics as mx
from .calibration import calibrators
from .dataset import Dataset
from .models import ladder
from .registry import TrialRecord, TrialRegistry
from .splits import Split, SplitSpec, split_by_time

PARTICIPATION = 0.01
DECISION_THRESHOLD_GRID = (0.30, 0.35, 0.40, 0.45, 0.50)
SELECTION_QUANTILES = (0.05, 0.10, 0.25)


def round_trip_cost_bps(notional: int = 100_000_00) -> float:
    """Entry and exit charges plus slippage both ways, in basis points of."""
    slippage = SlippageModel()
    buy = compute_costs(notional, Side.BUY, ProductType.DELIVERY).total
    sell = compute_costs(notional, Side.SELL, ProductType.DELIVERY).total
    charges_bps = (buy + sell) / notional * 10_000
    return charges_bps + 2 * slippage.slippage_bps(PARTICIPATION)


@dataclass(frozen=True)
class DecisionOutcome:
    trades: int
    gross_bps: float
    net_bps: float
    total_net_return: float
    hit_rate: float
    t_stat: float = float("nan")
    degenerate: bool = False

    def as_dict(self) -> dict:
        return {"trades": self.trades, "gross_bps": round(self.gross_bps, 3),
                "net_bps": round(self.net_bps, 3),
                "total_net_return": round(self.total_net_return, 5),
                "hit_rate": round(self.hit_rate, 5),
                "t_stat": round(self.t_stat, 4) if self.t_stat == self.t_stat else None,
                "degenerate": self.degenerate}


def _t_stat(net_returns: np.ndarray) -> float:
    """A net return with no t-statistic beside it is a number, not evidence."""
    if len(net_returns) < 2:
        return float("nan")
    spread = float(np.std(net_returns, ddof=1))
    if spread <= 0:
        return float("nan")
    return float(np.mean(net_returns) / (spread / math.sqrt(len(net_returns))))


def decision_outcome(data: Dataset, probability: np.ndarray, threshold: float,
                     cost_bps: float) -> DecisionOutcome:
    taken = probability >= threshold
    count = int(taken.sum())
    if count == 0:
        return DecisionOutcome(0, 0.0, 0.0, 0.0, float("nan"))
    gross = data.forward_return[taken]
    net = gross - cost_bps / 10_000
    gross_bps = float(np.mean(gross) * 10_000)
    return DecisionOutcome(
        trades=count, gross_bps=gross_bps, net_bps=gross_bps - cost_bps,
        total_net_return=float(np.sum(net)), hit_rate=float(np.mean(data.y[taken])),
        t_stat=_t_stat(net),
    )


def top_quantile_outcome(data: Dataset, probability: np.ndarray, quantile: float,
                         cost_bps: float) -> DecisionOutcome:
    """Threshold-free: take the highest-ranked fraction. A calibrated model may."""
    count = max(1, int(len(probability) * quantile))
    order = np.argsort(-probability, kind="stable")[:count]

    cutoff = probability[order[-1]]
    tied = int(np.sum(probability == cutoff))
    degenerate = float(np.std(probability)) <= 1e-12 or tied > count

    gross = data.forward_return[order]
    net = gross - cost_bps / 10_000
    gross_bps = float(np.mean(gross) * 10_000)
    return DecisionOutcome(
        trades=count, gross_bps=gross_bps, net_bps=gross_bps - cost_bps,
        total_net_return=float(np.sum(net)), hit_rate=float(np.mean(data.y[order])),
        t_stat=_t_stat(net), degenerate=degenerate,
    )


def random_entry(data: Dataset, rate: float, cost_bps: float,
                 seed: int = 20260828) -> DecisionOutcome:
    """The control. Same population, same costs, same trade count, no signal."""
    rng = np.random.default_rng(seed)
    taken = rng.random(len(data)) < rate
    if not taken.any():
        return DecisionOutcome(0, 0.0, 0.0, 0.0, float("nan"))
    gross = data.forward_return[taken]
    net = gross - cost_bps / 10_000
    gross_bps = float(np.mean(gross) * 10_000)
    return DecisionOutcome(
        trades=int(taken.sum()), gross_bps=gross_bps, net_bps=gross_bps - cost_bps,
        total_net_return=float(np.sum(net)), hit_rate=float(np.mean(data.y[taken])),
        t_stat=_t_stat(net),
    )


def volatility_regimes(data: Dataset) -> np.ndarray:
    """A volatility proxy from the documented feature set, used only for."""
    vol = data.X[:, FEATURE_NAMES.index("realized_vol_20d")]
    low, high = np.quantile(vol, [1 / 3, 2 / 3])
    return np.where(vol <= low, "LOW_VOL", np.where(vol <= high, "MID_VOL", "HIGH_VOL"))


def run(data: Dataset, registry: TrialRegistry, spec: SplitSpec | None = None,
        log=print) -> dict:
    spec = spec or SplitSpec()
    split = split_by_time(list(data.decision_ts), spec)
    train = data.take(split.train)
    calibration = data.take(split.calibration)
    evaluation = data.take(split.evaluation)
    cost_bps = round_trip_cost_bps()

    log(f"  split  train {len(train):,}  calibration {len(calibration):,}  "
        f"evaluation {len(evaluation):,}  purged {split.purged:,}")
    log(f"  round-trip cost {cost_bps:.2f} bps")

    windows = {
        "train_start": min(train.decision_ts), "train_end": max(train.decision_ts),
        "calibration_start": min(calibration.decision_ts),
        "calibration_end": max(calibration.decision_ts),
        "evaluation_start": min(evaluation.decision_ts),
        "evaluation_end": max(evaluation.decision_ts),
    }
    common = dict(
        data_version=data.data_version,
        feature_schema_hash=data.feature_schema_hash,
        label_spec_hash=data.label_spec_hash,
        purge_sessions=spec.purge_sessions, embargo_sessions=spec.embargo_sessions,
        n_train=len(train), n_calibration=len(calibration),
        n_evaluation=len(evaluation), n_purged=split.purged, **windows)

    results: list[dict] = []
    for model in ladder():
        try:
            model.fit(train.X, train.y)
            raw_cal = model.predict_proba(calibration.X)
            raw_eval = model.predict_proba(evaluation.X)
        except Exception as exc:
            registry.record(TrialRecord(
                model_name=model.name, calibrator="-", status="failed",
                hyperparameters=_hyper(model), failure=f"{type(exc).__name__}: {exc}",
                **common))
            log(f"  {model.name}: FAILED {exc}")
            continue

        for calibrator in calibrators():
            try:
                calibrator.fit(raw_cal, calibration.y)
                probability = np.clip(calibrator.transform(raw_eval), 1e-6, 1 - 1e-6)
                card = mx.score(evaluation.y.tolist(), probability.tolist())
                decisions = {
                    f"{threshold:.2f}": decision_outcome(
                        evaluation, probability, threshold, cost_bps).as_dict()
                    for threshold in DECISION_THRESHOLD_GRID}
                selections = {
                    f"top{int(q * 100)}pct": top_quantile_outcome(
                        evaluation, probability, q, cost_bps).as_dict()
                    for q in SELECTION_QUANTILES}
                payload = {**card.as_dict(), "decisions": decisions,
                           "selections": selections, "cost_bps": round(cost_bps, 3)}
                registry.record(TrialRecord(
                    model_name=model.name, calibrator=calibrator.name,
                    status="completed", hyperparameters=_hyper(model),
                    metrics=payload, **common))
                results.append({"model": model.name, "calibrator": calibrator.name,
                                **payload})
            except Exception as exc:
                registry.record(TrialRecord(
                    model_name=model.name, calibrator=calibrator.name, status="failed",
                    hyperparameters=_hyper(model),
                    failure=f"{type(exc).__name__}: {exc}", **common))
                log(f"  {model.name}/{calibrator.name}: FAILED {exc}")

    return {"split": split, "results": results, "cost_bps": cost_bps,
            "train": train, "calibration": calibration, "evaluation": evaluation}


def _hyper(model) -> dict:
    out = {}
    for key in ("penalty", "C", "l1_ratio", "max_iter"):
        if hasattr(model, key):
            value = getattr(model, key)
            out[key] = value if value not in (float("inf"),) else "inf"
    return out
