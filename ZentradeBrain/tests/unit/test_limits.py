"""Bounded risk composition, per freeze-audit C2."""
import pytest

from zentrade.core.limits import (
    ABSORBING_STATES, RiskInputs, RiskLimits, STATE_BUDGET_SCALAR, SystemState,
    account_axis, budget_multiplier, hurdle_multiplier, model_trust_axis,
)


class TestAxes:
    def test_model_trust_takes_the_minimum(self):
        inputs = RiskInputs(regime_confidence=0.9, health_scalar=0.4, ood_scalar=0.7)
        assert model_trust_axis(inputs) == 0.4

    def test_drawdown_is_its_own_axis(self):
        assert account_axis(RiskInputs(drawdown_scalar=0.5)) == 0.5

    def test_composition_is_exactly_two_factors(self):
        """Four correlated scalars multiplied would give 0.063; the bounded rule."""
        inputs = RiskInputs(regime_confidence=0.5, health_scalar=0.3, ood_scalar=0.6,
                            drawdown_scalar=0.25, state=SystemState.NORMAL)
        assert budget_multiplier(inputs) == pytest.approx(0.3 * 0.25)

    def test_tightest_model_control_binds_in_full(self):
        inputs = RiskInputs(regime_confidence=0.2, health_scalar=1.0, ood_scalar=1.0)
        assert budget_multiplier(inputs) == pytest.approx(0.2)


class TestAbsorbingStates:
    @pytest.mark.parametrize("state", sorted(ABSORBING_STATES, key=lambda s: s.value))
    def test_absorbing_states_short_circuit_to_zero(self, state):
        inputs = RiskInputs(regime_confidence=1.0, health_scalar=1.0,
                            ood_scalar=1.0, drawdown_scalar=1.0, state=state)
        assert budget_multiplier(inputs) == 0.0

    def test_degraded_state_caps_the_trust_axis(self):
        inputs = RiskInputs(state=SystemState.DEGRADED)
        assert budget_multiplier(inputs) == pytest.approx(STATE_BUDGET_SCALAR[SystemState.DEGRADED])


class TestHurdles:
    def test_overlapping_cautions_take_the_max_not_the_product(self):
        inputs = RiskInputs(state=SystemState.DEGRADED)
        assert hurdle_multiplier(inputs, ood_hurdle=1.5) == 2.0

    def test_a_hurdle_may_never_be_lowered(self):
        with pytest.raises(ValueError):
            hurdle_multiplier(RiskInputs(), ood_hurdle=0.5)

    def test_normal_state_with_no_ood_hurdle_is_one(self):
        assert hurdle_multiplier(RiskInputs()) == 1.0


class TestValidation:
    @pytest.mark.parametrize("field", ["regime_confidence", "health_scalar",
                                       "ood_scalar", "drawdown_scalar"])
    @pytest.mark.parametrize("value", [-0.1, 1.1])
    def test_scalars_must_be_within_zero_and_one(self, field, value):
        with pytest.raises(ValueError):
            RiskInputs(**{field: value})

    def test_limits_reject_nonpositive_values(self):
        with pytest.raises(ValueError):
            RiskLimits(max_position_value=0)

    def test_drawdown_pct_must_be_a_fraction(self):
        with pytest.raises(ValueError):
            RiskLimits(max_drawdown_pct=1.5)


class TestMonotonicity:
    def test_budget_never_increases_when_a_control_tightens(self):
        base = budget_multiplier(RiskInputs())
        for field in ("regime_confidence", "health_scalar", "ood_scalar", "drawdown_scalar"):
            tightened = budget_multiplier(RiskInputs(**{field: 0.5}))
            assert tightened <= base
