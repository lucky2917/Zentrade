"""Point-in-time liquidity screen. The property under test is that the screen."""
from datetime import date, datetime, timedelta, timezone

import pytest

from zentrade.adapters.data.pit import SpinePitSource
from zentrade.features.universe import liquidity_screen
from zentrade.spine.writer import write_bars


def ts(d: date) -> int:
    return int(datetime(d.year, d.month, d.day, 10, 0, tzinfo=timezone.utc).timestamp() * 1_000_000)


def seed(base, symbol_turnovers, days=90, start=date(2024, 1, 1)):
    """Write `days` sessions where each symbol holds a constant close/volume,."""
    rows = []
    for offset in range(days):
        day = start + timedelta(days=offset)
        for symbol, (close, volume) in symbol_turnovers.items():
            rows.append({"symbol": symbol, "ts_utc": ts(day), "open": close, "high": close,
                         "low": close, "close": close, "volume": volume})
    write_bars(base, "NSE", "1d", rows)
    return start + timedelta(days=days)


class TestRanking:
    def test_orders_by_median_turnover(self, tmp_path):
        after = seed(tmp_path, {"BIG": (100, 1000), "MID": (100, 500), "SMALL": (100, 10)})
        result = liquidity_screen(SpinePitSource(tmp_path, adjust=False), after, size=3, min_sessions=10)
        assert list(result.symbols) == ["BIG", "MID", "SMALL"]

    def test_size_caps_the_result(self, tmp_path):
        after = seed(tmp_path, {f"S{i:02d}": (100, 1000 - i) for i in range(20)})
        assert len(liquidity_screen(SpinePitSource(tmp_path, adjust=False), after, size=5, min_sessions=10)) == 5

    def test_ties_break_on_symbol_so_the_screen_is_reproducible(self, tmp_path):
        after = seed(tmp_path, {"BBB": (100, 500), "AAA": (100, 500), "CCC": (100, 500)})
        first = liquidity_screen(SpinePitSource(tmp_path, adjust=False), after, size=2, min_sessions=10)
        second = liquidity_screen(SpinePitSource(tmp_path, adjust=False), after, size=2, min_sessions=10)
        assert list(first.symbols) == ["AAA", "BBB"] == list(second.symbols)


class TestPointInTime:
    def test_as_of_day_is_excluded(self, tmp_path):
        """A screen that includes as_of has seen the session it is about to."""
        start = date(2024, 1, 1)
        seed(tmp_path, {"OLD": (100, 100)}, days=30, start=start)
        as_of = start + timedelta(days=30)
        write_bars(tmp_path, "NSE", "1d", [{
            "symbol": "FUTURE", "ts_utc": ts(as_of), "open": 100, "high": 100,
            "low": 100, "close": 100, "volume": 999_999,
        }])
        result = liquidity_screen(SpinePitSource(tmp_path, adjust=False), as_of, size=10, min_sessions=1)
        assert "FUTURE" not in result.symbols, "screen leaked the as_of session"
        assert "OLD" in result.symbols

    def test_lookback_window_bounds_the_history_used(self, tmp_path):
        start = date(2024, 1, 1)
        seed(tmp_path, {"STALE": (100, 999_999)}, days=10, start=start)
        seed(tmp_path, {"FRESH": (100, 100)}, days=10, start=start + timedelta(days=200))
        as_of = start + timedelta(days=215)
        result = liquidity_screen(SpinePitSource(tmp_path, adjust=False), as_of, size=10, lookback_days=30, min_sessions=1)
        assert "FRESH" in result.symbols
        assert "STALE" not in result.symbols, "lookback window not applied"


class TestDegenerate:
    def test_empty_spine_returns_empty_not_error(self, tmp_path):
        result = liquidity_screen(SpinePitSource(tmp_path, adjust=False), date(2024, 6, 1))
        assert len(result) == 0 and result.considered == 0

    def test_min_sessions_excludes_thinly_traded_names(self, tmp_path):
        start = date(2024, 1, 1)
        seed(tmp_path, {"LIQUID": (100, 100)}, days=90, start=start)
        write_bars(tmp_path, "NSE", "1d", [{
            "symbol": "ONEDAY", "ts_utc": ts(start + timedelta(days=5)), "open": 100,
            "high": 100, "low": 100, "close": 100, "volume": 10_000_000,
        }])
        result = liquidity_screen(SpinePitSource(tmp_path, adjust=False), start + timedelta(days=90), size=10, min_sessions=60)
        assert "ONEDAY" not in result.symbols
        assert "LIQUID" in result.symbols
