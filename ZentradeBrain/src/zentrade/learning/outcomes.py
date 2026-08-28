"""The frozen labeling law. Pure functions over a forward price path."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

LABEL_SEMANTICS = "outcome_v1"


class Outcome(str, Enum):
    TARGET = "TARGET"
    STOP = "STOP"
    NEITHER = "NEITHER"
    PENDING = "PENDING"


@dataclass(frozen=True)
class Bar:
    ts_utc: int
    open: int
    high: int
    low: int
    close: int


@dataclass(frozen=True)
class PathResult:
    outcome: Outcome
    resolved_ts: int | None
    sessions_to_resolve: int | None
    exit_price: int | None
    max_favourable: int | None
    max_adverse: int | None


def _excursions(path: list[Bar], entry: int, upto: int) -> tuple[int, int]:
    window = path[:upto]
    if not window:
        return 0, 0
    return max(b.high for b in window) - entry, min(b.low for b in window) - entry


def label_path(path: list[Bar], *, entry: int, target: int, stop: int,
               horizon_sessions: int) -> PathResult:
    """Scan sessions strictly after the decision session."""
    if horizon_sessions <= 0:
        raise ValueError("horizon_sessions must be positive")

    for index, bar in enumerate(path[:horizon_sessions], start=1):
        favourable, adverse = _excursions(path, entry, index)

        if bar.open >= target and bar.open <= stop:
            return PathResult(Outcome.STOP, bar.ts_utc, index, bar.open, favourable, adverse)
        if bar.open >= target:
            return PathResult(Outcome.TARGET, bar.ts_utc, index, bar.open, favourable, adverse)
        if bar.open <= stop:
            return PathResult(Outcome.STOP, bar.ts_utc, index, bar.open, favourable, adverse)

        hit_target = bar.high >= target
        hit_stop = bar.low <= stop
        if hit_target and hit_stop:
            return PathResult(Outcome.STOP, bar.ts_utc, index, stop, favourable, adverse)
        if hit_target:
            return PathResult(Outcome.TARGET, bar.ts_utc, index, target, favourable, adverse)
        if hit_stop:
            return PathResult(Outcome.STOP, bar.ts_utc, index, stop, favourable, adverse)

    if len(path) < horizon_sessions:
        return PathResult(Outcome.PENDING, None, None, None, None, None)

    final = path[horizon_sessions - 1]
    favourable, adverse = _excursions(path, entry, horizon_sessions)
    return PathResult(Outcome.NEITHER, final.ts_utc, horizon_sessions, final.close,
                      favourable, adverse)


def is_final(outcome: Outcome) -> bool:
    return outcome is not Outcome.PENDING


def forward_return(entry: int, exit_price: int | None) -> float | None:
    if exit_price is None or entry <= 0:
        return None
    return exit_price / entry - 1.0
