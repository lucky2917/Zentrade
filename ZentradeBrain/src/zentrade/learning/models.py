"""The prediction ladder. Each rung must beat the one below it or it does not ship."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol

import numpy as np

from ..features.schema import FEATURE_NAMES

RULE_MOMENTUM = FEATURE_NAMES.index("return_21d")
RULE_TREND = FEATURE_NAMES.index("sma20_ratio")


class Predictor(Protocol):
    name: str

    def fit(self, X: np.ndarray, y: np.ndarray) -> None: ...
    def predict_proba(self, X: np.ndarray) -> np.ndarray: ...


@dataclass
class ConstantNull:
    """Rung 0. Predicts the training base rate for everything. Any model that."""

    name: str = "constant_null"
    rate: float = 0.5

    def fit(self, X: np.ndarray, y: np.ndarray) -> None:
        self.rate = float(np.mean(y)) if len(y) else 0.5

    def predict_proba(self, X: np.ndarray) -> np.ndarray:
        return np.full(len(X), self.rate)


@dataclass
class RuleBaseline:
    """Rung 1. One documented rule, nothing fitted except the two rates it."""

    name: str = "rule_momentum_trend"
    rate_on: float = 0.5
    rate_off: float = 0.5

    def _signal(self, X: np.ndarray) -> np.ndarray:
        return (X[:, RULE_MOMENTUM] > 0) & (X[:, RULE_TREND] > 0)

    def fit(self, X: np.ndarray, y: np.ndarray) -> None:
        signal = self._signal(X)
        self.rate_on = float(np.mean(y[signal])) if signal.any() else float(np.mean(y))
        self.rate_off = float(np.mean(y[~signal])) if (~signal).any() else float(np.mean(y))

    def predict_proba(self, X: np.ndarray) -> np.ndarray:
        return np.where(self._signal(X), self.rate_on, self.rate_off)


@dataclass
class StandardScaler:
    mean: np.ndarray | None = None
    scale: np.ndarray | None = None

    def fit(self, X: np.ndarray) -> None:
        self.mean = X.mean(axis=0)
        spread = X.std(axis=0)
        self.scale = np.where(spread > 1e-12, spread, 1.0)

    def transform(self, X: np.ndarray) -> np.ndarray:
        return (X - self.mean) / self.scale


@dataclass
class LogisticModel:
    """Rung 2 unpenalised, rung 3 with elastic net. Features are standardised."""

    name: str = "logistic"
    penalty: str | None = None
    C: float = 1.0
    l1_ratio: float | None = None
    max_iter: int = 2000
    scaler: StandardScaler = field(default_factory=StandardScaler)
    model: object | None = None

    def fit(self, X: np.ndarray, y: np.ndarray) -> None:
        from sklearn.linear_model import LogisticRegression

        self.scaler.fit(X)
        if self.penalty == "elasticnet":
            kwargs = {"max_iter": self.max_iter, "solver": "saga",
                      "C": self.C, "l1_ratio": self.l1_ratio}
        elif self.penalty == "l2":
            kwargs = {"max_iter": self.max_iter, "solver": "lbfgs",
                      "C": self.C, "l1_ratio": 0.0}
        else:
            kwargs = {"max_iter": self.max_iter, "solver": "lbfgs", "C": np.inf}
        self.model = LogisticRegression(**kwargs)
        self.model.fit(self.scaler.transform(X), y)

    def predict_proba(self, X: np.ndarray) -> np.ndarray:
        return self.model.predict_proba(self.scaler.transform(X))[:, 1]

    def coefficients(self) -> dict[str, float]:
        if self.model is None:
            return {}
        return {name: float(value) for name, value
                in zip(FEATURE_NAMES, self.model.coef_[0])}


def ladder() -> list[Predictor]:
    """Dependency order. Rung n is only interesting if it beats rung n-1."""
    return [
        ConstantNull(),
        RuleBaseline(),
        LogisticModel(name="logistic_unpenalised", penalty=None),
        LogisticModel(name="logistic_elasticnet", penalty="elasticnet",
                      C=0.1, l1_ratio=0.5),
    ]
