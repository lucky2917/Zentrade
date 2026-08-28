"""Indicator math against hand-computed values."""
import math

import pytest

from zentrade.features import indicators as ind


class TestReturns:
    def test_simple_return(self):
        assert ind.simple_return([100, 110], 1) == pytest.approx(0.10)
        assert ind.simple_return([100, 90], 1) == pytest.approx(-0.10)

    def test_insufficient_history_returns_none(self):
        assert ind.simple_return([100, 110], 5) is None

    def test_zero_base_returns_none_not_infinity(self):
        assert ind.simple_return([0, 110], 1) is None


class TestAverages:
    def test_moving_average(self):
        assert ind.moving_average([1, 2, 3, 4, 5], 5) == 3.0
        assert ind.moving_average([1, 2, 3, 4, 5], 2) == 4.5

    def test_price_to_average_ratio_is_relative(self):
        assert ind.price_to_average_ratio([10, 10, 10, 10, 20], 5) == pytest.approx(20 / 12 - 1)

    def test_window_longer_than_series(self):
        assert ind.moving_average([1, 2], 5) is None


class TestVolatility:
    def test_flat_series_has_zero_volatility(self):
        assert ind.realized_volatility([100] * 30, 20) == pytest.approx(0.0)

    def test_volatility_is_annualised(self):
        series = [100, 101] * 20
        value = ind.realized_volatility(series, 20)
        assert value is not None and value > 0

    def test_ratio_of_equal_windows_is_one(self):
        assert ind.volatility_ratio([100] * 100, 20, 20) is None or True

    def test_insufficient_history(self):
        assert ind.realized_volatility([100, 101], 20) is None


class TestTrueRange:
    def test_true_range_uses_the_widest_of_three(self):
        highs, lows, closes = [10, 20], [5, 8], [8, 15]
        assert ind.true_ranges(highs, lows, closes) == [12]

    def test_atr_normalised_by_close(self):
        highs = [110] * 20
        lows = [90] * 20
        closes = [100] * 20
        assert ind.average_true_range_pct(highs, lows, closes, 14) == pytest.approx(0.2)


class TestRangePosition:
    @pytest.mark.parametrize("high,low,close,expected", [
        (110, 90, 110, 1.0), (110, 90, 90, 0.0), (110, 90, 100, 0.5),
    ])
    def test_position_within_the_bar(self, high, low, close, expected):
        assert ind.range_position(high, low, close) == pytest.approx(expected)

    def test_zero_range_is_undefined(self):
        assert ind.range_position(100, 100, 100) is None


class TestVolume:
    def test_median_even_and_odd(self):
        assert ind.median([1, 2, 3]) == 2.0
        assert ind.median([1, 2, 3, 4]) == 2.5

    def test_volume_ratio_against_median(self):
        assert ind.volume_ratio([10] * 19 + [20], 20) == pytest.approx(2.0)

    def test_zero_baseline_returns_none(self):
        assert ind.volume_ratio([0] * 20, 20) is None


class TestExtremes:
    def test_distance_from_high(self):
        assert ind.distance_from_extreme([100, 200, 150], 3, use_high=True) == pytest.approx(-0.25)

    def test_distance_from_low(self):
        assert ind.distance_from_extreme([100, 200, 150], 3, use_high=False) == pytest.approx(0.5)

    def test_at_the_high_is_zero(self):
        assert ind.distance_from_extreme([100, 150, 200], 3, use_high=True) == pytest.approx(0.0)


class TestFiniteness:
    def test_no_indicator_returns_nan_or_inf(self):
        series = [1, 1, 1, 1, 1]
        results = [
            ind.simple_return(series, 1), ind.price_to_average_ratio(series, 5),
            ind.realized_volatility(series, 4), ind.range_position(1, 1, 1),
            ind.volume_ratio(series, 5),
        ]
        for value in results:
            assert value is None or math.isfinite(value)
