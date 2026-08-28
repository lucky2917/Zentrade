"""Phase 1 blocking criterion: the two NSE archive formats must agree."""
import os
from datetime import date
from pathlib import Path

import pytest

from zentrade.adapters.data.nse_bhavcopy import (
    BhavcopyUnavailable, formats_for, load_day, polite_sleep, session_timestamp,
)

NETWORK = os.getenv("ZENTRADE_NETWORK_TESTS") == "1"
CACHE = Path(__file__).resolve().parents[2] / "data" / "cache" / "bhavcopy"
OVERLAP_DAYS = [date(2024, 1, 2), date(2024, 2, 1), date(2024, 3, 1)]


def test_format_selection_by_date():
    assert [f.name for f in formats_for(date(2023, 3, 1))] == ["legacy"]
    assert [f.name for f in formats_for(date(2024, 3, 1))][0] == "udiff"


def test_session_timestamp_is_close_not_midnight():
    """A daily bar is only complete at the close; stamping midnight would place."""
    from datetime import datetime, timezone
    ts = session_timestamp(date(2024, 3, 1))
    moment = datetime.fromtimestamp(ts / 1e6, tz=timezone.utc)
    assert (moment.hour, moment.minute) == (10, 0)


@pytest.mark.skipif(not NETWORK, reason="set ZENTRADE_NETWORK_TESTS=1")
@pytest.mark.parametrize("day", OVERLAP_DAYS)
def test_formats_agree_to_the_paise(day):
    try:
        _, udiff = load_day(day, CACHE, prefer="udiff")
        polite_sleep(0.5)
        _, legacy = load_day(day, CACHE, prefer="legacy")
    except BhavcopyUnavailable as exc:
        pytest.skip(str(exc))

    u = {b.symbol: b for b in udiff}
    l = {b.symbol: b for b in legacy}
    assert u.keys() == l.keys(), f"symbol sets differ on {day}"
    assert len(u) > 1500, f"implausibly few symbols on {day}: {len(u)}"

    for symbol, a in u.items():
        b = l[symbol]
        assert (a.open, a.high, a.low, a.close, a.volume) == (b.open, b.high, b.low, b.close, b.volume), symbol
        assert a.isin == b.isin, symbol


@pytest.mark.skipif(not NETWORK, reason="set ZENTRADE_NETWORK_TESTS=1")
def test_bars_survive_contract_validation():
    """DailyBar rejects OHLC that cannot be a real bar. A full session passing."""
    _, bars = load_day(date(2024, 3, 1), CACHE, prefer="udiff")
    assert all(b.low <= b.open <= b.high and b.low <= b.close <= b.high for b in bars)
