"""Time-aware splits with purge and embargo."""

from __future__ import annotations

from dataclasses import dataclass

SESSION_MICROS = 24 * 60 * 60 * 1_000_000


@dataclass(frozen=True)
class SplitSpec:
    train_fraction: float = 0.55
    calibration_fraction: float = 0.20
    purge_sessions: int = 21
    embargo_sessions: int = 5

    def __post_init__(self) -> None:
        if not 0 < self.train_fraction < 1:
            raise ValueError("train_fraction must be in (0, 1)")
        if self.train_fraction + self.calibration_fraction >= 1.0:
            raise ValueError("no evaluation data would remain")
        if self.purge_sessions < 0 or self.embargo_sessions < 0:
            raise ValueError("purge and embargo must be non-negative")


@dataclass(frozen=True)
class Split:
    train: tuple[int, ...]
    calibration: tuple[int, ...]
    evaluation: tuple[int, ...]
    purged: int
    boundaries: tuple[int, int]

    def sizes(self) -> dict[str, int]:
        return {"train": len(self.train), "calibration": len(self.calibration),
                "evaluation": len(self.evaluation), "purged": self.purged}


def split_by_time(decision_ts: list[int], spec: SplitSpec | None = None) -> Split:
    """Chronological split with the label horizon purged from each boundary."""
    spec = spec or SplitSpec()
    sessions = sorted(set(decision_ts))
    if len(sessions) < 10:
        raise ValueError(f"too few sessions to split: {len(sessions)}")

    train_end = sessions[int(len(sessions) * spec.train_fraction)]
    calibration_end = sessions[
        min(len(sessions) - 1,
            int(len(sessions) * (spec.train_fraction + spec.calibration_fraction)))]

    gap = (spec.purge_sessions + spec.embargo_sessions) * SESSION_MICROS
    train, calibration, evaluation, purged = [], [], [], 0

    for index, stamp in enumerate(decision_ts):
        if stamp <= train_end - gap:
            train.append(index)
        elif stamp <= train_end:
            purged += 1
        elif stamp <= calibration_end - gap:
            calibration.append(index)
        elif stamp <= calibration_end:
            purged += 1
        else:
            evaluation.append(index)

    return Split(tuple(train), tuple(calibration), tuple(evaluation), purged,
                 (train_end, calibration_end))
