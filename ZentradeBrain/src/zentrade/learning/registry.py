"""Model and trial registry. Every run is recorded, including the ones that failed."""

from __future__ import annotations

import hashlib
import json
import sqlite3
from dataclasses import asdict, dataclass, field
from pathlib import Path

from ..kernel.clock import SystemClock

REGISTRY_VERSION = "registry_v1"

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS trials (
    trial_id TEXT PRIMARY KEY,
    recorded_at TEXT NOT NULL,
    model_name TEXT NOT NULL,
    calibrator TEXT NOT NULL,
    status TEXT NOT NULL,
    data_version TEXT NOT NULL,
    feature_schema_hash TEXT NOT NULL,
    label_spec_hash TEXT NOT NULL,
    train_start INTEGER, train_end INTEGER,
    calibration_start INTEGER, calibration_end INTEGER,
    evaluation_start INTEGER, evaluation_end INTEGER,
    purge_sessions INTEGER NOT NULL,
    embargo_sessions INTEGER NOT NULL,
    n_train INTEGER, n_calibration INTEGER, n_evaluation INTEGER, n_purged INTEGER,
    hyperparameters TEXT NOT NULL,
    metrics TEXT NOT NULL,
    failure TEXT
);
"""


@dataclass(frozen=True)
class TrialRecord:
    model_name: str
    calibrator: str
    status: str
    data_version: str
    feature_schema_hash: str
    label_spec_hash: str
    train_start: int | None = None
    train_end: int | None = None
    calibration_start: int | None = None
    calibration_end: int | None = None
    evaluation_start: int | None = None
    evaluation_end: int | None = None
    purge_sessions: int = 0
    embargo_sessions: int = 0
    n_train: int = 0
    n_calibration: int = 0
    n_evaluation: int = 0
    n_purged: int = 0
    hyperparameters: dict = field(default_factory=dict)
    metrics: dict = field(default_factory=dict)
    failure: str | None = None

    def trial_id(self) -> str:
        payload = json.dumps(
            {k: v for k, v in asdict(self).items() if k not in ("metrics", "failure")},
            sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:24]


class TrialRegistry:
    """A trial that is not recorded is a trial you cannot charge yourself for."""

    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(str(self.path), isolation_level=None)
        self._db.row_factory = sqlite3.Row
        self._db.executescript(SCHEMA)
        self._db.execute("INSERT OR IGNORE INTO meta(key, value) VALUES ('schema', ?)",
                         (REGISTRY_VERSION,))

    def record(self, trial: TrialRecord) -> str:
        trial_id = trial.trial_id()
        self._db.execute(
            "INSERT OR REPLACE INTO trials VALUES (:trial_id,:recorded_at,:model_name,"
            ":calibrator,:status,:data_version,:feature_schema_hash,:label_spec_hash,"
            ":train_start,:train_end,:calibration_start,:calibration_end,"
            ":evaluation_start,:evaluation_end,:purge_sessions,:embargo_sessions,"
            ":n_train,:n_calibration,:n_evaluation,:n_purged,:hyperparameters,"
            ":metrics,:failure)",
            {**asdict(trial), "trial_id": trial_id,
             "recorded_at": SystemClock().now().isoformat(),
             "hyperparameters": json.dumps(trial.hyperparameters, sort_keys=True),
             "metrics": json.dumps(trial.metrics, sort_keys=True)})
        return trial_id

    def trials(self) -> list[dict]:
        rows = []
        for row in self._db.execute("SELECT * FROM trials ORDER BY recorded_at, trial_id"):
            record = dict(row)
            record["hyperparameters"] = json.loads(record["hyperparameters"])
            record["metrics"] = json.loads(record["metrics"])
            rows.append(record)
        return rows

    def trial_count(self) -> int:
        return self._db.execute("SELECT COUNT(*) FROM trials").fetchone()[0]

    def counts_by_status(self) -> dict[str, int]:
        return {row[0]: row[1] for row in self._db.execute(
            "SELECT status, COUNT(*) FROM trials GROUP BY status")}

    def close(self) -> None:
        self._db.close()


def deflated_threshold(trial_count: int) -> float:
    """How large a t-statistic a best-of-N result needs before it means."""
    import math

    if trial_count <= 1:
        return 0.0
    return math.sqrt(2.0 * math.log(trial_count))
