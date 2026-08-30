# ZenTrade Brain — Architecture and System Understanding

Canonical reference. Every number here was read from the repository, the
measured data or a verification run. Status labels are used strictly:

    DONE/ACTIVE   implemented and verified by a test or acceptance script
    IN PROGRESS   running or partially verified right now
    REJECTED      built, tested, and rejected on evidence
    PENDING       built and measured, awaiting an operator ruling
    PLANNED       not built; described so it is not mistaken for built

Last updated against repository state of 2026-08-29.

---

# 1. The core idea

## What ZenTrade Brain is

A local research system that studies whether a disciplined, rule-bound trading
process can make money on NSE equities after real costs, and that refuses to
let itself be fooled while doing so.

It is not a trading bot. It is the apparatus that would have to be right
before a trading bot would be worth building.

## The exact problem it solves

Most trading research fails silently. It fails because the researcher
accidentally used information that did not exist yet, or tested forty ideas
and reported the best one, or ignored the cost of trading, or measured a
model's accuracy instead of its profit. The result looks like an edge and is
not one.

ZenTrade Brain solves that problem structurally. It is built so those specific
mistakes are difficult or impossible to make by accident, and so any claim of
an edge has to survive machinery designed to destroy false ones.

## Why build it

Because the alternative — a model that predicts prices, evaluated on accuracy
— has been tried by everyone and the honest version of that result is
usually negative. The interesting question is not "can a model predict?" but
"is there a decision procedure whose net expectancy after costs is positive,
and can I prove it to myself without cheating?"

## What "brain" means here

Not intelligence. It means the system holds the whole decision chain — what it
saw, what it inferred, what it decided, what it risked, what happened, what it
learned — as separate, inspectable, individually testable stages, rather than
collapsing them into one model that emits a number.

A price predictor has one stage. This has eleven.

## What makes it different from a stock-price predictor

A predictor answers "what will the price be?" This system asks a longer
question, and most of its machinery exists to handle the parts a predictor
ignores: what the trade costs, whether it can actually be filled, how much to
risk, whether to take it at all, and whether the apparent edge survives the
statistics of having looked many times.

The measured result so far is the point. A predictor would have reported an
AUC and stopped. This system reported that after 73.55 bps of round-trip cost
against a roughly 30 bps mean gross move, no model it built was worth trading.

## What the final system should be capable of

Observing the market at intraday resolution, recognising the state it is in,
identifying a setup, judging whether price is at a good location within that
setup, estimating a calibrated probability of the outcome, subtracting honest
costs, sizing to a risk budget, deciding to act or abstain, executing against
realistic fills, and recording the outcome so the next decision is informed by
evidence rather than by hope.

## What it should NOT do

- Trade real money in its current form. It is paper-only by design.
- Claim an edge that has not survived the frozen holdout.
- Optimise a feature until it works.
- Silently change what it is measuring.
- Treat a model's accuracy as if it were profit.

## What success means

Success is a decision procedure with positive net expectancy after realistic
costs, demonstrated once on data that never informed its construction.

Anything short of that is process success: the system correctly told us an
idea does not work. Five of seven feature blocks have ended that way, and
that is the machine functioning, not failing.

## The chain

Each arrow is a real transformation with its own module, its own tests and its
own failure mode.

    DATA            raw bars as the venue published them
    INFORMATION     canonical, deduplicated, adjustable, point-in-time
    MARKET CONTEXT  what regime and breadth the session sits in
    SETUP           a named, pre-registered configuration worth acting on
    PREDICTION      a raw model score
    CONFIDENCE      that score turned into a calibrated probability
    DECISION        act or abstain, after cost
    RISK            how much, bounded by budget and limits
    EXECUTION       orders that can partially fill, expire or be rejected
    OUTCOME         what actually happened, including the cost
    LEARNING        evidence recorded under a protocol that charges for search

The critical distinctions:

**Prediction is not confidence.** A model score of 0.7 is not a 70 percent
chance until a calibrator has been fitted and checked. P6 measured base rates
of 0.4162 / 0.3132 / 0.3588 across TRAIN / CALIBRATION / EVALUATION — a ten
point swing — so a model fitted on the first is miscalibrated by construction
on the last.

**Confidence is not decision.** A 60 percent chance of a 2R gain is a good
trade; a 60 percent chance of a 0.2R gain is not, once 73.55 bps of cost is
subtracted.

**Decision is not execution.** A decision to buy is not a fill. Orders can
partially fill, expire, or be rejected, and the simulator is built so all of
those actually happen.

**Outcome is not learning.** One profitable trade is not evidence. Learning
only happens under the protocol, with the trial count charged against the
significance threshold.

---

# 2. The ultimate goal

## The intended end state

Conceptually the system should behave like a disciplined senior trader:
observe, understand market state, identify setups, assess location, check for
confirmation and contradiction, estimate outcome, account for cost, assess
risk, decide or abstain, execute, monitor, exit, record, learn.

## What "replicating senior trader reasoning" means technically

It does not mean the system thinks like a person. It means three specific,
testable things:

1. **The reasoning is decomposed and separately falsifiable.** A trader's
   judgement is one opaque act. Here, "is this a good location?" and "is this
   the right size?" are different modules with different tests, so when the
   system is wrong we can find out which part was wrong.

2. **Abstention is a first-class output.** A senior trader's main skill is not
   taking the trade. The decision engine can return abstain, and the risk core
   fails closed — an unevaluable check is a rejection, not a default-allow.

3. **Experience is accumulated under a protocol that charges for search.**
   A trader who remembers only their wins learns nothing. The trial registry
   raises the evidence bar as more hypotheses are tested: the deflated
   threshold has risen from 2.23 at 12 trials to 3.178 at 156.

## A: What the current system actually does — DONE

- Ingests NSE daily bars and Fyers intraday bars into a canonical spine
- Computes 19 features under a hashed schema, point-in-time safe
- Labels outcomes with a triple-barrier scheme, truncation-invariant
- Fits baseline models and calibrators, scored on log loss, Brier, ECE, AUC
- Simulates paper execution with realistic partial fills and full Indian costs
- Enforces risk limits, drawdown ladders and a kill switch
- Replays deterministically and compares by digest

## B: What the architecture is designed to support — PLANNED

- Intraday setup detection with session phase and trigger timing
- Genuine multi-timeframe confirmation across 1m/5m/15m
- Intraday VWAP and liquidity features
- An Event Store for catalysts
- Regime-conditional model selection

## What must not be claimed

The current system does not have senior-trader intelligence. It has one
active feature block beyond the base twelve, and that block was activated as
a correction to model misspecification, not as evidence of alpha. **No
profitable edge has been demonstrated.**

---

# 3. Complete architecture

Verified against the repository. The requested diagram was accurate in shape;
two corrections were needed. The raw cache is written by the JS product, not
the Python brain. And a Setup/Context stage does not exist as a separate
module — `setup_typing` is a feature block inside the feature engine.

```
              MARKET DATA                    NSE bhavcopy archives, Fyers REST
                   |
                   v
              RAW DATA CACHE                 apps/api/scripts/  -> data/cache/
                   |                         DONE
                   v
           CANONICAL DATA SPINE              src/zentrade/spine/
                   |                         DONE  spine_v2
                   v
         POINT-IN-TIME DATA ACCESS           adapters/data/pit.py
                   |                         DONE
                   v
             FEATURE ENGINE                  features/engine.py, blocks.py
                   |                         DONE  19 active features
                   v
        MARKET STATE / SETUP CONTEXT         features/blocks.py (setup_typing)
                   |                         PARTIAL - a block, not a module
                   v
              LABEL ENGINE                   learning/labeler.py, outcomes.py
                   |                         DONE
                   v
           MODEL / PREDICTOR                 learning/models.py
                   |                         DONE  none promoted
                   v
              CALIBRATION                    learning/calibration.py
                   |                         DONE
                   v
            DECISION ENGINE                  core/proposals.py, trading_core.py
              /          \                   DONE
          TRADE        ABSTAIN
             |
             v
            RISK                             core/risk.py, limits.py, killswitch.py
             |                               DONE
             v
         EXECUTION                           adapters/execution/paper.py
             |                               DONE
             v
        PAPER TRADING                        core/store.py  SQLite WAL
             |                               DONE
             v
          OUTCOME                            learning/outcomes.py
             |                               DONE
             v
     RESEARCH / EVALUATION                   learning/experiment.py, ablation.py
             |                               DONE
             v
      CONTROLLED LEARNING                    learning/protocol.py, registry.py
                                             DONE  holdout looks = 0
```

## Box by box

### Raw data cache — DONE

**Responsibility** Hold provider bytes exactly as received.
**Input** NSE bhavcopy zips; Fyers REST JSON.
**Output** Files on disk: `data/cache/bhavcopy` (462 MB), `data/cache/intraday`
(10,209 files, 4.0 GB).
**Why it exists** So the brain can be rebuilt without the network, and so a
parser bug is recoverable. Proven: the 15:30 boundary bug was fixed by
re-parsing the cache with no refetch.
**What could go wrong** A partial write looks like real data.
**Rule that protects it** Cache writes are atomic per chunk, and the file is
only written on a `data` or `empty` outcome — never on an error.

### Canonical data spine — DONE

**Responsibility** One representation of a bar, forever.
**Input** Cached provider files.
**Output** Hive-partitioned Parquet under `spine_v2` (1.3 GB).
**Why it exists** Every layer above needs to agree on what a bar is.
**What could go wrong** Silent semantics drift.
**Rule** `SEMANTICS_ID` is part of the path, so a semantics change writes to a
different tree and cannot be confused with the old one.

### Point-in-time access — DONE

**Responsibility** Refuse to return information that did not exist yet.
**Input** `as_of` (required, keyword-only), symbols, lookback.
**Output** Arrow table, back-adjusted using only actions effective at `as_of`.
**Why it exists** Look-ahead bias is the single most common way research lies.
**What could go wrong** A caller reads the spine directly and bypasses it.
**Rule** `PitDataSource` protocol; `FutureDataRequested` raised if any bar at
or after `as_of` is returned. A P2 test caught the liquidity screen bypassing
this layer.

### Feature engine — DONE

**Responsibility** Turn bars into 19 numbers under a hashed schema.
**Input** PIT source, as_of.
**Output** `FeatureSnapshot`, schema hash `f1a55535a4c02540...`.
**Why it exists** Features must be reproducible and versioned.
**What could go wrong** Features computed on unadjusted prices.
**Rule** Adjustment happens in the PIT layer, below the engine. Found in P2:
HDFCBANK read -0.6362 on `dist_from_252d_high` because of a 1:1 bonus; the
adjusted value is -0.2779.

### Label engine — DONE

**Responsibility** Decide what actually happened after a decision.
**Input** Decision timestamp, forward bars.
**Output** TARGET / STOP / NEITHER / PENDING.
**Why it exists** Supervised learning needs a truth that is itself PIT-safe.
**What could go wrong** A label resolved using a bar the decision could see.
**Rule** Path scanning starts strictly after the decision session. 44,771
labels, 0 changed under truncation.

### Model / calibration — DONE, none promoted

**Responsibility** Score, then convert score to probability.
**Output** Calibrated probability plus log loss, Brier, ECE, AUC.
**Why it exists** A raw score is not a probability.
**Rule** The ladder always includes `ConstantNull`. If nothing beats the
constant, nothing is promoted — which is what happened in P6.

### Decision, risk, execution — DONE

**Responsibility** Act or abstain; bound the size; fill realistically.
**Rules** Bounded composition (`min` of three model-facing factors, times
drawdown). Fail closed. Cash reserved at submission. Orders eligible only
against a bar strictly later than submission, so no signal can fill in its own
session.

### Controlled learning — DONE

**Responsibility** Make search expensive.
**Rule** `assert_no_holdout` before any fit; `HoldoutLedger` makes a look an
explicit recorded act. Looks so far: **0**.

---

# 4. Data architecture

## Lifecycle

    Provider (NSE, Fyers)
      -> JS acquisition        apps/api  (one Fyers client, one rate budget)
      -> raw cache             data/cache/
      -> Python brain          parses, dedupes, validates
      -> canonical spine       data/spine/spine_v2/
      -> PIT reads             as_of-bounded, adjusted at read time
      -> features

## Why raw data is cached before parsing

Three reasons, all learned the hard way:

1. **Parser bugs are recoverable.** The 15:30 boundary bug was fixed by
   re-parsing 10,209 cached files. Without the cache it would have cost
   another 9,840 API requests.
2. **Rebuilds prove themselves.** Daily was rebuilt from cache under v2 and
   came back byte-identical across all six partitions.
3. **Research is reproducible offline.** No network, no rate limit, no
   provider outage in the middle of an experiment.

The one gap: corporate actions are fetched live with **no raw cache**, so the
adjustment table is the only part of the spine not reproducible offline. It
was copied forward and hash-verified. Recorded as a known limitation.

## Why the brain does not depend on live provider responses

Research must be deterministic. A provider that returns slightly different
data on two calls would make two runs of the same experiment disagree, and
every replay digest comparison would become meaningless.

## Datasets — verified

| Dataset | Rows | Symbols | Sessions | Span | Status |
|---|---|---|---|---|---|
| Daily `1d` | 2,778,160 | 3,505 | 1,296 | 2021-06-01 .. 2026-08-27 | DONE |
| `1m` | 75,798,294 | 100 | 2,263 | 2017-07-03 .. 2026-08-28 | IN PROGRESS |
| `5m` | 15,216,516 | 100 | 2,263 | 2017-07-03 .. 2026-08-28 | IN PROGRESS |
| `15m` | 5,073,616 | 100 | 2,263 | 2017-07-03 .. 2026-08-28 | IN PROGRESS |
| Adjustments | 541 | 418 | — | bonus, split, consolidation | DONE |

Total intraday: **96,088,426 spine rows** from 96,199,822 raw candles.
Storage: spine 1.3 GB, cache 4.0 GB.

IN PROGRESS because the full static verification has not yet completed.

## Symbols, ISIN and identity

Measured across 449 sessions: **219 renames and 279 reissues**. Neither symbol
nor ISIN is a stable key. An ISIN can be reissued to a different company; a
symbol can be renamed. Any research that assumes a stable identity over nine
years is wrong somewhere.

## Universe and liquidity

The 100-symbol intraday universe is the top 100 by median daily turnover over
the 180 sessions before 2026-08-27, computed through the PIT layer from 2,938
candidates. Universe composition changes over time — 48 names differ between
2022 and 2026 — which is why membership must be recomputed as_of rather than
taken as a fixed list. Using today's index membership for 2022 is survivorship
bias.

---

# 5. Spine — the canonical data model

## The four laws

1. **Prices are stored raw as integer minor units and never adjusted in
   place.** Adjusting in place means every future split rewrites history and
   destroys byte-for-byte reproducibility.
2. **Timestamps are UTC microseconds.** A daily bar is stamped at session
   close (10:00 UTC), not midnight, because close is the first moment the bar
   is complete. Midnight would place the bar before the information in it
   existed.
3. **Bar identity is `(venue, symbol, granularity, ts_utc)`.** Ingestion is
   idempotent on that key. This law absorbed the Fyers trailing-session
   duplication automatically.
4. **No row may carry information unavailable at its `ts_utc`.**

Adjustment factors live in their own table and are applied at read time.

## spine_v1 to spine_v2

spine_v2 is a **superset**, not a reinterpretation. It adds `1m`, `5m`, `15m`
alongside `1d`. The laws are unchanged, and a daily bar under v2 is
byte-identical to v1 — proven by rebuilding daily from cache and comparing all
six partitions byte for byte.

## Partitioning

Daily partitions by year; intraday by year and month. Bars partition by time
rather than symbol because the research loop reads cross-sectionally — every
symbol on one date — far more often than it reads one symbol's history.

## Session boundaries

NSE trades 09:15 to 15:30 IST, 375 minutes.

| Granularity | Bars/session | Last valid stamp |
|---|---|---|
| 1m | 375 | 15:29 |
| 5m | 75 | 15:25 |
| 15m | 25 | 15:15 |

A bar stamped T covers [T, T+interval), so it belongs to the session only if
it closes by the bell. This was wrong in the first cut and is section 18.

---

# 6. Point-in-time correctness

## What point-in-time data is

Data as it was known at a particular moment, not as it is known now.

## Look-ahead bias, in plain terms

**Example 1 — the split.** A stock trades at ₹2,000 and does a 1:10 split, so
today it shows ₹200. If you read history unadjusted, the stock looks like it
crashed 90 percent. If you adjust the *whole* history using today's factor,
you have used information from the future — on a date before the split was
announced, your data already knows about it.

**Example 2 — the index.** "Buy NIFTY 50 stocks" tested over ten years using
today's NIFTY 50 quietly selects companies that survived and grew enough to
still be in the index. That is survivorship bias, and it is a form of
look-ahead.

**Example 3 — the label.** If a label is computed from bars the decision could
already see, the model learns to read its own answer.

## `as_of`

Every PIT read requires an `as_of` timestamp, keyword-only so it cannot be
passed positionally by accident. The contract is strict: **`as_of` is
exclusive.** A bar stamped exactly at `as_of` is withheld.

## How each class of leak is prevented

| Leak | Prevention |
|---|---|
| Future bars | `read_bars` filters `ts_utc < end_ts`; `FutureDataRequested` if any slip through |
| Future corporate actions | `_cumulative_factors` filters `effective_ts_utc <= as_of` |
| Future universe | `liquidity_screen` reads through the PIT source |
| Future labels | Path scanning starts strictly after the decision session |
| Future features | Features computed only from a PIT snapshot |
| Wall clock | AST guard forbids `datetime.now` outside the clock module |

## Why PIT is a system property, not a discipline

Because researchers forget. The evidence is in this repository: the liquidity
screen was written in P1 by the same person who wrote the PIT layer, and it
bypassed it. An architecture test caught it, not a human.

That is the argument. If the person who built the guard can walk past it, the
guard has to be mechanical.

---

# 7. Corporate actions and entity identity

## The actions and what they do

| Action | Effect on price | Factor |
|---|---|---|
| Split | Divides | computable |
| Bonus | Divides | computable |
| Consolidation | **Multiplies** | computable |
| Rights | Complex | not computed |
| Dividends | Small drop | not computed |

Only bonus ratios and face-value changes carry a computable factor. Rights and
dividends are deliberately not adjusted — recorded as a known approximation
rather than faked.

## Why mishandling one creates fake signals

A 1:1 bonus halves the price overnight. Unadjusted, that is a -50 percent
return. Every momentum feature sees a crash; every mean-reversion feature sees
a screaming buy. The signal is entirely an artifact of the corporate action.

Measured: HDFCBANK's `dist_from_252d_high` read **-0.6362** on raw prices and
**-0.2779** adjusted. The raw number says the stock is 64 percent below its
high. It never was.

## Ex-date vs announcement

The adjustment table keys on `effective_ts_utc`, the ex-date. Announcement
timestamps do not exist in the corporate-actions feed — `caBroadcastDate` is
empty on all 3,152 sampled rows. The data capability audit found the
corporate-*announcements* feed carries `exchdisstime` populated to the second
on 2,594 of 2,594 rows back to 2020-01, which is the better source for a
future Event Store. **PLANNED, not built.**

## Identity

219 renames and 279 reissues across 449 sessions. The CADILAHC / ZYDUSLIFE
case is the canonical rename example in this domain, but the repository's
`symbology.py` records identity transitions generically rather than
special-casing that pair, so it is not cited here as a verified fixture.

---

# 8. Feature engine

## Current state

| Tier | Block | Features | Status |
|---|---|---|---|
| BASE | `symbol_technical` v1 | 12 | ACTIVE |
| ACTIVE | `setup_typing` v1 | 7 | ACTIVE |
| REJECTED | `relative_strength` v1 | 3 | REJECTED |
| REJECTED | `mtf_alignment` v1 | 3 | REJECTED |
| REJECTED | `trade_location` v1 | 3 | REJECTED |
| REJECTED | `market_context` v1 | 3 | REJECTED |
| REJECTED | `contradiction` v1 | 3 | REJECTED |
| PLANNED | 5 `FutureVariant` records | — | FUTURE/UNTESTED |

**Active schema: `(symbol_technical, setup_typing)` = 19 features**
**Hash: `f1a55535a4c02540b34b2947b6a9b000e980f72279d261ba9d8b7cd23e5cb392`**

The 12 base features: `return_1d`, `return_5d`, `return_21d`, `sma20_ratio`,
`sma50_ratio`, `realized_vol_20d`, `vol_compression`, `atr14_pct`,
`range_position`, `volume_ratio_20d`, `dist_from_252d_high`,
`dist_from_252d_low`.

## Schema hashes

The schema hash is derived from the ordered feature names. When
`setup_typing` was activated the hash changed from `6b1d5f92...` to
`f1a55535...`, and every artifact fitted against the old schema now fails to
load. That is the gate working, not a regression.

## Why blocks cannot silently enter production

`require_active()` raises `RejectedBlock` for anything not ACTIVE. A rejected
block physically cannot be assembled into a live schema.

## Why we don't keep every feature that slightly improves validation

Four reasons, each learned from a specific block:

1. **Search inflation.** Every test raises the bar for the next. The threshold
   has gone 2.23 → 2.86 → 3.178 as trials accumulated 12 → 60 → 156.
2. **Anti-duplication.** Trade location improved the metric and was still
   rejected: its features correlated 0.920, 0.917 and 0.855 with the features
   they were derived from, against a 0.80 ceiling.
3. **Calibration substitution.** A feature that only helps an uncalibrated
   model is doing the calibrator's job. Trade location's benefit collapsed
   from 0.00098 at identity to 0.00014 at isotonic.
4. **Permanent complexity.** Every feature is maintained forever.

---

# 9. Feature research history

Six blocks tested. One activated. All measured on the development validation
window; the frozen holdout was never touched.

## Block 1 — Relative strength — REJECTED

**Hypothesis** Strength relative to the universe predicts continuation.
**Features** `rs_excess_5d`, `rs_excess_21d`, `rs_rank_21d`.
**Result** 0 of 12 configurations improved significantly at t>2.68. Several
were significantly **worse**.
**Lesson** The verdict rule itself was wrong first: it compared the best arm
to the best arm, which measures the *selection*, not the block. Replaced with
a paired like-for-like test, and the verdict reversed.

## Block 2 — Multi-timeframe alignment — REJECTED

**Features** `mtf_alignment`, `mtf_conflict`, `mtf_dispersion`.
**Result** 0 of 12 at t>2.86; best 1.77. Nothing significantly worse.
**Lesson** Harmless-not-helpful differs from harmful. **Scope matters**: the
spine held only daily bars, so this rejects *daily* alignment and says nothing
about 1m–1h. That distinction is why intraday MTF is a live PLANNED question
rather than a settled one.

## Block 3 — Trade location — REJECTED by operator ruling

**Features** `extension_atr_20`, `extension_atr_50`, `high_distance_atr`.
**Result** The paired test said KEEP — 3 of 12 significant at t>2.98. The
anti-duplication rule said REJECT — correlations 0.920, 0.917, 0.855.
**Verdict** Rejected on four grounds: duplication, benefit concentrated in the
worst-calibrated arm, shrinkage under calibration, and effect too small.
**Lesson** Two frozen rules can disagree. The block was held PENDING rather
than auto-decided, and a `PENDING` status plus five `FutureVariant` records
were added so rejecting *what was testable* is not mistaken for rejecting the
idea.

## Block 4 — Market context — REJECTED, and the reason matters most

**Features** `breadth_above_ma20`, `breadth_advancing`, `dispersion_21d`.
**Result** Passed anti-duplication cleanly at 0.446.

| Configuration | raw t | clustered t |
|---|---|---|
| logistic_unpenalised / identity | 4.46 | 0.98 |
| logistic_elasticnet / identity | 4.41 | 0.97 |
| logistic_elasticnet / platt | 1.71 | 0.76 |

**Lesson** A market feature takes one value per session shared by every row.
Treating 14,350 rows as independent overstates evidence by roughly the square
root of rows per session. Without clustering this block would have been
promoted on noise. The estimator was verified first on a synthetic case with
perfect intra-cluster correlation: it recovered 7.09× inflation against a
theoretical 7.07×, collapsing a spurious t=8.65 to t=1.22.

**Standing rule:** market- and sector-varying features require clustered
inference, permanently.

## Block 5 — Setup typing — ACTIVATED

**Features** 7 binary indicators over mutually exclusive types.
**Result** 5 of 12 significant at t>3.12; anti-duplication 0.448. Survives
calibration: identity 0.00092, platt 0.00046, isotonic 0.00069.
**Verdict** ACTIVE — the only block promoted.

**Four caveats recorded with the ruling:**
1. Not evidence of positive net trading edge. Net economics stay negative.
2. The gain is a correction to model **misspecification**, not proof that
   setup labels are alpha. A linear model cannot represent conjunctions, so
   the dummies act as regional intercept corrections.
3. Only 1 of 7 types is individually distinguishable (`volatility_expansion`,
   z=-2.43), and a Bonferroni threshold of 2.69 means even that does not
   survive multiplicity.
4. `mean_reversion` and `breakdown` are thin-support, recorded in
   `SETUP_THIN_SUPPORT`.

## Block 6 — Contradiction — REJECTED

**Result** 0 of 12 at t>3.178; best 2.55. Anti-duplication 0.392.
**Lesson — the ordering effect.** At block 1's threshold of 2.23 this block
would have passed. It does not now because 156 trials have accumulated. The
penalty is correct, but it means **the order blocks are tested in affects
which clear**. A block tested early faces a lower bar than the same block
tested late.

## Why rejection is success

Five rejections is the system working. Each one is a hypothesis that would
otherwise have entered production carrying variance and maintenance while
delivering nothing. Block 4 is the sharpest case: it looked significant at
t=4.46 and was noise.

## Cumulative trial accounting

Threshold = `sqrt(2 ln N)`.

| Trials | Threshold |
|---|---|
| 12 | 2.23 |
| 60 | 2.86 |
| 156 | **3.178** (current) |

---

# 10. Labeling

## Scheme

Triple-barrier. Frozen `LabelSpec`: horizon **21 sessions**, target **2.0 ×
ATR**, stop **1.0 × ATR**, ATR window **14**. Changing any of these is a new
semantics id.

Outcomes: `TARGET`, `STOP`, `NEITHER`, `PENDING`.

## Why labels must be PIT-safe

A label is future information by construction — that is its job. The danger is
letting it leak backwards. Rules:

- **The decision session sets the levels but never resolves them.** Its close
  is already contaminated by post-decision movement.
- Path hits scan sessions **strictly after** the decision session.
- **Ambiguity resolves to STOP.** A daily bar touching both levels cannot be
  ordered intraday, so the risk-first reading is taken.
- Gaps fill at the open.

## Truncation invariance

The critical test: a label computed on data ending today must equal the label
computed on data ending a year from now. **44,771 labels, 0 changed.** Without
this property no historical study is possible, because every label would
depend on when you ran it.

Median four sessions to resolution against a 21-session horizon, so most
labels resolve early.

---

# 11. Modeling

## The ladder

`ConstantNull` → `RuleBaseline` → `LogisticModel` (unpenalised) →
`LogisticModel` (elastic net), each crossed with `IdentityCalibrator`,
`PlattCalibrator`, `IsotonicCalibrator`.

The constant null is always present. If nothing beats it, nothing is promoted.

## Metrics

`log_loss`, `brier`, `base_rate`, `auc`, `reliability`,
`expected_calibration_error`.

## Why AUC alone is insufficient

AUC measures **ranking**. It is invariant to any monotone transform of the
scores, so a model with perfect AUC can have wildly wrong probabilities. Since
the decision is "is expected value positive after 73.55 bps of cost?", the
absolute probability is what matters, not the ordering.

## Why calibration matters

Measured base rates: TRAIN **0.4162**, CALIBRATION **0.3132**, EVALUATION
**0.3588**. A model fitted where the target is hit 41.6 percent of the time is
miscalibrated by construction on a period where it is hit 35.9 percent.

## Why the first model was NOT promoted — P6

- **Round-trip cost 73.55 bps** against a mean forward gross move of ~30 bps.
- **Random entry returns about -44 bps net.**
- No model beat the constant null after costs.
- By regime: LOW **-52.59 bps**, MID **-74.96 bps**, HIGH **-3.80 bps**. High
  volatility is the only regime near break-even, from a tercile proxy.

**Two apparent positives were artifacts and both were killed.** A constant
predictor has no spread, so its "top decile" is whichever rows argsort left
first — alphabetically earliest symbols — producing a spurious **+27.64 bps at
t=3.49**. Separately a p≥0.35 tail of 98 rows out of 24,066 showed +94 bps at
t=1.17, below the deflated threshold of 2.23 at twelve trials.

## Prediction quality vs trading profitability

They are almost unrelated here. Ranking improved measurably — top decile from
-24.72 to -9.81 bps with setup typing — and **the trade still loses money**,
because the cost hurdle dominates. A model can get better at ranking forever
and never become profitable.

---

# 12. Research protocol — `protocol_v1`

## Populations

| Population | Window |
|---|---|
| Development | 2022-06-03 .. 2025-07-09 |
| — dev-train | 55% |
| — dev-calibration | 20% |
| — dev-validation | remainder |
| **Frozen holdout** | **2025-08-05 .. 2026-08-25** |

## Purge and embargo

`purge_sessions = 21` (the label horizon), `embargo_sessions = 5`.

Because a label at time T uses bars up to T+21, a naive chronological split
leaks: the last training rows' labels resolve inside the validation window.
Purging removes those; the embargo adds a further gap for slow-decaying
autocorrelation.

## Why the holdout must stay untouched

Its value comes **entirely** from never having informed anything. A single
look destroys it permanently and silently — silently because the resulting
number still looks like an out-of-sample result.

`assert_no_holdout` runs before anything is fitted. `HoldoutLedger` makes a
look an explicit recorded act rather than an ordinary function call.

**Looks recorded: 0.**

## Why trial counts matter

Test enough hypotheses and one will look significant by chance. The registry
counts every trial ever run and raises the threshold as `sqrt(2 ln N)`.
Currently **156 trials, threshold 3.178**.

---

# 13. Execution engine

## States and transitions

`NEW`, `ACCEPTED`, `PARTIALLY_FILLED`, `FILLED`, `CANCELLED`, `REJECTED`,
`EXPIRED`, `AMBIGUOUS`. Transitions are a table; illegal edges raise
`InvalidTransition`.

Reject reasons: `NO_LIQUIDITY`, `PRICE_BAND`, `ZERO_QUANTITY`,
`UNKNOWN_SYMBOL`, `INSUFFICIENT_CASH`, `INSUFFICIENT_POSITION`.

## SIGNAL ≠ ORDER ≠ FILL

**Signal is not order.** A signal passes risk checks, sizing and viability
floors first, and may be abstained on.

**Order is not fill.** An order is eligible only against a bar **strictly
later** than its submission timestamp, so there is no code path from signal to
fill within the same session. Latency is structural, not simulated.

Fills are capped at **5 percent participation** of bar volume. Price is the
bar open adjusted for slippage.

## Key rulings

**Zero volume is not a rejection.** An accepted order facing an untradeable
session could not fill; the venue did not refuse it. It ages toward expiry.
The transition table caught this: ACCEPTED → REJECTED is not a legal edge.

**Cash is reserved at submission, released on any terminal state.** Without
reservations, several orders sized independently against the same balance can
collectively overspend it.

**A simulation that only fills cleanly proves nothing.** The first
verification exercised only FILLED and passed 25 of 26 checks. The scenario
was too easy, not the code. It now deliberately submits oversized,
unaffordable and cancelled orders.

---

# 14. Transaction cost model

Calibration stage: **bootstrap**. No realised fill exists, so every rate is a
published-rate estimate set at or above the expected true value.

| Component | Rate |
|---|---|
| Brokerage | 0.03%, capped ₹20 |
| STT | 0.1% delivery both sides; 0.025% intraday sell only |
| Exchange transaction | 0.003% |
| SEBI turnover | 0.0001% |
| Stamp duty | 0.015% delivery buy; 0.003% intraday buy |
| GST | 18% on brokerage + exchange + SEBI |
| DP charge | ₹15.93 flat, delivery sell only |
| Slippage | half-spread + √impact, × **1.5** conservatism |

Measured on a real simulated book: **0.12% to 0.17% of turnover**.
**Round trip: 73.55 bps.**

All charges **round up, never down**, because rounding a fee down flatters
exactly the results that matter.

## Why costs decide everything

The cost hurdle **exceeds the average gross move**: 73.55 bps against ~30 bps.
This single comparison is why P6 promoted nothing. Any strategy must clear it
before anything else matters.

The 1.5× conservatism multiplier is deliberately untuned. It exists so early
results cannot be flattered, and should come down only when real fills justify
it.

---

# 15. Risk and abstention

## Implemented — DONE

**Bounded composition.** Regime confidence, strategy health and novelty are
three instruments pointed at one question, so they compose by `min`. Drawdown
is about the account rather than the model, so it is a separate axis and
multiplies:

    budget = min(regime, health, ood) × drawdown

Exactly two factors, never four. Measured **0.075** where a four-factor
product would give 0.063.

**Fail closed.** An unpriced symbol or missing timestamp means the state is
unknown, and trading on unknown state is the failure this component prevents.
There is no default-allow path.

**Limits:**

| Limit | Value |
|---|---|
| Position value / symbol | ₹5,00,000 |
| Gross exposure | ₹50,00,000 |
| Net exposure | ₹40,00,000 |
| Sector exposure | ₹15,00,000 |
| Symbols held | 25 |
| Trades / session | 20 |
| Turnover / session | ₹1,00,00,000 |
| Daily loss | ₹2,50,000 → kill switch |
| Max drawdown | 20% → kill switch |
| Price drift | 100 bps |
| Proposal age | 5 minutes |
| Viability floor | ₹10,000 |
| Drawdown ladder | 5%→0.8, 10%→0.6, 15%→0.3 |

**Kill switch.** Engaging is automatic and cheap. Disengaging requires a named
operator. A switch that resets itself is not a kill switch. Engagement cancels
working orders and stops new entries; it does **not** flatten.

**Halted blocks entries but never exits.** Risk-reducing sells stay permitted
and are exempt from turnover and trade-count budgets, because a budget that
prevents you closing a position traps you in one.

## Planned — PLANNED

Named `CAUTIOUS` / `DEGRADED` system states as a first-class enum, and a
fitted OOD detector. The composition slot exists; the detector behind it is
not a trained novelty model.

## Why abstention is the main skill

The measured expectancy of a random trade is **-44 bps**. Under those
conditions the single most valuable capability is not trading. Every limit,
the viability floor, the fail-closed default and the kill switch exist to make
the system trade less than it otherwise would.

---

# 16. Replay and determinism

    same input -> same features -> same labels -> same decision
              -> same execution -> same result

`snapshot_digest` and `replay_digest` hash the full feature snapshot sequence,
so two adapters or two runs are compared by one hash rather than by eyeball.

**A lesson recorded here:** the digest originally included
`sessions_available`, a metadata field. That made two adapters agreeing on
every actual feature look divergent. Metadata must not enter an identity hash.

Artifact identity: schema hash, label spec hash, `SEMANTICS_ID`,
`PROTOCOL_VERSION`. An artifact fitted against a different schema refuses to
load rather than silently mismatching.

Determinism is what makes debugging possible. Without it, a difference between
two runs could be the bug, the fix, or noise, and there is no way to tell.

---

# 17. P1 → current journey

## P1 — Data foundation — DONE, 20/20

Built the spine, PIT layer, bhavcopy ingestion, corporate actions, symbology.
Failures: unanchored `data/` in `.gitignore` silently excluded six source
files; project root derived from directory depth broke when a driver moved;
consolidation was mislabeled as a split (VERTOZ, Re 1 → Rs 10, price 9.17 →
87.11).

## P2 — Canonical engine and replay — DONE, 11/11

Built the feature engine and replay harness. Failures: features computed on
raw prices; the liquidity screen bypassed the PIT layer; the replay digest
included metadata. Lesson: a shuffle test that always passes needs a positive
control.

## P3 — Universal shadow labeling — DONE, 16/16

44,771 labels, 0 changed under truncation. Established that the decision
session sets levels but never resolves them, and that ambiguity resolves to
STOP.

## P4 — Paper execution and cost model — DONE, 30/30

Order state machine, reservations, participation caps, full Indian cost stack.
Failures: zero-volume treated as rejection; a first verification that only
exercised clean fills.

## P5 — Trading and risk core — DONE, 55/55

Risk core, limits, kill switch, SQLite WAL persistence. Failures: a hostile
sweep that passed trivially because the per-symbol limit always bound first.
Operator pushback corrected an in-memory core to the specified WAL store.

## P6 — Baseline predictor — DONE as process, 11/11; NO MODEL PROMOTED

The central negative result. Cost hurdle 73.55 bps vs ~30 bps mean gross move.
Two artifacts caught and killed. Evaluation window frozen as the holdout.

## Blocks 1–6 — five REJECTED, one ACTIVE

Covered in section 9.

## Intraday discovery — DONE

The Fyers depth probe returned **9.15 years** of 1m/5m/15m, 2017-07-03 to
2026-08-28, continuous, exactly 375/75/25 candles per session, zero
out-of-session stamps. The provider limit is **days (100)**, not candle count.
Only defect: the trailing session duplicated at full range.

This reversed the architecture from DAILY-FIRST to **INTRADAY-FIRST**.

## spine_v2 — DONE

Added 1m/5m/15m. Daily rebuilt from cache, byte-identical across six
partitions.

## Intraday backfill — DONE

| | chunks | requests | successful | empty | failed | candles |
|---|---|---|---|---|---|---|
| 1m | 3,400 | 3,400 | 3,071 | 329 | 0 | 75,884,759 |
| 5m | 3,400 | 3,400 | 3,071 | 329 | 0 | 15,234,762 |
| 15m | 3,400 | 3,040 | 2,725 | 315 | 0 | 5,080,301 |
| **total** | **10,200** | **9,840** | **8,867** | **973** | **0** | **96,199,822** |

Fyers budget 100,000 → 90,157. Cache 10,209 files, 4.0 GB.

## Current verification — IN PROGRESS

Full static-cache verification running. **15 passes, 2 fails** at last read.
Both fails are understood and under analysis:

1. **Short sessions** — 13,194 at 1m, of which 11,235 outside market-wide
   short days. Hypothesis under test: Fyers emits no candle for a minute with
   no trades, so a fixed 375-bar invariant is wrong for thin names. Being
   tested by volume conservation across 1m/5m/15m and daily bhavcopy. **NOT
   YET RESOLVED.**
2. **Four whole-session gaps.** Two (GVT&D 2024-11-04, MOTHERSON 2022-06-08)
   have no daily bar either, so both sources agree the ticker did not trade —
   both are on rename boundaries. Two (HSCL 2024-01-09 volume 1,408,785;
   NETWEB 2024-02-01 volume 28,235) **did** trade per bhavcopy, so these are
   genuine provider gaps.

## Next — PLANNED, not started

Blocks A–E in strict dependency order: session phase, setup trigger timing,
genuine 1m/5m/15m alignment, intraday VWAP, intraday liquidity.

---

# 18. Failures that made ZenTrade better

Every entry below actually occurred and is recorded in the repository.

### 1. Consolidation classified as a split
**What** VERTOZ moved Re 1 → Rs 10; price jumped 9.17 → 87.11. Treated as a
split, the adjustment scaled the wrong way.
**Why it mattered** Inverted nine years of that symbol's history.
**Detected** Manual inspection of an implausible price jump.
**Root cause** The taxonomy had no `consolidation` kind.
**Fix** Added it; rebuilt the adjustment table. Because `kind` is part of the
identity key, re-running without care would have **double-applied**.
**Lesson** A missing category is not a neutral omission; it forces data into
the wrong bucket.

### 2. Features computed on raw prices
**What** HDFCBANK `dist_from_252d_high` = -0.6362 across a 1:1 bonus.
**Fix** as_of-bounded back-adjustment with exact rationals. Correct: -0.2779.
**Lesson** Adjustment belongs below the feature engine, not inside it.

### 3. PIT bypass in the liquidity screen
**What** Written in P1, it read the spine directly.
**Detected** An architecture test — not a human.
**Lesson** The author of a guard will walk past it. Guards must be mechanical.

### 4. Metadata contaminating the replay digest
**What** `sessions_available` in the digest made two adapters that agreed on
every feature look divergent.
**Lesson** Identity hashes cover semantics, not bookkeeping.

### 5. `lookback_sessions` counting bars, not sessions
**What** At 1m, a request for 375 bought 375 **calendar days** instead of one
session.
**Fix** Divide by `bars_per_session`; daily unaffected.
**Lesson** A parameter whose meaning is granularity-dependent must be
converted at the boundary.

### 6. Project root derived from directory depth
**Fix** Derive from the package location.

### 7. A false label invariant
**What** A truncation test that could not fail.
**Lesson** A test that always passes is worse than no test.

### 8. Invalid order-state transition
**What** Code marked a zero-volume order REJECTED. ACCEPTED → REJECTED is not
a legal edge.
**Detected** The transition table.
**Lesson** The table was right and the code was wrong. Encode the legal set.

### 9. Constant predictor fake alpha
**What** +27.64 bps at t=3.49 from a model with no spread — argsort returned
alphabetically earliest symbols.
**Fix** Degenerate-ranking detection; every decision metric now carries a
t-statistic.
**Lesson** A return with no t-statistic beside it is a number, not evidence.

### 10. Calibration and base-rate drift
**What** Base rate swung 0.4162 / 0.3132 / 0.3588.
**Lesson** Non-stationarity is the default. Calibration is not optional.

### 11. Wall-clock leakage
**What** The registry read wall-clock time. Worse, the guard **missed it** —
it matched only one attribute level, so `datetime.datetime.now()` slipped
through.
**Detected** By deliberately injecting a violation to test the guard.
**Lesson** Test your guards by attacking them.

### 12. `learning` importing `core.costs`
**Detected** Import-graph guard.
**Fix** Structural — `costs.py` moved to the package root, `Side` lifted into
the kernel. Not an exemption.

### 13. Fyers response flattening
**What** `getCandles` collapsed per-chunk outcomes, so a failed chunk was
indistinguishable from an empty one.
**Fix** `getCandlesDetailed` returns per-chunk outcomes.

### 14. IST date shift
**What** `toISOString()` is UTC, but Fyers interprets `range_from`/`range_to`
as IST trading dates. Any instant between 00:00 and 05:30 IST formatted to the
**previous day**, silently shifting every window by one session. The 03:31 IST
budget reset sits inside that band.
**Fix** Offset by IST before formatting. 9 tests.
**Lesson** A timezone bug that only fires for 5.5 hours a day is worse than
one that always fires.

### 15. Provider vs adapter request-limit confusion
**What** `CHUNK_LIMIT_DAYS` was an adapter assumption, mistaken for a provider
limit.
**Fix** Probed directly: the provider caps at **100 days**, not candle count.

### 16. Trailing-session duplicate candles
**What** A full 100-day request returns the trailing session twice — measured
1,775 raw candles, 1,750 distinct, 25 dropped. The same response arrives
**out of order**.
**Lesson** The 30-day sample showed zero duplicates. A sample-only test proved
nothing about the dedup path.

### 17. Rate-limiter reservoir never refilling
**What** The backfill stalled twice at **exactly 180** chunks, three hours
apart, with zero failed requests. 180 is `PER_MINUTE_CAP`, the Bottleneck
reservoir size.
**Root cause** Bottleneck cancels the `reservoirRefreshInterval` timer the
first time `updateSettings` is called — which `applyLimiterSettings` does on
the first REST call of every process. Re-passing the reservoir options does
not restore it.
**Scope** Not a backfill bug. Any long-lived process making >180 REST calls in
its lifetime stops, silently.
**Fix** Refill on our own timer, topping up to the cap, never past it.
**Detected** Throughput 0.015 req/s vs 2.91 after the fix.
**Lesson** I nearly misread this as provider throttling. A fresh process
answered the same request in 0.1–1.0s while the stalled one averaged 67s.
**Latency measured from outside a stalled process says nothing about what is
stalling it.**

### 18. Memory pressure in ingest
**What** `load_cache` held every row in a Python list — **42 GB** at 1m.
**Fix** Stream month by month, flushing partitions once no later cache window
can contribute. Peak RSS 1.53 GB against 75.8M rows.

### 19. Verification run against a moving cache
**What** Idempotency and clean-room reported failures that were artifacts: the
15m cache grew from 3 to 144 files mid-run.
**Fix** The harness detects a running fetch and skips cache-dependent checks.
**Lesson** A verification that reads mutable state must assert the state is
quiescent.

### 20. Misleading cross-file completeness metric
**What** The ingest reported `over 63` — symbol-sessions with more than the
expected candles. The spine had none.
**Root cause** `ParseReport.per_cell` tallied across files without cross-file
dedup; the 3 June sample symbols × 21 sessions appear in two overlapping cache
files.
**Fix** Removed the metric. The deduplicated spine is the authority.
**Lesson** A diagnostic that lies is worse than no diagnostic.

### 21. Session-close boundary — the 15:30 bar
**What** The first spine_v2 rule admitted any bar stamped at or before 15:30.
A 15m bar stamped 15:30 covers 15:30–15:45, entirely after the bell, and
became a 26th candle in 45 sessions.
**Detected** By the over-count check. **The out-of-session check passed**,
because it was written against the same wrong constant.
**Fix** `last_bar_minute` derives the cutoff from the interval: 15:29 / 15:25
/ 15:15. These match the maxima independently observed in the June sample.
**Consequence** `write_bars` merges, so a row the parser stops emitting
survives a re-ingest. Required an explicit `--rebuild` purge.
**Lesson** Two checks sharing a wrong constant agree with each other. The June
sample could not have caught this — only nine years of data could.

### 22. Short-session candle-count assumption — UNRESOLVED
**What** 13,194 short sessions at 1m.
**Status** Under analysis. The suspicion is that the invariant, not the data,
is wrong. **Not yet concluded.**

---

# 19. Intraday-first architecture

## The discovery

Before the probe, intraday depth was an assumption. The data capability audit
called it "the largest avoidable unknown in the project" and refused to build
anything until it was measured.

Measured: **9.15 years**, 2017-07-03 to 2026-08-28, continuous, exactly
375/75/25 candles per session, zero out-of-session stamps.

## Why it changed the architecture

Five rejected or untestable ideas were blocked on intraday data:
`session_phase`, `time_since_trigger`, genuine multi-timeframe alignment,
intraday VWAP, intraday liquidity. Block 2's rejection was explicitly scoped
to daily horizons.

Daily-first was a constraint, not a choice. The probe removed it.

## Provider limits vs adapter limits

A distinction that cost real time. `CHUNK_LIMIT_DAYS` was an **adapter**
constant that had been treated as a provider fact. The probe measured the real
limit: **100 days per request**, enforced on days, not candle count. A 130-day
request returns "Invalid input".

## Deduplication and session boundaries

Covered in sections 5 and 18. Dedup on `(symbol, ts_utc)` at parse time so the
count is visible; close boundary derived from the interval.

## What intraday unlocks — all PLANNED

A. Session phase · B. Setup trigger timing · C. Genuine 1m/5m/15m alignment ·
D. Intraday VWAP · E. Intraday liquidity

Strictly ordered; each requires pre-registration and paired ablation against
the current active schema. Microstructure research remains impossible: **order
flow does not exist at this access level**, confirmed against live sources.

---

# 20. Current state

| Area | Status | Detail |
|---|---|---|
| Python tests | DONE | 552 passed, 4 skipped |
| Architecture guards | DONE | 4 guards, all passing |
| JS tests | DONE | 46 passed |
| P1–P5 acceptance | DONE | 20/20, 11/11, 16/16, 30/30, 55/55 |
| P6 acceptance | DONE (process) | 11/11; **no model promoted** |
| Active schema | ACTIVE | `(symbol_technical, setup_typing)`, 19 features |
| Schema hash | ACTIVE | `f1a55535a4c02540...` |
| Daily spine | DONE | 2,778,160 rows, 3,505 symbols |
| Intraday spine | IN PROGRESS | 96,088,426 rows; verification incomplete |
| Intraday verification | IN PROGRESS | 15 pass, 2 fail, unresolved |
| Trials | ACTIVE | **156**, threshold 3.178 |
| Frozen holdout | ACTIVE | **looks = 0** |
| Feature blocks | 2 ACTIVE, 5 REJECTED | 5 FutureVariant PLANNED |
| Paper trading | DONE | Simulator + WAL store; no live capital |
| Event Store | PLANNED | Not built |
| Sector data | PLANNED | Sectoral indices available, not ingested |
| Order flow | NOT POSSIBLE | Does not exist at this access level |
| Session phase (Block A) | PLANNED | Not started |

## What has NOT been proven

**We have not yet proven profitable alpha.**

Specifically:
- No model has beaten the constant null after costs.
- The one activated block corrects misspecification; it is not alpha.
- Net economics are negative at every selection depth tested.
- The frozen holdout has never been looked at, so **no out-of-sample result
  exists at all**.
- The cost model is bootstrap: no realised fill has ever calibrated it.
- Intraday data is ingested but not yet fully verified, and no feature has
  been built on it.

---

# 21. What the final brain should eventually do

    MARKET STATE          regime, breadth, volatility           PARTIAL
      -> SETUP DETECTION  named, pre-registered configurations  ACTIVE (v1)
      -> TRADE LOCATION   where price sits within the setup     REJECTED (daily)
      -> MTF CONFIRMATION 1m/5m/15m agreement                   PLANNED
      -> CONTEXT          catalysts, sector                     PLANNED
      -> EXPECTED OUTCOME triple-barrier probability            ACTIVE
      -> CALIBRATED PROB  Platt / isotonic                      ACTIVE
      -> COST CHECK       73.55 bps hurdle                      ACTIVE
      -> RISK CHECK       bounded composition, limits           ACTIVE
      -> POSITION SIZE    risk budget                           ACTIVE
      -> EXECUTION        realistic fills                       ACTIVE
      -> MONITOR / EXIT   exit lattice                          PARTIAL
      -> POST-TRADE       outcome + protocol                    ACTIVE

## How this differs from "ML model predicts tomorrow's price"

A price predictor has one stage and one failure mode: the prediction is wrong.
This has thirteen, and the prediction is the *least* important. Cost check
alone killed every P6 model. The system can be excellent at prediction and
still correctly decide never to trade.

The predictor optimises accuracy. This optimises **net expectancy after costs,
under a protocol that charges for search**.

---

# 22. Why each architectural decision exists

| Decision | Why | Problem it prevents | If removed |
|---|---|---|---|
| Raw cache | Provider bytes are the ground truth | Unrecoverable parser bugs | The 15:30 fix costs 9,840 refetches |
| Canonical spine | One definition of a bar | Semantics drift between layers | Every layer invents its own bar |
| PIT layer | Future data is invisible by construction | Look-ahead bias | The liquidity-screen bug becomes permanent |
| `as_of` required | Cannot be forgotten | Accidental full-history reads | Leakage becomes the default |
| Schema hashes | Artifacts declare what they were fitted on | Silent feature mismatch | A model scores against wrong columns |
| Deterministic replay | Two runs comparable by digest | Untraceable divergence | Debugging becomes guesswork |
| Feature blocks | Features versioned as units | Ad-hoc feature creep | No ablation is possible |
| Pre-registration | Hypothesis fixed before results | Post-hoc rationalisation | Every result is confirmable |
| Frozen holdout | One honest number, once | Overfitting to the test set | No out-of-sample estimate exists |
| Calibration | Scores become probabilities | Confusing ranking with probability | Cost comparison is meaningless |
| Deflated threshold | Search is charged for | Multiple-comparison false positives | Block 4 promoted on t=4.46 noise |
| Clustered inference | One value per session is one observation | Overstated evidence | 7× inflation admitted as signal |
| Anti-duplication | Correlated features add complexity only | Redundant schema growth | Trade location enters at 0.920 correlation |
| Execution simulator | Fills are not free or certain | Unrealistic backtests | Every signal fills perfectly at close |
| Realistic costs | 73.55 bps is the hurdle | Phantom edges | Every P6 model looks profitable |
| Reservations | Cash committed at submission | Collective overspend | Independently sized orders overspend |
| Abstention + fail closed | Not trading is a decision | Trading on unknown state | Unevaluable checks default to allow |
| Rejecting weak features | Complexity is permanent | Schema bloat for 0.06% gains | Five rejected blocks in production |
| Intraday-first | Measured, not assumed | Building on a guessed constraint | Five capabilities stay blocked forever |

---

# 23. System invariants

Extracted from code and tests.

**Data**
1. No row may carry information unavailable at its `ts_utc`.
2. Bar identity is `(venue, symbol, granularity, ts_utc)`; ingestion is
   idempotent on it.
3. Prices are stored raw; adjustments apply at read time, never in place.
4. A bar belongs to a session only if it closes by the bell.
5. Re-ingesting the same cache produces byte-identical partitions.

**Point-in-time**
6. `as_of` is required, keyword-only, and **exclusive**.
7. A bar at or after `as_of` raises `FutureDataRequested`.
8. Adjustment factors use only actions effective at or before `as_of`.
9. No wall-clock read outside the clock module.

**Schema**
10. A rejected block cannot enter an active schema (`RejectedBlock`).
11. An artifact whose schema hash does not match refuses to load.

**Execution**
12. Only transitions in the table are legal (`InvalidTransition`).
13. An order is eligible only against a bar strictly later than submission.
14. Cash is reserved at submission and released on any terminal state.
15. Fills never exceed the participation cap.
16. Charges round up, never down.

**Risk**
17. An unevaluable check is a rejection.
18. The kill switch cannot reset itself.
19. HALTED blocks entries, never exits.
20. Risk budget composes as `min(...) × drawdown`, two factors, never four.

**Protocol**
21. The holdout is never read outside `HoldoutLedger`.
22. Every trial is counted; the threshold is `sqrt(2 ln N)`.
23. Market- or sector-varying features require clustered inference.

**Architecture**
24. Process packages cannot import the trading core.
25. The kernel imports nothing internal.
26. Broker credentials live in exactly one module.

---

# 24. Scale

## Current — measured

100 symbols · 9.15 years intraday · 96,088,426 candles · 1.3 GB spine ·
4.0 GB cache · 9,840 API requests for the backfill · peak ingest RSS 1.53 GB.

## Bottlenecks — with evidence

| Resource | Current | Bottleneck |
|---|---|---|
| API requests | 9,840 for 100 symbols | **Linear in symbols.** 1,000 symbols ≈ 98,400 requests, near the 100,000 daily budget |
| Rate | 2.91 req/s at the cap | 1,000 symbols ≈ 9.4 hours of wall clock |
| Storage | 1.3 GB / 100 symbols | ~13 GB at 1,000; ~26 GB for the ~2,000-symbol NSE universe |
| Ingest memory | 1.53 GB peak | Bounded by month, not by symbol count — should hold |
| Feature computation | Not measured at scale | **Unknown** |
| Replay | Not measured at scale | **Unknown** |
| Model training | 24,066 rows daily | Intraday would be ~100× more rows; **untested** |

## Honest assessment

500 symbols looks feasible: ~49,000 requests within the daily budget, ~6.5 GB.

1,000 symbols is near the API budget ceiling and would need multi-day
backfills.

The full NSE universe is **not supported** by the current acquisition design.

**Untested claims:** feature computation, replay and model training have never
been run at intraday scale. The ingest path is the only one measured against
75.8M rows. Nothing here should be read as "the system scales" — only the
storage and acquisition arithmetic is known.

---

# 25. Simple mental model

The system is a **laboratory**, not a trader.

| Component | Analogy |
|---|---|
| Raw cache | Lab notebook — what the instrument actually printed |
| Data spine | Memory, written once and never rewritten |
| PIT layer | Amnesia on demand — remembering only what was known then |
| Feature engine | Senses |
| Setup typing | Pattern recognition |
| Label engine | Hindsight, quarantined so it cannot leak backwards |
| Model | Probability judgement |
| Calibration | Knowing how much to trust your own judgement |
| Decision engine | Judgement |
| Risk core | Self-control |
| Kill switch | Reflex |
| Execution engine | Hands, which sometimes slip |
| Replay | Time machine |
| Protocol + registry | Scientific method, including the cost of having looked |
| Frozen holdout | The sealed envelope, opened once |

The sharpest one: **the frozen holdout is a sealed envelope**. Its value comes
entirely from being sealed. Peeking does not reduce its value — it destroys
it, and leaves behind a number that still looks trustworthy.

---

# 26. Glossary

**PIT (point-in-time)** Data as known at a moment, not as known now.

**`as_of`** The timestamp bounding a PIT read. Exclusive.

**Look-ahead bias** Using information that did not exist at decision time.

**Survivorship bias** Studying only entities that survived — e.g. today's
index membership applied to 2022.

**Corporate action** Split, bonus, consolidation, rights, dividend.

**Adjustment factor** The exact rational scaling history across an action.

**ISIN** A security identifier. **Not stable** — 279 reissues measured.

**Schema hash** Hash of the ordered feature list. Artifact identity.

**Feature block** A named, versioned group of features, ablatable as a unit.

**Ablation** Fitting with and without a block to isolate its contribution.

**Pre-registration** Writing the hypothesis and verdict rule *before* results.

**Anti-duplication** Ceiling (0.80) on correlation with existing features.

**Calibration** Turning scores into probabilities that mean what they say.

**Platt scaling** Logistic regression on the model's scores.

**Isotonic regression** A monotone, non-parametric calibrator.

**Log loss** Penalises confident wrong answers. Lower is better.

**Brier score** Mean squared error of probabilities.

**ECE** Expected Calibration Error — average gap between stated confidence and
observed frequency.

**AUC** Ranking quality. Invariant to monotone transforms, so it says nothing
about calibration.

**Purge** Removing training rows whose labels resolve inside the test window.

**Embargo** An additional gap after the purge.

**Holdout** Data never used for any decision. Currently untouched.

**Deflated threshold** `sqrt(2 ln N)` — the significance bar, raised by the
number of trials. Currently **3.178**.

**Clustered inference** Treating one value shared by many rows as one
observation.

**Triple-barrier** Target, stop, and time horizon; whichever is hit first.

**Slippage** The gap between decision price and fill price.

**Participation** Fraction of a bar's volume a single order may take. Capped
at 5 percent.

**Reservation** Cash committed at submission so concurrent orders cannot
collectively overspend.

**Idempotency** Running twice produces the same result as running once.

**Replay** Re-running a decision sequence and comparing digests.

**Label** The outcome of a decision: TARGET, STOP, NEITHER, PENDING.

**Horizon** How long a label may take to resolve. 21 sessions.

**OOD** Out-of-distribution — input unlike anything trained on.

**Abstention** Deciding not to trade. A first-class output.

**Setup** A named, pre-registered configuration worth acting on.

**VWAP** Volume-weighted average price.

**bps** Basis points. 1 bp = 0.01 percent. Round trip is 73.55 bps.

**Muhurat** NSE's ceremonial Diwali session — legitimately short.

---

# 27. One-page architecture

    GOAL           Prove or disprove a net-positive edge after real costs,
                   without fooling ourselves.
      |
    DATA           NSE bhavcopy and Fyers intraday, cached as received.
      |
    SPINE          One canonical bar, raw prices, four inviolable laws.
      |
    PIT            Nothing visible that did not exist at as_of.
      |
    FEATURES       19 numbers under a hashed, versioned schema.
      |
    SETUP/CONTEXT  Named configurations; market state. Partly built.
      |
    MODEL          A ladder that always includes the constant null.
      |
    CALIBRATION    Scores into probabilities that mean what they say.
      |
    DECISION       Act or abstain, after the 73.55 bps hurdle.
      |
    RISK           min(regime, health, ood) x drawdown, hard limits, kill switch.
      |
    EXECUTION      Orders that partially fill, expire and get rejected.
      |
    PAPER TRADING  SQLite WAL, sole-writer, restart is not a reset.
      |
    EVALUATION     Purged, embargoed, clustered where required.
      |
    LEARNING       Every trial counted; the holdout still sealed.
