"""Historical replay over the canonical engine.

The digest covers decision content only: as_of, schema, symbol and feature
values. sessions_available is diagnostic metadata that reflects how much
history a source happened to return, so including it would make two adapters
that agree on every feature look divergent.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Iterator, Sequence
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone

from ..adapters.data.pit import PitDataSource
from ..features.engine import FeatureSnapshot, compute_features
from ..features.schema import FEATURE_NAMES, schema_hash

DIGEST_PRECISION = 10


def session_timestamps(start: date, end: date, hour: int = 0) -> tuple[int, ...]:
    """Weekday as_of stamps. Non-trading days yield empty snapshots rather than."""
    stamps = []
    day = start
    while day <= end:
        if day.weekday() < 5:
            stamps.append(int(datetime(day.year, day.month, day.day, hour,
                                       tzinfo=timezone.utc).timestamp() * 1_000_000))
        day += timedelta(days=1)
    return tuple(stamps)


@dataclass(frozen=True)
class ReplayResult:
    snapshots: tuple[FeatureSnapshot, ...]
    schema_hash: str

    def __len__(self) -> int:
        return len(self.snapshots)

    @property
    def rows(self) -> int:
        return sum(len(snapshot) for snapshot in self.snapshots)


def replay(source: PitDataSource, as_of_sequence: Sequence[int],
           symbols: list[str] | None = None) -> Iterator[FeatureSnapshot]:
    for as_of in as_of_sequence:
        yield compute_features(source, as_of=as_of, symbols=symbols)


def run_replay(source: PitDataSource, as_of_sequence: Sequence[int],
               symbols: list[str] | None = None) -> ReplayResult:
    snapshots = tuple(replay(source, as_of_sequence, symbols))
    return ReplayResult(snapshots=snapshots, schema_hash=schema_hash())


def _roundable(value: float | None) -> float | str | None:
    if value is None:
        return None
    return round(value, DIGEST_PRECISION)


def snapshot_digest(snapshot: FeatureSnapshot) -> str:
    payload = {
        "as_of": snapshot.as_of,
        "schema": snapshot.schema_hash,
        "rows": [
            [row.symbol, [_roundable(value) for value in row.values]]
            for row in snapshot.rows
        ],
    }
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def replay_digest(result: ReplayResult) -> str:
    combined = hashlib.sha256()
    combined.update(result.schema_hash.encode("utf-8"))
    for snapshot in result.snapshots:
        combined.update(snapshot_digest(snapshot).encode("utf-8"))
    return combined.hexdigest()


def to_records(result: ReplayResult) -> list[dict]:
    records = []
    for snapshot in result.snapshots:
        for row in snapshot.rows:
            record = {"as_of": snapshot.as_of, "symbol": row.symbol,
                      "sessions_available": row.sessions_available}
            record.update(row.as_dict())
            records.append(record)
    return records
