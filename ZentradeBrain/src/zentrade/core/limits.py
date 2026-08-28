"""Risk limits, system state, and the bounded composition rule."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

UNKNOWN_SECTOR = "UNKNOWN"


class SystemState(str, Enum):
    NORMAL = "NORMAL"
    CAUTIOUS = "CAUTIOUS"
    DEGRADED = "DEGRADED"
    ABSTAIN_ONLY = "ABSTAIN_ONLY"
    HALTED = "HALTED"


ABSORBING_STATES = frozenset({SystemState.ABSTAIN_ONLY, SystemState.HALTED})

STATE_BUDGET_SCALAR = {
    SystemState.NORMAL: 1.0,
    SystemState.CAUTIOUS: 0.6,
    SystemState.DEGRADED: 0.3,
    SystemState.ABSTAIN_ONLY: 0.0,
    SystemState.HALTED: 0.0,
}

STATE_HURDLE_MULTIPLIER = {
    SystemState.NORMAL: 1.0,
    SystemState.CAUTIOUS: 1.3,
    SystemState.DEGRADED: 2.0,
    SystemState.ABSTAIN_ONLY: 1.0,
    SystemState.HALTED: 1.0,
}


@dataclass(frozen=True)
class RiskLimits:
    max_position_value: int = 500_000_00
    max_gross_exposure: int = 5_000_000_00
    max_net_exposure: int = 4_000_000_00
    max_sector_exposure: int = 1_500_000_00
    max_symbols_held: int = 25
    max_trades_per_session: int = 20
    max_turnover_per_session: int = 10_000_000_00
    max_daily_loss: int = 250_000_00
    max_drawdown_pct: float = 0.20
    max_price_drift_bps: float = 100.0
    max_proposal_age_us: int = 5 * 60 * 1_000_000
    viability_floor: int = 10_000_00

    def __post_init__(self) -> None:
        for name in ("max_position_value", "max_gross_exposure", "max_net_exposure",
                     "max_sector_exposure", "max_turnover_per_session",
                     "max_daily_loss", "viability_floor"):
            if getattr(self, name) <= 0:
                raise ValueError(f"{name} must be positive")
        if not 0 < self.max_drawdown_pct <= 1:
            raise ValueError("max_drawdown_pct must be in (0, 1]")


@dataclass(frozen=True)
class RiskInputs:
    """Scalars that gate the risk budget. Each is in [0, 1]."""

    regime_confidence: float = 1.0
    health_scalar: float = 1.0
    ood_scalar: float = 1.0
    drawdown_scalar: float = 1.0
    state: SystemState = SystemState.NORMAL

    def __post_init__(self) -> None:
        for name in ("regime_confidence", "health_scalar", "ood_scalar", "drawdown_scalar"):
            value = getattr(self, name)
            if not 0.0 <= value <= 1.0:
                raise ValueError(f"{name} must be within [0, 1], got {value}")


def model_trust_axis(inputs: RiskInputs) -> float:
    """Regime confidence, strategy health and novelty are three instruments."""
    return min(inputs.regime_confidence, inputs.health_scalar, inputs.ood_scalar)


def account_axis(inputs: RiskInputs) -> float:
    """Drawdown is about the account, not the model, so it is a genuinely."""
    return inputs.drawdown_scalar


def budget_multiplier(inputs: RiskInputs) -> float:
    """Exactly two factors, never four. An absorbing state yields zero without."""
    if inputs.state in ABSORBING_STATES:
        return 0.0
    trust = min(model_trust_axis(inputs), STATE_BUDGET_SCALAR[inputs.state])
    return trust * account_axis(inputs)


def hurdle_multiplier(inputs: RiskInputs, ood_hurdle: float = 1.0) -> float:
    """The mirror of the min rule: overlapping cautions take the max, never."""
    if ood_hurdle < 1.0:
        raise ValueError("a hurdle multiplier may not lower the hurdle")
    return max(STATE_HURDLE_MULTIPLIER[inputs.state], ood_hurdle)
