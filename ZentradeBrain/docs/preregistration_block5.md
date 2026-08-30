# Pre-registration: Block 5, setup typing

Written before the block was run.

## Hypothesis

The base features describe a symbol's state continuously. They do not say what
KIND of situation it is. A breakout on expanding volume and a failed breakout
sit in similar regions of several base features while being opposite trades.
A conjunction of conditions is not a weighted sum of them, so a logistic model
cannot construct these categories from the levels.

## Taxonomy: seven types, mutually exclusive

v4 8.1 caps the taxonomy at eight on sample-size grounds. `event_driven`, the
eighth, requires the Event Store and is NOT built, so seven are defined.

Priority order resolves overlap so every row receives exactly one type, which
is what makes the per-type sample counts meaningful:

    1 failed_breakout      near the 52w high AND a sharp 5-day reversal
    2 breakout             within 2% of the 52w high AND volume above 1.2x
    3 breakdown            within 2% of the 52w low  AND volume above 1.2x
    4 momentum_exhaustion  21-day gain above 10% AND volume below 0.8x
    5 pullback_in_trend    above the 50-day MA, below the 20-day, 5-day down
    6 mean_reversion       more than 8% below the 20-day MA AND turning up
    7 volatility_expansion short vol above 1.3x long vol
    - none                 matches nothing; the reference category

Every condition reads a base feature already in the schema, so the block adds
no new data and is PIT-safe by construction.

## Feature representation

Seven binary indicators, one per named type. `none` is the reference level and
gets no column, so the encoding is not collinear by construction.

## Acceptance rule, fixed in advance

Setup type is symbol-level: it varies per row, not per session, so the
existing per-row paired test applies. Clustered inference is not required
here and is not used.

Paired comparison: same rows, same model, same calibrator, only the block
differs. KEEP if at least one configuration improves with t above the deflated
threshold at the trial count reached, and none is significantly worse.

Anti-duplication is checked BEFORE the ablation. Any indicator correlating
above 0.80 with an existing feature is reported as a breach regardless of the
ablation result, as with block 3.

Any type holding fewer than 200 rows in dev-train is reported as sparse and
its coefficient treated as unsupported, per v4 8.1's reasoning that a
confidence interval wider than the effect is not evidence.

## Not combined with anything

Contradiction features are not included. This block is setup typing alone.

## No holdout access

The frozen holdout 2025-08-05 to 2026-08-25 is not read. The standing
observation that ranking beats random while net economics stay negative is not
used to select or tune anything here.
