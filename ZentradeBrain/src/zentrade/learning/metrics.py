"""Scoring. AUC is reported but never the basis for promotion."""

from __future__ import annotations

import math
from dataclasses import dataclass

EPSILON = 1e-15


def _clip(p: float) -> float:
    return min(1.0 - EPSILON, max(EPSILON, p))


def log_loss(y: list[int], p: list[float]) -> float:
    if not y:
        return float("nan")
    total = sum(-math.log(_clip(pi)) if yi else -math.log(1.0 - _clip(pi))
                for yi, pi in zip(y, p))
    return total / len(y)


def brier(y: list[int], p: list[float]) -> float:
    if not y:
        return float("nan")
    return sum((pi - yi) ** 2 for yi, pi in zip(y, p)) / len(y)


def base_rate(y: list[int]) -> float:
    return sum(y) / len(y) if y else float("nan")


def auc(y: list[int], p: list[float]) -> float:
    positives = [pi for yi, pi in zip(y, p) if yi]
    negatives = [pi for yi, pi in zip(y, p) if not yi]
    if not positives or not negatives:
        return float("nan")
    ordered = sorted(zip(p, y))
    ranks: dict[int, float] = {}
    index = 0
    rank_sum_positive = 0.0
    while index < len(ordered):
        stop = index
        while stop + 1 < len(ordered) and ordered[stop + 1][0] == ordered[index][0]:
            stop += 1
        average_rank = (index + stop) / 2.0 + 1.0
        for position in range(index, stop + 1):
            if ordered[position][1]:
                rank_sum_positive += average_rank
        index = stop + 1
    n_pos, n_neg = len(positives), len(negatives)
    return (rank_sum_positive - n_pos * (n_pos + 1) / 2.0) / (n_pos * n_neg)


@dataclass(frozen=True)
class ReliabilityBin:
    lower: float
    upper: float
    count: int
    mean_predicted: float
    observed: float


def reliability(y: list[int], p: list[float], bins: int = 10) -> list[ReliabilityBin]:
    edges = [i / bins for i in range(bins + 1)]
    out = []
    for index in range(bins):
        lower, upper = edges[index], edges[index + 1]
        members = [(yi, pi) for yi, pi in zip(y, p)
                   if (pi >= lower and pi < upper) or (index == bins - 1 and pi == upper)]
        if not members:
            out.append(ReliabilityBin(lower, upper, 0, float("nan"), float("nan")))
            continue
        out.append(ReliabilityBin(
            lower, upper, len(members),
            sum(m[1] for m in members) / len(members),
            sum(m[0] for m in members) / len(members)))
    return out


def expected_calibration_error(y: list[int], p: list[float], bins: int = 10) -> float:
    """Sample-weighted mean gap between predicted and observed frequency."""
    if not y:
        return float("nan")
    total = 0.0
    for cell in reliability(y, p, bins):
        if cell.count:
            total += cell.count * abs(cell.mean_predicted - cell.observed)
    return total / len(y)


@dataclass(frozen=True)
class ScoreCard:
    n: int
    base_rate: float
    log_loss: float
    brier: float
    ece: float
    auc: float

    def as_dict(self) -> dict:
        return {"n": self.n, "base_rate": round(self.base_rate, 6),
                "log_loss": round(self.log_loss, 6), "brier": round(self.brier, 6),
                "ece": round(self.ece, 6), "auc": round(self.auc, 6)}


def score(y: list[int], p: list[float]) -> ScoreCard:
    return ScoreCard(len(y), base_rate(y), log_loss(y, p), brier(y, p),
                     expected_calibration_error(y, p), auc(y, p))
