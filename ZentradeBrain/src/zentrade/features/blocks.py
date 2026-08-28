"""Feature blocks. Each is added alone, measured alone, and removed if it adds nothing."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from statistics import fmean

from .schema import FEATURE_NAMES, FEATURE_SEMANTICS, MIN_HISTORY_SESSIONS

BASE_BLOCK_NAME = "symbol_technical"
RELATIVE_STRENGTH_NAME = "relative_strength"

RELATIVE_STRENGTH_FEATURES = ("rs_excess_5d", "rs_excess_21d", "rs_rank_21d")

MTF_ALIGNMENT_NAME = "mtf_alignment"
MTF_ALIGNMENT_FEATURES = ("mtf_alignment", "mtf_conflict", "mtf_dispersion")

MTF_HORIZONS = ("return_1d", "return_5d", "return_21d", "sma20_ratio", "sma50_ratio")
MTF_WEIGHTS = (1.0, 2.0, 3.0, 4.0, 5.0)

MARKET_CONTEXT_NAME = "market_context"
MARKET_CONTEXT_FEATURES = ("breadth_above_ma20", "breadth_advancing",
                           "cross_sectional_disp")
MIN_UNIVERSE_FOR_BREADTH = 10

TRADE_LOCATION_NAME = "trade_location"
TRADE_LOCATION_FEATURES = ("extension_atr_20", "extension_atr_50", "high_distance_atr")
MIN_ATR_PCT = 1e-6


ACTIVE = "active"
REJECTED = "rejected"
PENDING = "pending_operator_decision"


@dataclass(frozen=True)
class FeatureBlock:
    name: str
    version: str
    features: tuple[str, ...]
    status: str = ACTIVE
    verdict: str = ""


BASE_BLOCK = FeatureBlock(BASE_BLOCK_NAME, "v1", FEATURE_NAMES)

RELATIVE_STRENGTH_BLOCK = FeatureBlock(
    RELATIVE_STRENGTH_NAME, "v1", RELATIVE_STRENGTH_FEATURES, status=REJECTED,
    verdict=("0 of 12 configurations improved significantly at t>2.68 on the "
             "development validation window; several were significantly worse. "
             "Retained as the record of the trial, excluded from active schemas."))


class RejectedBlock(RuntimeError):
    """Raised when a block that is not ACTIVE is put into a live schema."""

MTF_ALIGNMENT_BLOCK = FeatureBlock(
    MTF_ALIGNMENT_NAME, "v1", MTF_ALIGNMENT_FEATURES, status=REJECTED,
    verdict=("0 of 12 configurations improved significantly at t>2.86 on the "
             "development validation window; best reached t=1.77. Unlike "
             "relative strength nothing was significantly worse, so the block "
             "is harmless rather than harmful. Daily horizons only: intraday "
             "timeframes were untestable, so this rejects daily alignment and "
             "says nothing about 1m to 1h."))

TRADE_LOCATION_BLOCK = FeatureBlock(
    TRADE_LOCATION_NAME, "v1", TRADE_LOCATION_FEATURES, status=REJECTED,
    verdict=("Operator ruling 2026-08-28. Rejected on four grounds: the three "
             "features breach the frozen anti-duplication ceiling at 0.920, "
             "0.917 and 0.855 against 0.80; the incremental benefit "
             "concentrates in the poorly calibrated identity configuration; it "
             "shrinks materially under proper calibration, from 0.00098 to "
             "0.00014; and the remaining calibrated effect is too small to "
             "justify permanent schema complexity. The paired test had said "
             "KEEP at 3 of 12 significant, which the ruling overrides."))


FUTURE = "future_untested"


@dataclass(frozen=True)
class FutureVariant:
    """Recorded so a rejection of what was testable is not mistaken for a."""

    name: str
    concept: str
    blocked_on: str


TRADE_LOCATION_FUTURE = (
    FutureVariant("distance_from_trigger",
                  "how far price has travelled past the setup trigger, in ATR",
                  "setup typing, which defines a trigger level at all"),
    FutureVariant("time_since_trigger",
                  "how long since the trigger fired; intraday edge decays fast",
                  "setup typing plus intraday timestamps"),
    FutureVariant("distance_from_vwap",
                  "location relative to the session volume-weighted price",
                  "a turnover column in the bar schema. The bhavcopy carries "
                  "traded value and traded quantity and their ratio is exactly "
                  "daily VWAP, so this is a spine_v2 schema change rather than "
                  "a data gap"),
    FutureVariant("time_since_catalyst",
                  "minutes since the event became public",
                  "the Event Store, which is not built"),
    FutureVariant("session_phase",
                  "open, midday and close behave differently",
                  "intraday timestamps; the spine holds daily bars only"),
)

MARKET_CONTEXT_BLOCK = FeatureBlock(
    MARKET_CONTEXT_NAME, "v1", MARKET_CONTEXT_FEATURES, status=REJECTED,
    verdict=("0 of 12 configurations improved significantly at a day-clustered "
             "t>3.06. The block passed the anti-duplication gate cleanly at "
             "0.446, so this is a rejection on evidence rather than on "
             "redundancy. The result that matters is the inflation: raw "
             "per-row t reached 4.46 and 4.41, comfortably over the threshold, "
             "while the clustered values were 0.98 and 0.97. Treating 14,350 "
             "rows as independent observations of a feature that varies 161 "
             "times would have promoted noise."))

ALL_BLOCKS = {BASE_BLOCK_NAME: BASE_BLOCK,
              RELATIVE_STRENGTH_NAME: RELATIVE_STRENGTH_BLOCK,
              MTF_ALIGNMENT_NAME: MTF_ALIGNMENT_BLOCK,
              TRADE_LOCATION_NAME: TRADE_LOCATION_BLOCK,
              MARKET_CONTEXT_NAME: MARKET_CONTEXT_BLOCK}


def active_blocks() -> tuple[str, ...]:
    return tuple(name for name, block in ALL_BLOCKS.items() if block.status == ACTIVE)


def require_active(blocks: tuple[str, ...]) -> None:
    """Only ACTIVE blocks may run. Rejected and pending blocks stay measurable."""
    blocked = [b for b in blocks if ALL_BLOCKS[b].status != ACTIVE]
    if blocked:
        details = "; ".join(f"{b} ({ALL_BLOCKS[b].status}): {ALL_BLOCKS[b].verdict}"
                            for b in blocked)
        raise RejectedBlock(f"non-active block(s) in an active schema -> {details}")


def block_feature_names(blocks: tuple[str, ...]) -> tuple[str, ...]:
    names: list[str] = []
    for name in blocks:
        names.extend(ALL_BLOCKS[name].features)
    return tuple(names)


def schema_hash_for(blocks: tuple[str, ...]) -> str:
    """The hash covers the active block set, so a model fitted with relative."""
    if tuple(blocks) == (BASE_BLOCK_NAME,):
        from .schema import schema_hash
        return schema_hash()
    payload = json.dumps({
        "semantics": FEATURE_SEMANTICS,
        "blocks": [{"name": ALL_BLOCKS[b].name, "version": ALL_BLOCKS[b].version,
                    "features": list(ALL_BLOCKS[b].features)} for b in blocks],
        "min_history_sessions": MIN_HISTORY_SESSIONS,
    }, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


IDX_RETURN_5D = FEATURE_NAMES.index("return_5d")
IDX_RETURN_21D = FEATURE_NAMES.index("return_21d")


def _percentile_rank(value: float, population: list[float]) -> float:
    below = sum(1 for other in population if other < value)
    equal = sum(1 for other in population if other == value)
    return (below + 0.5 * equal) / len(population)


def relative_strength(snapshot) -> dict[str, tuple[float | None, ...]]:
    """Cross-sectional strength against the universe on the same session."""
    complete = [row for row in snapshot.rows if row.complete]
    if len(complete) < 5:
        return {row.symbol: (None,) * len(RELATIVE_STRENGTH_FEATURES)
                for row in snapshot.rows}

    five = [row.values[IDX_RETURN_5D] for row in complete]
    twenty_one = [row.values[IDX_RETURN_21D] for row in complete]
    mean_five, mean_21 = fmean(five), fmean(twenty_one)

    out: dict[str, tuple[float | None, ...]] = {}
    for row in snapshot.rows:
        if not row.complete:
            out[row.symbol] = (None,) * len(RELATIVE_STRENGTH_FEATURES)
            continue
        out[row.symbol] = (
            row.values[IDX_RETURN_5D] - mean_five,
            row.values[IDX_RETURN_21D] - mean_21,
            _percentile_rank(row.values[IDX_RETURN_21D], twenty_one),
        )
    return out


MTF_INDICES = tuple(FEATURE_NAMES.index(name) for name in MTF_HORIZONS)


def _sign(value: float) -> float:
    if value > 0:
        return 1.0
    if value < 0:
        return -1.0
    return 0.0


def multi_timeframe_alignment(values: tuple) -> tuple[float | None, ...]:
    """Sign agreement across horizons, which the levels themselves cannot express."""
    signs = [_sign(values[i]) for i in MTF_INDICES]

    weighted = sum(w * s for w, s in zip(MTF_WEIGHTS, signs)) / sum(MTF_WEIGHTS)
    conflict = 1.0 if signs[0] != 0 and signs[-1] != 0 and signs[0] != signs[-1] else 0.0
    pairs = list(zip(signs, signs[1:]))
    dispersion = sum(1 for a, b in pairs if a != b) / len(pairs)

    return (weighted, conflict, dispersion)


IDX_SMA20 = FEATURE_NAMES.index("sma20_ratio")
IDX_SMA50 = FEATURE_NAMES.index("sma50_ratio")
IDX_ATR = FEATURE_NAMES.index("atr14_pct")
IDX_HIGH_252 = FEATURE_NAMES.index("dist_from_252d_high")


def trade_location(values: tuple) -> tuple[float | None, ...]:
    """Existing distances re-expressed in the instrument's own volatility."""
    atr = values[IDX_ATR]
    if atr is None or atr <= MIN_ATR_PCT:
        return (None, None, None)
    return (values[IDX_SMA20] / atr, values[IDX_SMA50] / atr,
            values[IDX_HIGH_252] / atr)


IDX_RETURN_1D = FEATURE_NAMES.index("return_1d")


def market_context(snapshot) -> tuple[float | None, ...]:
    """State of the universe on this session. One value shared by every symbol."""
    complete = [row for row in snapshot.rows if row.complete]
    if len(complete) < MIN_UNIVERSE_FOR_BREADTH:
        return (None, None, None)

    above = sum(1 for row in complete if row.values[IDX_SMA20] > 0) / len(complete)
    advancing = sum(1 for row in complete if row.values[IDX_RETURN_1D] > 0) / len(complete)

    twenty_one = [row.values[IDX_RETURN_21D] for row in complete]
    mean = fmean(twenty_one)
    variance = sum((value - mean) ** 2 for value in twenty_one) / (len(twenty_one) - 1)
    return (above, advancing, variance ** 0.5)
