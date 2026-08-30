# Pre-registration: Block 4, market context

Written before the block was run.

## Why this block needs a different test

Market-context features take ONE value per day, shared by every symbol
evaluated that day. Treating 68,720 rows as independent observations of a
feature that only varies 750 times is the specific error v4 0.1 and 4 warn
about: it inflates the t-statistic by roughly the square root of the design
effect and makes a market feature look significant when it is not.

Every previous block was symbol-level, so a per-row paired test was correct.
This one is not, and the same test would be wrong.

**Inference for this block is clustered by day.** The paired improvement is
averaged within each session first, and the t-statistic is computed across
session means. The effective sample is the number of trading days in
dev-validation, not the number of rows.

## Hypothesis

Whether a setup works depends on what the market is doing around it. The base
block is entirely symbol-absolute and carries no information about the state
of the universe on that session.

## Features (exactly three)

    breadth_above_ma20     fraction of the evaluated universe trading above
                           its own 20-day average
    breadth_advancing      fraction of the universe with a positive 1-day return
    cross_sectional_disp   standard deviation of 21-day returns across the
                           universe, a dispersion rather than a direction

Three, not more. v4 4 budgets the market block at 3 features against a 250
observation per year ceiling, and the development window carries roughly 750
trading days.

## Deliberately excluded

Index trend and momentum are NOT added. The spine holds no index series, and a
universe-average return would duplicate breadth_advancing rather than add a
second fact.

Risk-on/risk-off is NOT added. v4 5.2 names it explicitly as a linear
combination of breadth and volatility, so it would fail the anti-duplication
rule by construction.

Market liquidity state is NOT added. It needs spread or turnover, neither of
which is in the frozen bar schema.

## Acceptance rule, fixed in advance

Paired comparison: same rows, same model, same calibrator, only the block
differs. Per-sample log loss averaged within each session, then a t-statistic
across session means.

KEEP if at least one configuration improves with a DAY-CLUSTERED t above the
deflated threshold at the trial count reached, and none is significantly worse.
REJECT otherwise.

The unclustered t will also be reported, purely to show the size of the
inflation the clustering removes. It is not the acceptance rule.

Anti-duplication is checked before the ablation, not after. Any feature
correlating above 0.80 with an existing feature is reported as a breach
regardless of what the ablation says, since that is what settled block 3.

## No holdout access

The frozen holdout 2025-08-05 to 2026-08-25 is not read. The observation that
ranking beats random while net economics stay negative is not used to select
or tune anything here.
