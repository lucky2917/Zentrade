"""Transaction costs and the bootstrap slippage model."""
import pytest

from zentrade.core.costs import (
    CALIBRATION_STAGE, CostSchedule, ProductType, SlippageModel, compute_costs,
)
from zentrade.core.orders import Side

LAKH = 100_000_00


class TestCostComponents:
    def test_every_component_is_itemised(self):
        breakdown = compute_costs(LAKH, Side.BUY, ProductType.DELIVERY)
        assert set(breakdown.as_dict()) == {
            "brokerage", "stt", "exchange", "sebi", "stamp", "gst", "dp", "total"}

    def test_total_equals_the_sum_of_parts(self):
        breakdown = compute_costs(LAKH, Side.SELL, ProductType.DELIVERY)
        parts = breakdown.as_dict()
        assert parts.pop("total") == sum(parts.values())

    def test_costs_are_never_negative(self):
        for side in Side:
            for product in ProductType:
                assert compute_costs(LAKH, side, product).total > 0

    def test_zero_turnover_still_costs_nothing_negative(self):
        assert compute_costs(0, Side.BUY, ProductType.DELIVERY).total >= 0

    def test_negative_turnover_rejected(self):
        with pytest.raises(ValueError):
            compute_costs(-1, Side.BUY, ProductType.DELIVERY)


class TestProductDifferences:
    def test_stamp_duty_is_buy_side_only(self):
        assert compute_costs(LAKH, Side.BUY, ProductType.DELIVERY).stamp > 0
        assert compute_costs(LAKH, Side.SELL, ProductType.DELIVERY).stamp == 0

    def test_dp_charge_is_delivery_sell_only(self):
        assert compute_costs(LAKH, Side.SELL, ProductType.DELIVERY).dp > 0
        assert compute_costs(LAKH, Side.BUY, ProductType.DELIVERY).dp == 0
        assert compute_costs(LAKH, Side.SELL, ProductType.INTRADAY).dp == 0

    def test_intraday_stt_is_sell_side_only(self):
        assert compute_costs(LAKH, Side.BUY, ProductType.INTRADAY).stt == 0
        assert compute_costs(LAKH, Side.SELL, ProductType.INTRADAY).stt > 0

    def test_delivery_costs_more_than_intraday(self):
        delivery = compute_costs(LAKH, Side.SELL, ProductType.DELIVERY).total
        intraday = compute_costs(LAKH, Side.SELL, ProductType.INTRADAY).total
        assert delivery > intraday


class TestRounding:
    def test_charges_round_up_never_down(self):
        """Rounding a fee down flatters every result that depends on it."""
        schedule = CostSchedule()
        tiny = compute_costs(1, Side.BUY, ProductType.DELIVERY, schedule)
        assert tiny.stt >= 1

    def test_costs_scale_with_turnover(self):
        small = compute_costs(LAKH, Side.BUY, ProductType.DELIVERY).total
        large = compute_costs(LAKH * 10, Side.BUY, ProductType.DELIVERY).total
        assert large > small


class TestSlippage:
    def test_stage_is_declared_bootstrap(self):
        assert CALIBRATION_STAGE == "bootstrap"

    def test_zero_participation_still_pays_the_spread(self):
        assert SlippageModel().slippage_bps(0.0) > 0

    def test_slippage_increases_with_participation(self):
        model = SlippageModel()
        values = [model.slippage_bps(p) for p in (0.0, 0.01, 0.1, 0.5, 1.0)]
        assert values == sorted(values)
        assert len(set(values)) == len(values)

    def test_square_root_law_not_linear(self):
        model = SlippageModel(half_spread_bps=0.0, conservatism_multiplier=1.0)
        quarter = model.slippage_bps(0.25)
        full = model.slippage_bps(1.0)
        assert quarter == pytest.approx(full * 0.5)

    def test_participation_above_one_is_clamped(self):
        model = SlippageModel()
        assert model.slippage_bps(5.0) == model.slippage_bps(1.0)

    def test_negative_participation_rejected(self):
        with pytest.raises(ValueError):
            SlippageModel().slippage_bps(-0.1)

    def test_buy_pays_up_and_sell_receives_less(self):
        model = SlippageModel()
        assert model.adjusted_price(100_00, Side.BUY, 0.1) > 100_00
        assert model.adjusted_price(100_00, Side.SELL, 0.1) < 100_00

    def test_conservatism_multiplier_widens_slippage(self):
        base = SlippageModel(conservatism_multiplier=1.0).slippage_bps(0.1)
        wide = SlippageModel(conservatism_multiplier=2.0).slippage_bps(0.1)
        assert wide == pytest.approx(base * 2)

    def test_price_never_goes_nonpositive(self):
        model = SlippageModel(half_spread_bps=0.0, impact_bps_at_full_participation=1e9)
        assert model.adjusted_price(100, Side.SELL, 1.0) >= 1
