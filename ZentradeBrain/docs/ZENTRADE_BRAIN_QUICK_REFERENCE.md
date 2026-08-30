# ZenTrade Brain — Quick Reference

Companion to `ZENTRADE_BRAIN_ARCHITECTURE.md`. Repository state 2026-08-29.

## One line

A local research system that tests whether a rule-bound trading process beats
real costs on NSE equities, built so it cannot fool itself.

## Architecture

    DATA -> SPINE -> PIT -> FEATURES -> SETUP -> MODEL -> CALIBRATION
         -> DECISION -> RISK -> EXECUTION -> PAPER -> EVALUATION -> LEARNING

## Active

| Component | Status |
|---|---|
| spine_v2 (1d, 1m, 5m, 15m) | DONE |
| PIT layer, `as_of` exclusive | DONE |
| `symbol_technical` v1 — 12 features | ACTIVE |
| `setup_typing` v1 — 7 features | ACTIVE |
| Triple-barrier labeling | DONE |
| Calibration (identity, Platt, isotonic) | DONE |
| Paper execution + full Indian costs | DONE |
| Risk core, limits, kill switch | DONE |
| SQLite WAL persistence | DONE |
| Deterministic replay | DONE |
| Frozen holdout protocol | DONE |

## Rejected

| Block | Result |
|---|---|
| `relative_strength` v1 | 0/12 at t>2.68; several significantly worse |
| `mtf_alignment` v1 | 0/12 at t>2.86, best 1.77. **Daily only** — says nothing about intraday |
| `trade_location` v1 | Paired test KEEP, but correlations 0.920/0.917/0.855 vs 0.80 ceiling |
| `market_context` v1 | raw t=4.46 collapsed to clustered t=0.98 |
| `contradiction` v1 | 0/12 at t>3.178, best 2.55 |

## In progress

Intraday verification: **15 pass, 2 fail**, unresolved.
1. 13,194 short 1m sessions — invariant under test, not yet concluded
2. 4 session gaps — 2 explained by rename boundaries, 2 genuine provider gaps
   (HSCL 2024-01-09, NETWEB 2024-02-01)

## Planned — not built

Session phase · trigger timing · intraday MTF · intraday VWAP · intraday
liquidity · Event Store · sector indices · named CAUTIOUS/DEGRADED states ·
fitted OOD detector

Not possible: **order flow** — does not exist at this access level.

## Key numbers

| | |
|---|---|
| Round-trip cost | **73.55 bps** |
| Mean gross forward move | ~30 bps |
| Random entry, net | **-44 bps** |
| Active features | 19 |
| Schema hash | `f1a55535a4c02540...` |
| Trials | **156** |
| Deflated threshold | **3.178** |
| Holdout looks | **0** |
| Daily rows | 2,778,160 (3,505 symbols, 1,296 sessions) |
| Intraday rows | 96,088,426 (100 symbols, 2,263 sessions) |
| Intraday span | 2017-07-03 .. 2026-08-28 |
| Backfill | 10,200 chunks, 9,840 requests, **0 failed** |
| Base rates | TRAIN 0.4162 / CAL 0.3132 / EVAL 0.3588 |
| Tests | 552 Python + 46 JS + 4 arch guards |
| Acceptance | P1 20/20, P2 11/11, P3 16/16, P4 30/30, P5 55/55, P6 11/11 |

## Session boundaries

| | bars/session | last valid stamp |
|---|---|---|
| 1m | 375 | 15:29 |
| 5m | 75 | 15:25 |
| 15m | 25 | 15:15 |

## Status in one sentence

The apparatus is built and tested; **no profitable edge has been demonstrated,
and the holdout has never been opened.**

## Biggest lessons

1. **Rejection is the product.** Five of six blocks rejected. Block 4 looked
   significant at t=4.46 and was noise.
2. **Costs decide first.** 73.55 bps exceeds the ~30 bps mean gross move.
3. **Guards must be mechanical.** The author of the PIT layer bypassed it.
4. **Test your guards by attacking them.** The wall-clock guard missed
   `datetime.datetime.now()` until a violation was deliberately injected.
5. **Two checks sharing a wrong constant agree with each other.** The 15:30
   bug passed the out-of-session check.
6. **A sample cannot prove a path it never exercises.** Zero duplicates in the
   30-day sample; 25 in the 100-day request.
7. **Latency measured outside a stalled process says nothing.** 0.1s fresh vs
   67s stalled — the reservoir, not the provider.
8. **A diagnostic that lies is worse than none.** `over 63` was a tallying
   artifact.
9. **Verification must assert quiescence.** Reading a growing cache produced
   false failures.
10. **Search must be charged for.** The threshold rose 2.23 → 3.178, and the
    order blocks are tested in affects which clear.

## Next steps — strict order, none started

1. Resolve the short-session invariant with volume-conservation evidence
2. Re-fetch the two genuine provider gaps; record if unrecoverable
3. Complete static verification green
4. **Block A — session phase** (pre-registered, ablated against the live schema)
5. Block B — setup trigger timing
6. Block C — genuine 1m/5m/15m alignment
7. Block D — intraday VWAP
8. Block E — intraday liquidity

## Terminology

**PIT** data as known then · **`as_of`** exclusive read bound ·
**look-ahead** using data that did not exist yet · **schema hash** artifact
identity · **ablation** fit with and without a block · **calibration** scores
into real probabilities · **log loss / Brier / ECE** probability quality ·
**AUC** ranking only · **purge/embargo** gaps preventing label leakage ·
**holdout** sealed envelope · **deflated threshold** `sqrt(2 ln N)` ·
**clustered inference** one shared value is one observation ·
**triple-barrier** target/stop/horizon · **slippage** decision-to-fill gap ·
**participation** max share of bar volume (5%) · **reservation** cash
committed at submission · **abstention** choosing not to trade · **bps** 0.01%
