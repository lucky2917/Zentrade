"""
Hard token and call budgets.

Token cost is a resource spent deliberately, not a side effect of how many
symbols happen to look interesting. The budget refuses rather than overspends,
and it refuses BEFORE the call, so a rejected deliberation costs nothing.
Per-agent spend is tracked because "we used 400k tokens today" is not
actionable and "the sentiment agent used 380k of it" is.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date


class BudgetExceeded(RuntimeError):
    def __init__(self, agent: str, requested: int, remaining: int) -> None:
        super().__init__(f"{agent} requested {requested} tokens, {remaining} left in budget")
        self.agent = agent
        self.requested = requested
        self.remaining = remaining


@dataclass
class TokenBudget:
    daily_tokens: int
    per_cycle_tokens: int
    session_day: date

    spent_today: int = 0
    spent_this_cycle: int = 0
    by_agent: dict[str, int] = field(default_factory=lambda: defaultdict(int))
    refusals: int = 0

    def roll_to(self, day: date) -> None:
        if day != self.session_day:
            self.session_day = day
            self.spent_today = 0
            self.by_agent = defaultdict(int)
            self.refusals = 0
        self.spent_this_cycle = 0

    @property
    def remaining_today(self) -> int:
        return max(0, self.daily_tokens - self.spent_today)

    @property
    def remaining_this_cycle(self) -> int:
        return max(0, self.per_cycle_tokens - self.spent_this_cycle)

    def can_afford(self, tokens: int) -> bool:
        return tokens <= min(self.remaining_today, self.remaining_this_cycle)

    def spend(self, agent: str, tokens: int) -> None:
        if tokens < 0:
            raise ValueError("token spend cannot be negative")
        if not self.can_afford(tokens):
            self.refusals += 1
            raise BudgetExceeded(agent, tokens, min(self.remaining_today, self.remaining_this_cycle))
        self.spent_today += tokens
        self.spent_this_cycle += tokens
        self.by_agent[agent] += tokens

    def snapshot(self) -> dict:
        return {
            "session_day": self.session_day.isoformat(),
            "spent_today": self.spent_today,
            "remaining_today": self.remaining_today,
            "refusals": self.refusals,
            "by_agent": dict(self.by_agent),
        }
