# Pre-registration: Block 3, trade location

Written before the block was run.

## Hypothesis

Distance measured in percent is not distance as a trader experiences it. Five
percent above a moving average is an extended position in a quiet name and
noise in a volatile one. Normalising existing distance features by the
symbol's own ATR should therefore carry information the percent versions do
not, and a linear model cannot recover it because a ratio is not a weighted
sum of its parts.

This is v4 2.2's "trade location" and "chasing distance": how far price has
already travelled, in the units that matter for that instrument.

## Features (exactly three)

    extension_atr_20    (close vs SMA20) expressed in ATR units
    extension_atr_50    (close vs SMA50) expressed in ATR units
    high_distance_atr   distance below the 252-day high, in ATR units

Each is an existing percent distance divided by atr14_pct. Guarded against a
degenerate ATR: where ATR is at or below zero the feature is undefined and the
row is dropped rather than imputed.

## Deliberately excluded, with reasons

`distance_from_trigger` and `time_since_trigger` require a trigger level,
which requires setup typing. That is a later block and inventing a trigger
here would test a construct rather than a feature.

`distance_from_vwap` requires daily VWAP. The bhavcopy carries traded value
and traded quantity, whose ratio is exactly that, but spine_v1's bar schema is
frozen without a turnover column. Adding one is a spine_v2 change and is not
in scope for a feature ablation.

`time_since_catalyst` requires the Event Store, which is not built.

`session_phase` requires intraday timestamps, which the spine does not hold.

## Acceptance rule, fixed in advance

Paired comparison: same rows, same model, same calibrator, only the block
differs. Per-sample log loss, paired t-statistic.

KEEP if at least one configuration improves with t above the deflated
threshold at the trial count reached, and none is significantly worse by more
than that threshold. REJECT otherwise. Best-arm against best-arm is not
evidence.

The threshold will be higher than block 2's 2.86 because the trial count rises
again. That is intended.

## No holdout access

The frozen holdout 2025-08-05 to 2026-08-25 is not read by this experiment.
The separate observation that ranking beats random while net economics stay
negative is not used to select or tune anything here.
