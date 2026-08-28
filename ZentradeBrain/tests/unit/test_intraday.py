from datetime import datetime, timezone

import pytest

from zentrade.adapters.data.fyers_intraday import (
    ParseReport, ist_parts, parse_file, session_completeness, strip_symbol,
)
from zentrade.spine.layout import bars_partition, partition_key
from zentrade.spine.semantics import (
    EXPECTED_CANDLES_PER_SESSION, GRANULARITIES, INTRADAY_GRANULARITIES,
    SemanticsError, bars_per_session, require_granularity,
)

OPEN_IST_EPOCH = int(datetime(2026, 6, 1, 3, 45, tzinfo=timezone.utc).timestamp())


def candle(epoch, close=100.5, volume=10):
    return [epoch, 100.0, 101.0, 99.0, close, volume]


def write_cache(path, resolution, candles, symbol="NSE:RELIANCE-EQ"):
    import json
    path.write_text(json.dumps({
        "symbol": symbol, "resolution": resolution,
        "from": "2026-06-01", "to": "2026-06-30",
        "fetchedAtUtc": "2026-06-30T00:00:00Z", "candles": candles,
    }))
    return path


class TestSemantics:
    def test_intraday_granularities_registered(self):
        assert set(INTRADAY_GRANULARITIES) <= set(GRANULARITIES)
        assert set(INTRADAY_GRANULARITIES) == {"1m", "5m", "15m"}

    def test_expected_candles_divide_the_session(self):
        assert EXPECTED_CANDLES_PER_SESSION == {"1m": 375, "5m": 75, "15m": 25}

    def test_bars_per_session_treats_daily_as_one(self):
        assert bars_per_session("1d") == 1
        assert bars_per_session("15m") == 25

    def test_unknown_granularity_rejected(self):
        with pytest.raises(SemanticsError):
            require_granularity("30m")
        with pytest.raises(SemanticsError):
            bars_per_session("30m")


class TestLayout:
    def test_daily_partitions_by_year_only(self):
        assert partition_key("1d", 0) == (("year", "1970"),)

    def test_intraday_partitions_by_year_and_month(self):
        ts = int(datetime(2026, 6, 15, tzinfo=timezone.utc).timestamp() * 1_000_000)
        assert partition_key("5m", ts) == (("year", "2026"), ("month", "06"))

    def test_intraday_paths_are_distinct_per_granularity(self, tmp_path):
        ts = int(datetime(2026, 6, 15, tzinfo=timezone.utc).timestamp() * 1_000_000)
        paths = {bars_partition(tmp_path, "NSE", g, ts) for g in INTRADAY_GRANULARITIES}
        assert len(paths) == len(INTRADAY_GRANULARITIES)


class TestParse:
    def test_strip_symbol(self):
        assert strip_symbol("NSE:RELIANCE-EQ") == "RELIANCE"

    def test_ist_parts_maps_open_to_555_minutes(self):
        _, minutes = ist_parts(OPEN_IST_EPOCH)
        assert minutes == 9 * 60 + 15

    def test_duplicate_timestamps_collapse(self, tmp_path):
        path = write_cache(tmp_path / "a.json", "15",
                           [candle(OPEN_IST_EPOCH), candle(OPEN_IST_EPOCH, close=999.0)])
        report = ParseReport()
        rows = parse_file(path, report)
        assert len(rows) == 1
        assert report.duplicates_dropped == 1

    def test_out_of_session_candles_dropped(self, tmp_path):
        path = write_cache(tmp_path / "a.json", "15",
                           [candle(OPEN_IST_EPOCH - 3600), candle(OPEN_IST_EPOCH)])
        report = ParseReport()
        rows = parse_file(path, report)
        assert len(rows) == 1
        assert report.out_of_session == 1

    def test_unordered_input_is_recorded_and_sorted(self, tmp_path):
        later = OPEN_IST_EPOCH + 900
        path = write_cache(tmp_path / "a.json", "15",
                           [candle(later), candle(OPEN_IST_EPOCH)])
        report = ParseReport()
        rows = parse_file(path, report)
        assert report.unordered_files == 1
        assert [r["ts_utc"] for r in rows] == sorted(r["ts_utc"] for r in rows)

    def test_prices_stored_as_integer_minor_units(self, tmp_path):
        path = write_cache(tmp_path / "a.json", "15", [candle(OPEN_IST_EPOCH, close=100.55)])
        rows = parse_file(path, ParseReport())
        assert rows[0]["close"] == 10055
        assert all(isinstance(rows[0][f], int) for f in ("open", "high", "low", "close"))

    def test_unmapped_resolution_rejected(self, tmp_path):
        path = write_cache(tmp_path / "a.json", "30", [candle(OPEN_IST_EPOCH)])
        with pytest.raises(SemanticsError):
            parse_file(path, ParseReport())


class TestCompleteness:
    def test_short_session_reported(self, tmp_path):
        path = write_cache(tmp_path / "a.json", "15", [candle(OPEN_IST_EPOCH)])
        rows = parse_file(path, ParseReport())
        result = session_completeness(rows, "15m")
        assert result["expected"] == 25
        assert len(result["short"]) == 1
