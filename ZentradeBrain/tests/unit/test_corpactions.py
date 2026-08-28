"""
Corporate-action classification. Every case here was read off the live NSE
feed, not invented, so a regression means the feed changed shape.
"""
from datetime import date

import pytest

from zentrade.adapters.data.nse_corpactions import (
    CorporateAction, classify, parse, to_adjustment_rows,
)


class TestBonus:
    @pytest.mark.parametrize("subject,num,den", [
        ("Bonus 1:1", 1, 2),   # 1 new per 1 held -> 2 shares, half the price
        ("Bonus 1:2", 2, 3),   # 1 new per 2 held -> 3 for 2
        ("Bonus 3:1", 1, 4),   # 3 new per 1 held -> 4 for 1
        ("Bonus 2:5", 5, 7),
    ])
    def test_ratio(self, subject, num, den):
        assert classify(subject) == ("bonus", num, den)


class TestSplit:
    @pytest.mark.parametrize("subject,num,den", [
        ("Face Value Split (Sub-Division) - From Rs 10/- Per Share To Re 1/- Per Share", 1, 10),
        ("Face Value Split (Sub-Division) - From Rs 10/- Per Share To Rs 2/- Per Share", 1, 5),
        ("Face Value Split (Sub-Division) - From Rs 5/- Per Share To Re 2/- Per Share", 2, 5),
    ])
    def test_ratio(self, subject, num, den):
        assert classify(subject) == ("split", num, den)

    def test_re_and_rs_both_accepted(self):
        """NSE writes 'Re' for one rupee and 'Rs' otherwise; both are the same field."""
        assert classify("From Re 1/- Per Share To Rs 10/- Per Share")[0] == "split"


class TestUnparseable:
    @pytest.mark.parametrize("subject", [
        "Demerger", "Dividend - Rs 5 Per Share", "Annual General Meeting",
        "Rights 1:4 @ Premium", "", "Interest Payment",
    ])
    def test_no_factor_invented(self, subject):
        """An action we cannot price must never contribute a silent factor."""
        kind, num, den = classify(subject)
        assert kind == "other"
        assert (num, den) == (1, 1)


class TestAdjustmentRows:
    def _action(self, kind, num, den):
        return CorporateAction("RELIANCE", "INE002A01018", date(2024, 6, 1), kind, num, den, "x")

    def test_only_price_affecting_actions_enter_the_table(self):
        actions = [self._action("split", 1, 10), self._action("bonus", 1, 2),
                   self._action("other", 1, 1)]
        rows = to_adjustment_rows(actions)
        assert len(rows) == 2
        assert {r["kind"] for r in rows} == {"split", "bonus"}

    def test_effective_timestamp_is_the_ex_date(self):
        rows = to_adjustment_rows([self._action("split", 1, 10)])
        from datetime import datetime, timezone
        moment = datetime.fromtimestamp(rows[0]["effective_ts_utc"] / 1e6, tz=timezone.utc)
        assert moment.date() == date(2024, 6, 1)

    def test_source_is_recorded(self):
        rows = to_adjustment_rows([self._action("bonus", 1, 2)])
        assert rows[0]["source"] == "nse_corporate_actions_api"


class TestParseReport:
    def test_counts_and_retains_unparsed(self):
        rows = [
            {"symbol": "A", "isin": "I1", "exDate": "01-Jun-2024", "subject": "Bonus 1:1"},
            {"symbol": "B", "isin": "I2", "exDate": "02-Jun-2024", "subject": "Demerger"},
            {"symbol": "C", "isin": "I3", "exDate": "bad-date", "subject": "Bonus 1:1"},
        ]
        actions, report = parse(rows)
        assert len(actions) == 2, "unparseable ex-date must be dropped, not guessed"
        assert report.parsed == {"bonus": 1, "other": 1}
        assert "Demerger" in report.unparsed_subjects
