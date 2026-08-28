"""Calibration fitted on a population disjoint from both training and evaluation."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np


@dataclass
class IdentityCalibrator:
    name: str = "identity"

    def fit(self, p: np.ndarray, y: np.ndarray) -> None:
        return None

    def transform(self, p: np.ndarray) -> np.ndarray:
        return p


@dataclass
class PlattCalibrator:
    """A logistic fitted on the score, not on the features. Calibrating the."""

    name: str = "platt"
    model: object | None = None

    def fit(self, p: np.ndarray, y: np.ndarray) -> None:
        from sklearn.linear_model import LogisticRegression

        if len(np.unique(y)) < 2:
            self.model = None
            return
        self.model = LogisticRegression(max_iter=1000)
        self.model.fit(_logit(p).reshape(-1, 1), y)

    def transform(self, p: np.ndarray) -> np.ndarray:
        if self.model is None:
            return p
        return self.model.predict_proba(_logit(p).reshape(-1, 1))[:, 1]


@dataclass
class IsotonicCalibrator:
    name: str = "isotonic"
    model: object | None = None

    def fit(self, p: np.ndarray, y: np.ndarray) -> None:
        from sklearn.isotonic import IsotonicRegression

        if len(np.unique(y)) < 2:
            self.model = None
            return
        self.model = IsotonicRegression(out_of_bounds="clip", y_min=0.0, y_max=1.0)
        self.model.fit(p, y)

    def transform(self, p: np.ndarray) -> np.ndarray:
        if self.model is None:
            return p
        return np.clip(self.model.predict(p), 1e-6, 1 - 1e-6)


def _logit(p: np.ndarray) -> np.ndarray:
    clipped = np.clip(p, 1e-6, 1 - 1e-6)
    return np.log(clipped / (1 - clipped))


def calibrators() -> list:
    return [IdentityCalibrator(), PlattCalibrator(), IsotonicCalibrator()]
