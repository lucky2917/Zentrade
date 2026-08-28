from datetime import datetime, timezone
from decimal import Decimal

import pytest

from zentrade.spine.layout import bars_partition
from zentrade.spine.money import decimal_from_json, from_minor, to_minor
from zentrade.spine.reader import adjustment_factors, read_bars, universe_on
from zentrade.kernel.money import MoneyError
from zentrade.spine.semantics import ADJUSTMENT_SCHEMA, SemanticsError
from zentrade.spine.writer import write_bars

import pyarrow as pa
import pyarrow.parquet as pq
from zentrade.spine.layout import adjustments_path


def ts(y, m, d, hh=0, mm=0):
    return int(datetime(y, m, d, hh, mm, tzinfo=timezone.utc).timestamp() * 1_000_000)


def bar(symbol, when, close=100_00):
    return {
        "symbol": symbol, "ts_utc": when,
        "open": close, "high": close, "low": close, "close": close,
        "volume": 1_000,
    }


class TestMoney:
    def test_exact_conversion_and_round_trip(self):
        assert to_minor("1500.50", "NSE") == 150050
        assert to_minor(Decimal("0.05"), "NSE") == 5
        assert to_minor(7, "NSE") == 700
        assert from_minor(150050, "NSE") == Decimal("1500.50")

    def test_rejects_float(self):
        with pytest.raises(MoneyError, match="refusing float"):
            to_minor(1500.50, "NSE")

    def test_rejects_bool(self):
        with pytest.raises(MoneyError, match="refusing bool"):
            to_minor(True, "NSE")

    def test_rejects_sub_paise_precision(self):
        with pytest.raises(MoneyError, match="exceeds 2 fractional digits"):
            to_minor("1500.505", "NSE")

    def test_vendor_json_decodes_without_touching_float(self):
        payload = decimal_from_json('{"ltp": 1500.50}')
        assert isinstance(payload["ltp"], Decimal)
        assert to_minor(payload["ltp"], "NSE") == 150050

    def test_unknown_venue_rejected(self):
        with pytest.raises(SemanticsError, match="unknown venue"):
            to_minor("1.00", "LSE")


class TestLayout:
    def test_daily_partitions_by_year(self, tmp_path):
        p = bars_partition(tmp_path, "NSE", "1d", ts(2024, 3, 15))
        assert p.parts[-3:] == ("venue=NSE", "granularity=1d", "year=2024")

    def test_minute_partitions_by_year_and_month(self, tmp_path):
        p = bars_partition(tmp_path, "NSE", "1m", ts(2024, 3, 15))
        assert p.parts[-2:] == ("year=2024", "month=03")

    def test_unknown_granularity_rejected(self, tmp_path):
        with pytest.raises(SemanticsError, match="unknown granularity"):
            bars_partition(tmp_path, "NSE", "1h", ts(2024, 3, 15))


class TestWriterIdempotency:
    def test_rewriting_identical_rows_is_a_no_op(self, tmp_path):
        rows = [bar("RELIANCE", ts(2024, 3, 15)), bar("TCS", ts(2024, 3, 15))]

        first = write_bars(tmp_path, "NSE", "1d", rows)
        assert (first.inserted, first.replaced) == (2, 0)
        target = bars_partition(tmp_path, "NSE", "1d", ts(2024, 3, 15)) / "bars.parquet"
        digest = target.read_bytes()

        second = write_bars(tmp_path, "NSE", "1d", rows)
        assert (second.inserted, second.replaced) == (0, 2)
        assert target.read_bytes() == digest, "identical re-ingest must be byte-stable"

    def test_correction_replaces_and_is_counted(self, tmp_path):
        when = ts(2024, 3, 15)
        write_bars(tmp_path, "NSE", "1d", [bar("RELIANCE", when, close=100_00)])
        result = write_bars(tmp_path, "NSE", "1d", [bar("RELIANCE", when, close=250_00)])

        assert (result.inserted, result.replaced) == (0, 1)
        table = read_bars(tmp_path, "NSE", "1d")
        assert table.column("close").to_pylist() == [250_00]

    def test_rows_route_to_their_own_partitions(self, tmp_path):
        result = write_bars(tmp_path, "NSE", "1m", [
            bar("RELIANCE", ts(2024, 3, 15, 10, 0)),
            bar("RELIANCE", ts(2024, 4, 15, 10, 0)),
        ])
        assert result.partitions == 2

    def test_empty_write_is_harmless(self, tmp_path):
        assert write_bars(tmp_path, "NSE", "1d", []).total == 0


class TestReader:
    def test_filters_by_symbol_and_window(self, tmp_path):
        write_bars(tmp_path, "NSE", "1d", [
            bar("RELIANCE", ts(2024, 3, 14)),
            bar("RELIANCE", ts(2024, 3, 15)),
            bar("TCS", ts(2024, 3, 15)),
        ])
        table = read_bars(
            tmp_path, "NSE", "1d",
            symbols=["RELIANCE"], start_ts=ts(2024, 3, 15), end_ts=ts(2024, 3, 16),
        )
        assert table.num_rows == 1
        assert table.column("symbol").to_pylist() == ["RELIANCE"]

    def test_universe_is_reconstructed_from_what_traded(self, tmp_path):
        """A name that stopped trading must stay in the historical universe."""
        write_bars(tmp_path, "NSE", "1d", [
            bar("RELIANCE", ts(2024, 3, 15)),
            bar("DELISTEDCO", ts(2024, 3, 15)),
            bar("RELIANCE", ts(2024, 6, 15)),
        ])
        march = universe_on(tmp_path, "NSE", "1d", ts(2024, 3, 1), ts(2024, 4, 1))
        june = universe_on(tmp_path, "NSE", "1d", ts(2024, 6, 1), ts(2024, 7, 1))

        assert march == ["DELISTEDCO", "RELIANCE"]
        assert june == ["RELIANCE"]


class TestNoLookAhead:
    """M18 DoD: no read may surface information unavailable at its as_of."""

    def _write_split(self, tmp_path, effective):
        table = pa.table({
            "symbol": ["RELIANCE"],
            "effective_ts_utc": [effective],
            "kind": ["split"],
            "numerator": [1],
            "denominator": [2],
            "source": ["test"],
        }, schema=ADJUSTMENT_SCHEMA)
        path = adjustments_path(tmp_path, "NSE")
        path.parent.mkdir(parents=True, exist_ok=True)
        pq.write_table(table, path)

    def test_future_split_is_invisible_before_it_happens(self, tmp_path):
        self._write_split(tmp_path, ts(2026, 1, 1))
        assert adjustment_factors(tmp_path, "NSE", as_of_ts=ts(2025, 1, 1)).num_rows == 0

    def test_split_applies_once_effective(self, tmp_path):
        self._write_split(tmp_path, ts(2026, 1, 1))
        factors = adjustment_factors(tmp_path, "NSE", as_of_ts=ts(2026, 6, 1))
        assert factors.num_rows == 1
        assert factors.column("price_factor").to_pylist()[0] == pytest.approx(0.5)

    def test_absent_adjustment_table_is_not_an_error(self, tmp_path):
        assert adjustment_factors(tmp_path, "NSE", as_of_ts=ts(2026, 1, 1)) is None
