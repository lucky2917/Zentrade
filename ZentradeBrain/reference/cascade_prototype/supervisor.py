"""
The cycle supervisor.

One tick is: reflex over everything, gate over what changed, deliberate over
what the gate escalated and the budget still allows. Cost is controlled by that
ordering, not by throttling calls after the fact.

Agents fail soft: one raising never takes the loop down, because a runtime that
dies at 10:15 is worse than one that skips an agent. Nothing reads the wall
clock directly, so a session replays deterministically from a FixedClock.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import timedelta

from .agent import Agent, CycleContext, Observation, Signal, Tier
from .budget import BudgetExceeded, TokenBudget

logger = logging.getLogger("zentrade.cascade")

IDLE_POLL_SECONDS = 60.0
ACTIVE_POLL_SECONDS = 1.0


@dataclass
class CycleResult:
    state: object
    signals: list[Signal] = field(default_factory=list)
    considered: int = 0
    changed: int = 0
    escalated: int = 0
    deliberated: int = 0
    tokens_spent: int = 0
    failures: dict[str, str] = field(default_factory=dict)


class Supervisor:
    def __init__(self, clock, calendar, budget: TokenBudget, agents: list[Agent]) -> None:
        self.clock = clock
        self.calendar = calendar
        self.budget = budget
        self.agents = sorted(agents, key=lambda a: a.tier)
        self._last_seen: dict[str, Observation] = {}

    def _tiered(self, tier: Tier) -> list[Agent]:
        return [a for a in self.agents if a.tier == tier]

    def _changed_since_last_tick(self, observations: list[Observation]) -> list[Observation]:
        changed = [o for o in observations if self._last_seen.get(o.symbol) != o]
        self._last_seen.update({o.symbol: o for o in changed})
        return changed

    def _run_agent(self, agent, observations, context, result) -> list[Signal]:
        if not observations:
            return []
        try:
            return agent.evaluate(observations, context)
        except BudgetExceeded as exc:
            logger.info("budget refused %s: %s", agent.name, exc)
            return []
        except Exception as exc:
            logger.exception("agent %s failed", agent.name)
            result.failures[agent.name] = str(exc)
            return []

    def tick(self, observations: list[Observation]) -> CycleResult:
        from .clock_stub import SessionState  # supplied by the host runtime

        now = self.clock.now()
        session_day = self.calendar.session_day(now)
        state = self.calendar.state_at(now)

        self.budget.roll_to(session_day)
        result = CycleResult(state=state, considered=len(observations))

        if state is SessionState.CLOSED:
            return result

        context = CycleContext(now=now, session_day=session_day)
        before = self.budget.spent_today

        for agent in self._tiered(Tier.REFLEX):
            result.signals += self._run_agent(agent, observations, context, result)

        changed = self._changed_since_last_tick(observations)
        result.changed = len(changed)
        for agent in self._tiered(Tier.GATE):
            result.signals += self._run_agent(agent, changed, context, result)

        escalated = [o for o in observations if o.symbol in context.escalated]
        result.escalated = len(escalated)

        deliberators = self._tiered(Tier.DELIBERATE)
        if escalated and deliberators and self.budget.can_afford(1):
            for agent in deliberators:
                produced = self._run_agent(agent, escalated, context, result)
                result.signals += produced
                result.deliberated += len(produced)

        result.tokens_spent = self.budget.spent_today - before
        return result

    def seconds_until_next_session(self) -> float:
        now = self.clock.now()
        probe = now
        for _ in range(8 * 24 * 60):
            probe = probe + timedelta(minutes=1)
            if self.calendar.state_at(probe).name != "CLOSED":
                return max(0.0, (probe - now).total_seconds())
        return IDLE_POLL_SECONDS
