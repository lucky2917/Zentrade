"""Frozen feature schema and its version hash."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass

FEATURE_SEMANTICS = "features_v1"

MIN_HISTORY_SESSIONS = 252

FEATURE_NAMES: tuple[str, ...] = (
    "return_1d",
    "return_5d",
    "return_21d",
    "sma20_ratio",
    "sma50_ratio",
    "realized_vol_20d",
    "vol_compression",
    "atr14_pct",
    "range_position",
    "volume_ratio_20d",
    "dist_from_252d_high",
    "dist_from_252d_low",
)

FEATURE_BLOCK = "symbol_technical"


class SchemaMismatch(RuntimeError):
    """Raised when an artifact was fitted against a different feature schema."""

    def __init__(self, expected: str, actual: str) -> None:
        super().__init__(
            f"feature schema mismatch: artifact expects {expected}, engine produces {actual}"
        )
        self.expected = expected
        self.actual = actual


def _canonical() -> str:
    return json.dumps(
        {
            "semantics": FEATURE_SEMANTICS,
            "block": FEATURE_BLOCK,
            "features": list(FEATURE_NAMES),
            "min_history_sessions": MIN_HISTORY_SESSIONS,
        },
        sort_keys=True,
        separators=(",", ":"),
    )


def schema_hash() -> str:
    return hashlib.sha256(_canonical().encode("utf-8")).hexdigest()


def require_schema(expected_hash: str) -> None:
    """Fail closed when an artifact does not match the current schema."""
    actual = schema_hash()
    if expected_hash != actual:
        raise SchemaMismatch(expected_hash, actual)


@dataclass(frozen=True)
class SchemaDescriptor:
    semantics: str
    block: str
    features: tuple[str, ...]
    hash: str

    @classmethod
    def current(cls) -> SchemaDescriptor:
        return cls(FEATURE_SEMANTICS, FEATURE_BLOCK, FEATURE_NAMES, schema_hash())
