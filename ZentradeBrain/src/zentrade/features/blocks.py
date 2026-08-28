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


ACTIVE = "active"
REJECTED = "rejected"


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
    """Raised when a block that failed its ablation is put into a live schema."""

ALL_BLOCKS = {BASE_BLOCK_NAME: BASE_BLOCK, RELATIVE_STRENGTH_NAME: RELATIVE_STRENGTH_BLOCK}


def active_blocks() -> tuple[str, ...]:
    return tuple(name for name, block in ALL_BLOCKS.items() if block.status == ACTIVE)


def require_active(blocks: tuple[str, ...]) -> None:
    """A block that failed its ablation may still be measured, but it may not."""
    rejected = [b for b in blocks if ALL_BLOCKS[b].status == REJECTED]
    if rejected:
        details = "; ".join(f"{b}: {ALL_BLOCKS[b].verdict}" for b in rejected)
        raise RejectedBlock(f"rejected block(s) in an active schema -> {details}")


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
