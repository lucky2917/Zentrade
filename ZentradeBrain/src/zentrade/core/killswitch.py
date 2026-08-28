"""The kill switch. Trips automatically, resets only by hand."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum


class KillReason(str, Enum):
    MANUAL = "MANUAL"
    DAILY_LOSS_LIMIT = "DAILY_LOSS_LIMIT"
    MAX_DRAWDOWN = "MAX_DRAWDOWN"
    RECONCILIATION_DIVERGENCE = "RECONCILIATION_DIVERGENCE"
    EXECUTION_DIVERGENCE = "EXECUTION_DIVERGENCE"


@dataclass
class KillSwitch:
    """Engaging is cheap and automatic; disengaging is deliberate and manual."""

    engaged: bool = False
    reason: KillReason | None = None
    engaged_ts: int | None = None
    trip_count: int = 0

    def engage(self, reason: KillReason, ts_utc: int) -> None:
        if self.engaged:
            return
        self.engaged = True
        self.reason = reason
        self.engaged_ts = ts_utc
        self.trip_count += 1

    def reset(self, operator: str) -> None:
        if not operator:
            raise ValueError("a kill-switch reset must name the operator")
        self.engaged = False
        self.reason = None
        self.engaged_ts = None

    def snapshot(self) -> dict:
        return {"engaged": self.engaged,
                "reason": self.reason.value if self.reason else None,
                "engaged_ts": self.engaged_ts, "trip_count": self.trip_count}
