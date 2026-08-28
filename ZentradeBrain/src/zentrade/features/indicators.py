"""Pure indicator math over ordered price series."""

from __future__ import annotations

import math

EPSILON = 1e-12


def _finite(value: float) -> float | None:
    return value if math.isfinite(value) else None


def simple_return(series: list[int], periods: int) -> float | None:
    if len(series) <= periods:
        return None
    past, latest = series[-1 - periods], series[-1]
    if past <= 0:
        return None
    return _finite(latest / past - 1.0)


def moving_average(series: list[int], window: int) -> float | None:
    if len(series) < window or window <= 0:
        return None
    return sum(series[-window:]) / window


def price_to_average_ratio(series: list[int], window: int) -> float | None:
    average = moving_average(series, window)
    if average is None or average <= EPSILON:
        return None
    return _finite(series[-1] / average - 1.0)


def log_returns(series: list[int]) -> list[float]:
    out = []
    for previous, current in zip(series, series[1:]):
        if previous > 0 and current > 0:
            out.append(math.log(current / previous))
    return out


def realized_volatility(series: list[int], window: int, periods_per_year: int = 252) -> float | None:
    returns = log_returns(series[-(window + 1):])
    if len(returns) < window:
        return None
    mean = sum(returns) / len(returns)
    variance = sum((r - mean) ** 2 for r in returns) / (len(returns) - 1)
    return _finite(math.sqrt(variance * periods_per_year))


def volatility_ratio(series: list[int], short: int, long: int) -> float | None:
    fast = realized_volatility(series, short)
    slow = realized_volatility(series, long)
    if fast is None or slow is None or slow <= EPSILON:
        return None
    return _finite(fast / slow)


def true_ranges(highs: list[int], lows: list[int], closes: list[int]) -> list[int]:
    out = []
    for index in range(1, len(closes)):
        previous_close = closes[index - 1]
        out.append(max(
            highs[index] - lows[index],
            abs(highs[index] - previous_close),
            abs(lows[index] - previous_close),
        ))
    return out


def average_true_range_pct(highs, lows, closes, window: int) -> float | None:
    ranges = true_ranges(highs, lows, closes)
    if len(ranges) < window or closes[-1] <= 0:
        return None
    return _finite((sum(ranges[-window:]) / window) / closes[-1])


def range_position(high: int, low: int, close: int) -> float | None:
    span = high - low
    if span <= 0:
        return None
    return _finite((close - low) / span)


def median(values: list[int]) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    middle = len(ordered) // 2
    if len(ordered) % 2:
        return float(ordered[middle])
    return (ordered[middle - 1] + ordered[middle]) / 2.0


def volume_ratio(volumes: list[int], window: int) -> float | None:
    if len(volumes) < window:
        return None
    baseline = median(volumes[-window:])
    if baseline is None or baseline <= EPSILON:
        return None
    return _finite(volumes[-1] / baseline)


def distance_from_extreme(series: list[int], window: int, use_high: bool) -> float | None:
    if len(series) < window:
        return None
    recent = series[-window:]
    extreme = max(recent) if use_high else min(recent)
    if extreme <= 0:
        return None
    return _finite(series[-1] / extreme - 1.0)
