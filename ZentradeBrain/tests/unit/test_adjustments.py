"""Adjustment table writes. A split applied twice is a corrupted price history."""
from datetime import datetime, timezone

from zentrade.spine.reader import adjustment_factors
from zentrade.spine.writer import write_adjustments


def ts(y, m, d):
    return int(datetime(y, m, d, tzinfo=timezone.utc).timestamp() * 1_000_000)


def row(symbol="RELIANCE", when=None, kind="split", num=1, den=10):
    return {"symbol": symbol, "effective_ts_utc": when or ts(2024, 6, 1), "kind": kind,
            "numerator": num, "denominator": den, "source": "test"}


class TestIdempotency:
    def test_rewriting_identical_rows_does_not_duplicate(self, tmp_path):
        first = write_adjustments(tmp_path, "NSE", [row()])
        second = write_adjustments(tmp_path, "NSE", [row()])
        assert (first.inserted, first.replaced) == (1, 0)
        assert (second.inserted, second.replaced) == (0, 1)
        assert adjustment_factors(tmp_path, "NSE", ts(2025, 1, 1)).num_rows == 1

    def test_overlapping_backfill_windows_cannot_double_apply(self, tmp_path):
        """Windows overlap by design, so the same action arrives twice."""
        write_adjustments(tmp_path, "NSE", [row(), row(symbol="TCS")])
        write_adjustments(tmp_path, "NSE", [row(), row(symbol="INFY")])
        table = adjustment_factors(tmp_path, "NSE", ts(2025, 1, 1))
        assert table.num_rows == 3
        factors = dict(zip(table.column("symbol").to_pylist(),
                           table.column("price_factor").to_pylist()))
        assert abs(factors["RELIANCE"] - 0.1) < 1e-12, "split applied more than once"

    def test_distinct_kinds_on_one_day_are_separate_rows(self, tmp_path):
        write_adjustments(tmp_path, "NSE", [
            row(kind="split", num=1, den=2), row(kind="bonus", num=1, den=2)])
        assert adjustment_factors(tmp_path, "NSE", ts(2025, 1, 1)).num_rows == 2

    def test_empty_write_is_harmless(self, tmp_path):
        assert write_adjustments(tmp_path, "NSE", []).inserted == 0


class TestCumulativeFactor:
    def test_two_splits_compound(self, tmp_path):
        write_adjustments(tmp_path, "NSE", [
            row(when=ts(2023, 1, 1), num=1, den=2),
            row(when=ts(2024, 1, 1), num=1, den=5),
        ])
        table = adjustment_factors(tmp_path, "NSE", ts(2025, 1, 1))
        factors = sorted(table.column("price_factor").to_pylist())
        assert abs(factors[0] - 0.1) < 1e-12
        assert abs(factors[1] - 0.2) < 1e-12

    def test_future_action_invisible_before_its_ex_date(self, tmp_path):
        write_adjustments(tmp_path, "NSE", [row(when=ts(2026, 1, 1))])
        assert adjustment_factors(tmp_path, "NSE", ts(2025, 1, 1)).num_rows == 0
