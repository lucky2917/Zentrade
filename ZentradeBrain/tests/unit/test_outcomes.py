"""The frozen labeling law."""
import pytest

from zentrade.learning.outcomes import Bar, Outcome, forward_return, is_final, label_path

ENTRY, TARGET, STOP = 100_00, 110_00, 90_00


def bar(ts, o, h, l, c):
    return Bar(ts, o, h, l, c)


def run(path, horizon=5):
    return label_path(path, entry=ENTRY, target=TARGET, stop=STOP, horizon_sessions=horizon)


class TestPathHits:
    def test_target_hit_intrabar(self):
        result = run([bar(1, 100_00, 111_00, 99_00, 110_50)])
        assert result.outcome is Outcome.TARGET
        assert result.exit_price == TARGET

    def test_stop_hit_intrabar(self):
        result = run([bar(1, 100_00, 101_00, 89_00, 90_50)])
        assert result.outcome is Outcome.STOP
        assert result.exit_price == STOP

    def test_first_hit_wins_across_sessions(self):
        path = [bar(1, 100_00, 101_00, 99_00, 100_00), bar(2, 100_00, 111_00, 99_00, 110_00)]
        result = run(path)
        assert result.outcome is Outcome.TARGET
        assert result.sessions_to_resolve == 2


class TestAmbiguity:
    def test_bar_touching_both_resolves_to_stop(self):
        """Daily bars cannot order intrabar events. Assuming the favourable."""
        assert run([bar(1, 100_00, 111_00, 89_00, 100_00)]).outcome is Outcome.STOP

    def test_open_through_both_resolves_to_stop(self):
        result = label_path([bar(1, 95_00, 120_00, 80_00, 95_00)],
                            entry=ENTRY, target=90_00, stop=100_00, horizon_sessions=5)
        assert result.outcome is Outcome.STOP


class TestGaps:
    def test_gap_through_target_fills_at_the_open(self):
        result = run([bar(1, 115_00, 116_00, 114_00, 115_00)])
        assert result.outcome is Outcome.TARGET
        assert result.exit_price == 115_00, "a gap fills at the open, not the level"

    def test_gap_through_stop_fills_at_the_open(self):
        result = run([bar(1, 85_00, 86_00, 84_00, 85_00)])
        assert result.outcome is Outcome.STOP
        assert result.exit_price == 85_00


class TestHorizon:
    def test_no_hit_within_horizon_is_close_basis(self):
        path = [bar(i, 100_00, 101_00, 99_00, 100_50) for i in range(1, 6)]
        result = run(path, horizon=5)
        assert result.outcome is Outcome.NEITHER
        assert result.exit_price == 100_50
        assert result.sessions_to_resolve == 5

    def test_short_path_is_pending_never_guessed(self):
        path = [bar(i, 100_00, 101_00, 99_00, 100_00) for i in range(1, 4)]
        result = run(path, horizon=5)
        assert result.outcome is Outcome.PENDING
        assert result.exit_price is None
        assert not is_final(result.outcome)

    def test_bars_past_the_horizon_are_ignored(self):
        path = [bar(i, 100_00, 101_00, 99_00, 100_00) for i in range(1, 6)]
        path.append(bar(6, 100_00, 999_00, 99_00, 500_00))
        assert run(path, horizon=5).outcome is Outcome.NEITHER

    def test_zero_horizon_rejected(self):
        with pytest.raises(ValueError):
            run([bar(1, 100_00, 101_00, 99_00, 100_00)], horizon=0)


class TestExcursions:
    def test_favourable_and_adverse_measured_to_resolution(self):
        path = [bar(1, 100_00, 105_00, 97_00, 104_00), bar(2, 104_00, 111_00, 103_00, 110_00)]
        result = run(path)
        assert result.max_favourable == 111_00 - ENTRY
        assert result.max_adverse == 97_00 - ENTRY


class TestForwardReturn:
    def test_return_from_entry_to_exit(self):
        assert forward_return(100_00, 110_00) == pytest.approx(0.10)

    def test_pending_has_no_return(self):
        assert forward_return(100_00, None) is None
