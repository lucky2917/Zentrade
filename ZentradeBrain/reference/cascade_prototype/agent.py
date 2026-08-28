"""
Tiered agent protocol.

Three tiers, and a tier is a cost statement rather than a label:

  REFLEX      every tick, every symbol, deterministic, zero tokens.
  GATE        changed symbols only. Its only job is deciding what deserves an
              LLM. Zero tokens.
  DELIBERATE  only what GATE escalated, only while budget allows. The sole
              tier permitted to spend tokens.

The ordering is what makes the runtime cheap: a thousand symbols a second cost
nothing, and the expensive tier sees a handful of candidates a day.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime
from enum import Enum, IntEnum
from typing import Protocol, runtime_checkable


class Tier(IntEnum):
    REFLEX = 0
    GATE = 1
    DELIBERATE = 2


class Action(str, Enum):
    BUY = "BUY"
    SELL = "SELL"
    HOLD = "HOLD"
    EXIT = "EXIT"


@dataclass(frozen=True)
class Observation:
    symbol: str
    price_minor: int
    ts_utc: int
    volume: int = 0
    position_qty: int = 0
    entry_price_minor: int | None = None


@dataclass(frozen=True)
class Signal:
    symbol: str
    action: Action
    tier: Tier
    agent: str
    reason: str
    confidence: float = 0.0
    tokens_spent: int = 0


@dataclass
class CycleContext:
    now: datetime
    session_day: date
    escalated: set[str] = field(default_factory=set)


@runtime_checkable
class Agent(Protocol):
    name: str
    tier: Tier

    def evaluate(self, observations: list[Observation], context: CycleContext) -> list[Signal]: ...
