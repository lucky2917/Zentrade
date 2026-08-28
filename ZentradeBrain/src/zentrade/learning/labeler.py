"""Universal shadow labeling over the full decision population."""

from __future__ import annotations

import hashlib
import json
from collections import defaultdict
from dataclasses import asdict, dataclass
from pathlib import Path

from ..adapters.data.pit import PitDataSource
from ..features.indicators import average_true_range_pct
from .outcomes import (
    LABEL_SEMANTICS, Bar, Outcome, PathResult, forward_return, is_final, label_path,
)

DEFAULT_ATR_WINDOW = 14
MIN_HISTORY_FOR_ENTRY = DEFAULT_ATR_WINDOW + 1


@dataclass(frozen=True)
class LabelSpec:
    """Frozen labeling parameters. Changing any of these is a new semantics id."""

    horizon_sessions: int = 21
    target_atr_multiple: float = 2.0
    stop_atr_multiple: float = 1.0
    atr_window: int = DEFAULT_ATR_WINDOW

    def spec_hash(self) -> str:
        payload = json.dumps(
            {"semantics": LABEL_SEMANTICS, **asdict(self)},
            sort_keys=True, separators=(",", ":"),
        )
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class Label:
    symbol: str
    decision_ts: int
    entry: int
    target: int
    stop: int
    outcome: str
    resolved_ts: int | None
    sessions_to_resolve: int | None
    exit_price: int | None
    forward_return: float | None
    max_favourable: int | None
    max_adverse: int | None
    spec_hash: str

    @property
    def final(self) -> bool:
        return self.outcome != Outcome.PENDING.value


@dataclass(frozen=True)
class LabelSet:
    labels: tuple[Label, ...]
    as_of: int
    spec_hash: str

    def __len__(self) -> int:
        return len(self.labels)

    def final(self) -> tuple[Label, ...]:
        return tuple(label for label in self.labels if label.final)

    def pending(self) -> tuple[Label, ...]:
        return tuple(label for label in self.labels if not label.final)

    def counts(self) -> dict[str, int]:
        tally: dict[str, int] = defaultdict(int)
        for label in self.labels:
            tally[label.outcome] += 1
        return dict(sorted(tally.items()))


def _round_half_up(value: float) -> int:
    return int(value + 0.5) if value >= 0 else -int(-value + 0.5)


def _levels(entry: int, atr_pct: float, spec: LabelSpec) -> tuple[int, int]:
    target = _round_half_up(entry * (1.0 + spec.target_atr_multiple * atr_pct))
    stop = _round_half_up(entry * (1.0 - spec.stop_atr_multiple * atr_pct))
    return target, stop


def _bars_by_symbol(table) -> dict[str, list[Bar]]:
    columns = {name: table.column(name).to_pylist()
               for name in ("symbol", "ts_utc", "open", "high", "low", "close")}
    grouped: dict[str, list[Bar]] = defaultdict(list)
    for index in range(table.num_rows):
        grouped[columns["symbol"][index]].append(Bar(
            columns["ts_utc"][index], columns["open"][index], columns["high"][index],
            columns["low"][index], columns["close"][index],
        ))
    for bars in grouped.values():
        bars.sort(key=lambda b: b.ts_utc)
    return grouped


def label_population(
    source: PitDataSource,
    *,
    as_of: int,
    spec: LabelSpec | None = None,
    symbols: list[str] | None = None,
    lookback_sessions: int = 0,
) -> LabelSet:
    """Label every symbol on every session it traded before as_of."""
    spec = spec or LabelSpec()
    table = source.bars_before(as_of=as_of, symbols=symbols,
                               lookback_sessions=lookback_sessions)
    by_symbol = _bars_by_symbol(table)

    labels: list[Label] = []
    for symbol in sorted(by_symbol):
        bars = by_symbol[symbol]
        highs = [b.high for b in bars]
        lows = [b.low for b in bars]
        closes = [b.close for b in bars]

        for index in range(MIN_HISTORY_FOR_ENTRY, len(bars)):
            decision = bars[index]
            atr_pct = average_true_range_pct(
                highs[: index + 1], lows[: index + 1], closes[: index + 1], spec.atr_window
            )
            if atr_pct is None or atr_pct <= 0:
                continue

            entry = decision.close
            target, stop = _levels(entry, atr_pct, spec)
            if target <= entry or stop >= entry:
                continue

            result: PathResult = label_path(
                bars[index + 1:], entry=entry, target=target, stop=stop,
                horizon_sessions=spec.horizon_sessions,
            )
            labels.append(Label(
                symbol=symbol,
                decision_ts=decision.ts_utc,
                entry=entry, target=target, stop=stop,
                outcome=result.outcome.value,
                resolved_ts=result.resolved_ts,
                sessions_to_resolve=result.sessions_to_resolve,
                exit_price=result.exit_price,
                forward_return=forward_return(entry, result.exit_price),
                max_favourable=result.max_favourable,
                max_adverse=result.max_adverse,
                spec_hash=spec.spec_hash(),
            ))

    labels.sort(key=lambda label: (label.symbol, label.decision_ts))
    return LabelSet(tuple(labels), as_of=as_of, spec_hash=spec.spec_hash())


def label_digest(label_set: LabelSet) -> str:
    payload = json.dumps(
        [[l.symbol, l.decision_ts, l.entry, l.target, l.stop, l.outcome,
          l.resolved_ts, l.sessions_to_resolve, l.exit_price] for l in label_set.labels],
        separators=(",", ":"),
    )
    digest = hashlib.sha256()
    digest.update(label_set.spec_hash.encode("utf-8"))
    digest.update(payload.encode("utf-8"))
    return digest.hexdigest()
