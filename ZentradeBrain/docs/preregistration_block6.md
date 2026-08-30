# Pre-registration: Block 6, contradiction features

Written before the block was run.

## Control arm

The control is the LIVE active schema, symbol_technical plus setup_typing v1,
19 features. Comparing against base-only would credit this block with gains
setup_typing is already delivering.

## Hypothesis

v4 10.2 rejected an adversarial counter-thesis LAYER on the grounds that a
fitted model already weighs both sides. What it kept was contradiction
FEATURES: cases where the negation is not already linear in an existing
feature. A conjunction of opposing signals is exactly that, since a linear
model cannot represent "strong on one axis while weak on another".

## Features (exactly three)

    unconfirmed_strength      near the 52-week high AND volume below 0.8x:
                              making highs on fading participation
    momentum_divergence       near the 52-week high AND 21-day return negative:
                              price holding up while momentum has already gone
    volume_without_progress   volume above 1.5x AND 5-day move under 1%:
                              heavy trade with nothing to show for it

## Deliberately excluded, with reasons

`htf_conflict` is NOT re-tested. It was part of block 2, which was rejected.
Re-running a rejected feature inside a new block would launder it past its own
result.

`catalyst_priced_in` needs the Event Store, which is not built.

`sector_divergence` needs a sector map, which the spine does not hold.

## Acceptance rule, fixed in advance

Contradiction features are symbol-level, so the per-row paired test applies and
clustered inference is neither required nor used.

Paired comparison against the active schema: same rows, same model, same
calibrator, only the block differs. KEEP if at least one configuration
improves with t above the deflated threshold at the trial count reached, and
none is significantly worse.

Anti-duplication checked BEFORE the ablation, ceiling 0.80. That includes
correlation against the setup_typing indicators, not only the base features,
because setup_typing is now part of the schema and `unconfirmed_strength`
plausibly overlaps `breakout` and `momentum_exhaustion`.

## Not combined with anything

setup_typing is in the control arm, not tested jointly. This block is
contradiction features alone.

## No holdout access

The frozen holdout 2025-08-05 to 2026-08-25 is not read. The standing
observation about negative net economics is not used to tune anything here.
