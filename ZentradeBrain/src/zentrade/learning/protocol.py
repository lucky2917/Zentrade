"""Development protocol. The P6 evaluation window is a frozen holdout."""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import date, datetime, timezone
from pathlib import Path

PROTOCOL_VERSION = "protocol_v1"

HOLDOUT_START = date(2025, 8, 5)
HOLDOUT_END = date(2026, 8, 25)

DEV_START = date(2022, 6, 3)
DEV_END = date(2025, 7, 9)


class HoldoutViolation(RuntimeError):
    """Raised when development code reaches into the frozen evaluation window."""


def _ts(day: date) -> int:
    return int(datetime(day.year, day.month, day.day, tzinfo=timezone.utc).timestamp() * 1_000_000)


HOLDOUT_START_TS = _ts(HOLDOUT_START)
HOLDOUT_END_TS = _ts(HOLDOUT_END) + 24 * 60 * 60 * 1_000_000


@dataclass(frozen=True)
class Population:
    name: str
    start_ts: int
    end_ts: int

    def contains(self, stamp: int) -> bool:
        return self.start_ts <= stamp < self.end_ts


@dataclass(frozen=True)
class DevelopmentProtocol:
    """Every decision about a feature is made inside DEVELOPMENT."""

    train_fraction: float = 0.60
    calibration_fraction: float = 0.20
    purge_sessions: int = 21
    embargo_sessions: int = 5

    def is_holdout(self, stamp: int) -> bool:
        return HOLDOUT_START_TS <= stamp < HOLDOUT_END_TS

    def assert_no_holdout(self, stamps) -> None:
        leaked = [s for s in stamps if self.is_holdout(s)]
        if leaked:
            first = datetime.fromtimestamp(min(leaked) / 1e6, tz=timezone.utc).date()
            raise HoldoutViolation(
                f"{len(leaked)} rows fall inside the frozen holdout "
                f"({HOLDOUT_START} .. {HOLDOUT_END}), earliest {first}. "
                "Development must not see this window."
            )

    def development_indices(self, stamps) -> tuple[int, ...]:
        return tuple(i for i, s in enumerate(stamps) if not self.is_holdout(s))

    def holdout_indices(self, stamps) -> tuple[int, ...]:
        return tuple(i for i, s in enumerate(stamps) if self.is_holdout(s))


@dataclass
class HoldoutLedger:
    """Every look at the holdout is written down. A holdout you have consulted."""

    path: Path

    def looks(self) -> list[dict]:
        if not self.path.exists():
            return []
        return [json.loads(line) for line in
                self.path.read_text().splitlines() if line.strip()]

    def record_look(self, reason: str, model: str, trial_id: str, at: str) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        entry = {"at": at, "reason": reason, "model": model, "trial_id": trial_id}
        with self.path.open("a") as handle:
            handle.write(json.dumps(entry, sort_keys=True) + "\n")

    def count(self) -> int:
        return len(self.looks())


def describe() -> dict:
    return {
        "protocol": PROTOCOL_VERSION,
        "development": {"start": DEV_START.isoformat(), "end": DEV_END.isoformat()},
        "frozen_holdout": {"start": HOLDOUT_START.isoformat(),
                           "end": HOLDOUT_END.isoformat()},
        "rule": ("features, thresholds and models are selected inside development only; "
                 "the holdout answers one question once, at the end"),
    }
