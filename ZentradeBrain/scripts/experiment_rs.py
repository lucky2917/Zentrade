"""Feature block 1: relative strength. Development window only."""
from __future__ import annotations

import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import zentrade
from zentrade.features.blocks import RELATIVE_STRENGTH_FEATURES, RELATIVE_STRENGTH_NAME
from zentrade.learning import dataset as ds
from zentrade.learning.ablation import ablate
from zentrade.learning.models import ladder
from zentrade.learning.protocol import DevelopmentProtocol, HoldoutLedger, describe
from zentrade.learning.registry import TrialRegistry, deflated_threshold

ROOT = Path(zentrade.__file__).resolve().parents[2]
day = lambda t: datetime.fromtimestamp(t / 1e6, tz=timezone.utc).date()


def main() -> int:
    print("=" * 78)
    print("FEATURE BLOCK 1: RELATIVE STRENGTH")
    print("=" * 78)
    spec = describe()
    print(f"\n  protocol {spec['protocol']}")
    print(f"  development    {spec['development']['start']} .. {spec['development']['end']}")
    print(f"  FROZEN holdout {spec['frozen_holdout']['start']} .. "
          f"{spec['frozen_holdout']['end']}  (not touched by this experiment)")

    data = ds.load(ROOT / "data/datasets/with_rs.parquet")
    registry = TrialRegistry(ROOT / "data/registry/trials.db")
    ledger = HoldoutLedger(ROOT / "data/registry/holdout_looks.jsonl")
    before = registry.trial_count()

    print(f"\n  block features: {list(RELATIVE_STRENGTH_FEATURES)}")
    out = ablate(data, RELATIVE_STRENGTH_NAME, registry)
    dev, split, cost = out["development"], out["split"], out["cost_bps"]
    validation = out["validation"]

    print(f"\n  development rows {len(dev):,}  (holdout rows excluded: "
          f"{len(data) - len(dev):,})")
    print(f"  dev-train {len(split.train):,}  dev-calibration {len(split.calibration):,}"
          f"  dev-validation {len(split.evaluation):,}  purged {split.purged:,}")
    print(f"  dev-validation window {day(min(validation.decision_ts))} .. "
          f"{day(max(validation.decision_ts))}  base rate {validation.y.mean():.4f}")
    print(f"  round-trip cost {cost:.2f} bps")

    print("\n  ABLATION on dev-validation")
    print(f"  {'model':22} {'calib':10} {'without RS':>11} {'with RS':>10} {'delta':>10}")
    rung_names = [m.name for m in ladder()]
    without = {(r["model"], r["calibrator"]): r for r in out["without"].rows}
    withrs = {(r["model"], r["calibrator"]): r for r in out["with_block"].rows}
    improved = 0
    total = 0
    for name in rung_names:
        for calibrator in ("identity", "platt", "isotonic"):
            key = (name, calibrator)
            if key not in without or key not in withrs:
                continue
            a, b = without[key]["log_loss"], withrs[key]["log_loss"]
            total += 1
            if b < a - 1e-6:
                improved += 1
            print(f"  {name:22} {calibrator:10} {a:11.5f} {b:10.5f} {b - a:+10.5f}")

    best_a, best_b = out["without"].best(), out["with_block"].best()
    print(f"\n  best without RS : {best_a['model']}/{best_a['calibrator']} "
          f"log loss {best_a['log_loss']:.5f}  ECE {best_a['ece']:.4f}  AUC {best_a['auc']:.4f}")
    print(f"  best with RS    : {best_b['model']}/{best_b['calibrator']} "
          f"log loss {best_b['log_loss']:.5f}  ECE {best_b['ece']:.4f}  AUC {best_b['auc']:.4f}")
    print(f"  configurations improved by RS: {improved}/{total}")

    print(f"\n  cost-adjusted selection on dev-validation (threshold {deflated_threshold(registry.trial_count()):.2f})")
    print(f"  {'arm':10} {'model':22} {'select':>9} {'net':>10} {'t':>7}  note")
    for label, arm in (("without", out["without"]), ("with", out["with_block"])):
        row = arm.best()
        for name, outcome in row["selections"].items():
            note = "cannot rank" if outcome["degenerate"] else ""
            t_stat = outcome["t_stat"]
            print(f"  {label:10} {row['model']:22} {name:>9} "
                  f"{outcome['net_bps']:+9.2f}b "
                  f"{(f'{t_stat:7.2f}' if t_stat is not None else '      -')}  {note}")

    print("\n  controls on the same dev-validation population")
    for rate, control in out["controls"].items():
        print(f"    random {rate:5.0%}  trades {control.trades:6,}  "
              f"net {control.net_bps:+8.2f}b  t {control.t_stat:6.2f}")

    added = registry.trial_count() - before
    print(f"\n  trials this experiment {added}  cumulative {registry.trial_count()}")
    print(f"  deflated t-threshold now {deflated_threshold(registry.trial_count()):.3f}")
    print(f"  holdout looks recorded: {ledger.count()}  (must remain 0 during development)")

    threshold = deflated_threshold(registry.trial_count())
    print("\n  PAIRED like-for-like test (same model, same calibrator, same rows)")
    print(f"  {'model':22} {'calib':10} {'mean improvement':>18} {'t':>8}  verdict")
    significant = []
    for (model_name, calibrator), stats in sorted(out["paired"].items()):
        passes = stats["t_stat"] > threshold
        if passes:
            significant.append((model_name, calibrator))
        print(f"  {model_name:22} {calibrator:10} {stats['mean_improvement']:+18.6f} "
              f"{stats['t_stat']:8.2f}  {'significant' if passes else 'not significant'}")

    print("\n" + "=" * 78)
    if significant:
        print(f"BLOCK VERDICT: KEEP   {len(significant)}/{len(out['paired'])} "
              f"configurations improve significantly at t>{threshold:.2f}")
        for name in significant:
            print(f"    {name[0]}/{name[1]}")
    else:
        print(f"BLOCK VERDICT: REMOVE   0/{len(out['paired'])} configurations improve "
              f"significantly at t>{threshold:.2f}")
        print("  relative strength does not add incremental information over the")
        print("  baseline on the development validation window")
    print("=" * 78)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
