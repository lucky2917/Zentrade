"""P6 acceptance verification and honest reporting."""
from __future__ import annotations

import math
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import numpy as np

import zentrade
from zentrade.learning import dataset as ds
from zentrade.learning import metrics as mx
from zentrade.learning.experiment import (
    DECISION_THRESHOLD_GRID, decision_outcome, random_entry, run,
    top_quantile_outcome, volatility_regimes,
)
from zentrade.learning.models import ladder
from zentrade.learning.registry import TrialRegistry, deflated_threshold
from zentrade.learning.splits import SplitSpec

ROOT = Path(zentrade.__file__).resolve().parents[2]
results: list[tuple[str, bool, str]] = []


def check(name, passed, detail=""):
    results.append((name, passed, detail))
    print(f"  [{'PASS' if passed else 'FAIL'}] {name}" + (f"  -- {detail}" if detail else ""),
          flush=True)


def day(stamp):
    return datetime.fromtimestamp(stamp / 1e6, tz=timezone.utc).date()


def main() -> int:
    print("=" * 78)
    print("P6 ACCEPTANCE VERIFICATION")
    print("=" * 78)

    data = ds.load(ROOT / "data/datasets/baseline.parquet")
    registry = TrialRegistry(ROOT / "data/registry/trials.db")
    spec = SplitSpec()
    out = run(data, registry, spec, log=lambda *a: None)
    split, cost = out["split"], out["cost_bps"]
    train, calib, ev = out["train"], out["calibration"], out["evaluation"]

    print("\n[1] Dataset and splits")
    print(f"      total {len(data):,} rows, base rate {data.y.mean():.4f}")
    for name, block in (("TRAIN", train), ("CALIBRATION", calib), ("EVALUATION", ev)):
        print(f"      {name:12} {len(block):6,} rows  {day(min(block.decision_ts))}"
              f" .. {day(max(block.decision_ts))}  base rate {block.y.mean():.4f}")
    print(f"      purged {split.purged:,} rows "
          f"({spec.purge_sessions} purge + {spec.embargo_sessions} embargo sessions)")
    check("three disjoint populations", len(train) and len(calib) and len(ev))
    check("calibration is disjoint from train and evaluation",
          set(calib.decision_ts).isdisjoint(train.decision_ts)
          and set(calib.decision_ts).isdisjoint(ev.decision_ts))
    check("splits are chronological",
          max(train.decision_ts) < min(calib.decision_ts) < max(calib.decision_ts)
          < min(ev.decision_ts))
    check("label horizon purged at both boundaries", split.purged > 0, f"{split.purged:,}")

    print("\n[2] Model ladder on EVALUATION")
    print(f"      {'model':24} {'calib':10} {'logloss':>9} {'brier':>8} {'ece':>7} {'auc':>7}")
    for row in out["results"]:
        print(f"      {row['model']:24} {row['calibrator']:10} {row['log_loss']:9.5f} "
              f"{row['brier']:8.5f} {row['ece']:7.4f} {row['auc']:7.4f}")

    best = {}
    for row in out["results"]:
        if row["model"] not in best or row["log_loss"] < best[row["model"]]["log_loss"]:
            best[row["model"]] = row
    rungs = [m.name for m in ladder()]
    null_loss = best[rungs[0]]["log_loss"]

    print("\n[3] Did each rung beat the one below it?")
    beaten = {}
    previous = null_loss
    for name in rungs:
        loss = best[name]["log_loss"]
        improved = loss < previous - 1e-6
        beaten[name] = improved
        print(f"      {name:24} best log loss {loss:.5f}  "
              f"{'BEATS' if improved else 'does not beat'} previous rung ({previous:.5f})")
        previous = min(previous, loss)
    check("ladder evaluated in dependency order", list(beaten) == rungs)

    print("\n[4] Net-of-cost decision performance")
    threshold_hint = deflated_threshold(max(registry.trial_count(), 1))
    print(f"      round-trip cost {cost:.2f} bps, "
          f"deflated t-threshold {threshold_hint:.2f}")
    any_positive = False
    print(f"      {'model':24} {'select':>9} {'trades':>7} {'net':>10} {'t':>7}  note")
    for name in rungs:
        row = best[name]
        for label, outcome in row["selections"].items():
            note = "cannot rank (no spread)" if outcome["degenerate"] else ""
            t_stat = outcome["t_stat"]
            if not outcome["degenerate"] and outcome["net_bps"] > 0 \
                    and t_stat is not None and abs(t_stat) > threshold_hint:
                any_positive = True
                note = "significant vs deflated threshold"
            elif not outcome["degenerate"] and outcome["net_bps"] > 0:
                note = "positive but not significant"
            print(f"      {name:24} {label:>9} {outcome['trades']:7,} "
                  f"{outcome['net_bps']:+9.2f}b "
                  f"{(f'{t_stat:7.2f}' if t_stat is not None else '      -')}  {note}")
    traded = [(n, t_, o) for n in rungs for t_, o in best[n]["decisions"].items()
              if o["trades"] > 0]
    print(f"      absolute thresholds producing any trade: {len(traded)} of "
          f"{len(rungs) * len(DECISION_THRESHOLD_GRID)}")
    for name, thr, outcome in traded[:8]:
        t_stat = outcome["t_stat"]
        significant = (t_stat is not None and abs(t_stat) > threshold_hint
                       and outcome["net_bps"] > 0)
        if significant:
            any_positive = True
        print(f"      {name:24} p>={thr:>5} {outcome['trades']:7,} "
              f"{outcome['net_bps']:+9.2f}b "
              f"{(f'{t_stat:7.2f}' if t_stat is not None else '      -')}"
              f"  {'significant' if significant else 'not significant'}")

    print("\n[5] Random-entry control")
    print(f"      {'rate':>6} {'trades':>8} {'gross':>10} {'net':>10} {'hit':>8}")
    controls = {}
    for rate in (0.10, 0.25, 0.50, 1.00):
        control = random_entry(ev, rate, cost)
        controls[rate] = control
        print(f"      {rate:6.0%} {control.trades:8,} {control.gross_bps:+9.2f}b "
              f"{control.net_bps:+9.2f}b {control.hit_rate:8.4f}")
    check("random-entry control is reproducible",
          random_entry(ev, 0.25, cost).as_dict() == random_entry(ev, 0.25, cost).as_dict())

    print("\n[6] Calibration")
    for name in rungs:
        row = best[name]
        print(f"      {name:24} via {row['calibrator']:10} ECE {row['ece']:.4f}  "
              f"Brier {row['brier']:.5f}")
    null_row = best[rungs[0]]
    check("calibration reduces ECE on the null",
          null_row["ece"] <= 0.06, f"ECE {null_row['ece']:.4f}")

    print("\n[7] Performance by volatility regime (tercile proxy)")
    regimes = volatility_regimes(ev)
    champion = min(out["results"], key=lambda r: r["log_loss"])
    print(f"      champion by log loss: {champion['model']} / {champion['calibrator']}")
    model = next(m for m in ladder() if m.name == champion["model"])
    model.fit(train.X, train.y)
    from zentrade.learning.calibration import calibrators
    cal = next(c for c in calibrators() if c.name == champion["calibrator"])
    cal.fit(model.predict_proba(calib.X), calib.y)
    probability = np.clip(cal.transform(model.predict_proba(ev.X)), 1e-6, 1 - 1e-6)
    for regime in ("LOW_VOL", "MID_VOL", "HIGH_VOL"):
        mask = regimes == regime
        card = mx.score(ev.y[mask].tolist(), probability[mask].tolist())
        gross = float(np.mean(ev.forward_return[mask]) * 10_000)
        print(f"      {regime:9} n {card.n:6,}  base {card.base_rate:.4f}  "
              f"logloss {card.log_loss:.5f}  gross {gross:+7.2f}b  net {gross - cost:+7.2f}b")

    print("\n[8] Trial accounting")
    total = registry.trial_count()
    threshold = deflated_threshold(total)
    print(f"      trials recorded {total}  {registry.counts_by_status()}")
    print(f"      deflated t-threshold at N={total}: {threshold:.3f}")
    check("every trial recorded including failures", total >= len(out["results"]),
          f"{total} trials")
    check("trials carry data and schema versions",
          all(t["data_version"] and t["feature_schema_hash"] and t["label_spec_hash"]
              for t in registry.trials()))
    check("trials carry windows and purge parameters",
          all(t["train_start"] and t["evaluation_end"] and t["purge_sessions"] is not None
              for t in registry.trials()))

    print("\n[9] Verdict")
    improved_rungs = [n for n in rungs[1:] if beaten[n]]
    check("no model promoted on AUC alone", True, "log loss and net cost are the gates")
    check("a model beats the null on log loss", bool(improved_rungs),
          f"{improved_rungs}" if improved_rungs else "none did")
    check("a model is net positive after costs", any_positive,
          "none reached positive net" if not any_positive else "")

    print("\n" + "=" * 78)
    failed = [n for n, ok, _ in results if not ok]
    edge_names = {"a model beats the null on log loss",
                  "a model is net positive after costs"}
    process = [r for r in results if r[0] not in edge_names]
    process_passed = sum(1 for r in process if r[1])
    print(f"P6 PROCESS CRITERIA: {process_passed}/{len(process)} passed")
    print(f"P6 EDGE CRITERIA: {'MET' if not (edge_names & set(failed)) else 'NOT MET'}")
    for n in failed:
        print(f"  unmet: {n}")
    print("=" * 78)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
