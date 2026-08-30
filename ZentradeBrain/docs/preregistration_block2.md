# Pre-registration: Block 2, multi-timeframe alignment

Written before the block was run. Recorded so the acceptance rule cannot move
after the numbers are seen.

## Hypothesis

Sign agreement across horizons carries information that the horizon levels do
not. A linear model on levels cannot express "these horizons agree", because
agreement is a sign interaction rather than a linear combination. If v4 6.1 is
right that alignment is near-orthogonal to the levels it is derived from, the
block should improve a fitted model even though it introduces no new data.

## Features (exactly three)

    mtf_alignment    weighted mean of sign() across five horizons,
                     weights increasing with horizon, range [-1, +1]
    mtf_conflict     1.0 when the shortest horizon disagrees in sign with the
                     longest, else 0.0
    mtf_dispersion   fraction of adjacent horizon pairs that disagree

Horizons are taken from base features already present: return_1d, return_5d,
return_21d, sma20_ratio, sma50_ratio.

## Deliberately excluded

`compression_state` from v4 6.2 is NOT added. The base block already carries
`vol_compression` as the 20/60 realised volatility ratio. Adding it would
duplicate an existing feature, which the anti-duplication rule forbids.

`htf_level_distance` is NOT added. The base block already carries
`dist_from_252d_high` and `dist_from_252d_low`, and a further extreme-distance
feature would correlate with them rather than add a new fact.

## Acceptance rule, fixed in advance

Paired comparison: same rows, same model, same calibrator, only the feature
block differs. Per-sample log loss, paired t-statistic.

KEEP if at least one configuration improves with t greater than the deflated
threshold at the trial count reached, and no configuration is significantly
worse by more than that threshold.

REJECT otherwise. Best-arm against best-arm is not evidence and is not used.

## Data limitation, stated in advance

The spine holds daily bars only. Intraday timeframes (1m, 5m, 15m, 1h) are
unavailable because the Fyers depth probe is still blocked on an access token,
so the intraday half of v4 6 cannot be built or tested. What is tested is the
same alignment encoding across the horizons daily data supports. A negative
result therefore does not rule out intraday alignment; it rules out daily
horizon alignment only.

## No holdout access

The frozen holdout 2025-08-05 to 2026-08-25 is not read by this experiment.
