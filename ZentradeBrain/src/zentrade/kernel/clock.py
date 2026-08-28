"""Injected time and NSE session state."""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from enum import Enum
from functools import lru_cache
from pathlib import Path
from typing import Protocol

IST = timezone(timedelta(hours=5, minutes=30))

CALENDAR_PATH = Path(__file__).resolve().parents[3] / "reference" / "nse_calendar.json"


class SessionState(str, Enum):
    CLOSED = "CLOSED"
    PRE_OPEN = "PRE_OPEN"
    OPEN = "OPEN"


class Clock(Protocol):
    def now(self) -> datetime: ...


class SystemClock:
    def now(self) -> datetime:
        return datetime.now(timezone.utc)


@dataclass(frozen=True)
class FixedClock:
    at: datetime

    def now(self) -> datetime:
        return self.at


@lru_cache(maxsize=1)
def load_calendar(path: Path | None = None) -> dict:
    return json.loads((path or CALENDAR_PATH).read_text())


class NseCalendar:
    PRE_OPEN_MINUTES = 15

    def __init__(self, calendar: dict | None = None) -> None:
        data = calendar or load_calendar()
        session = data["session"]
        self.holidays = frozenset(data["holidays"])
        self.trading_days = frozenset(session["days"])
        self.open_at = time.fromisoformat(session["open"])
        self.close_at = time.fromisoformat(session["close"])

    def is_holiday(self, day: date) -> bool:
        return day.isoformat() in self.holidays

    def is_trading_day(self, day: date) -> bool:
        return day.isoweekday() in self.trading_days and not self.is_holiday(day)

    def state_at(self, moment: datetime) -> SessionState:
        local = moment.astimezone(IST)
        if not self.is_trading_day(local.date()):
            return SessionState.CLOSED

        clock_time = local.time()
        pre_open = (
            datetime.combine(local.date(), self.open_at) - timedelta(minutes=self.PRE_OPEN_MINUTES)
        ).time()

        if pre_open <= clock_time < self.open_at:
            return SessionState.PRE_OPEN
        if self.open_at <= clock_time <= self.close_at:
            return SessionState.OPEN
        return SessionState.CLOSED

    def session_day(self, moment: datetime) -> date:
        return moment.astimezone(IST).date()
