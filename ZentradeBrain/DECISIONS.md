# Decisions and measured facts

Findings about external systems and the reasoning behind non-obvious choices.
Recorded here because the code does not explain them and they cannot be
re-derived by reading it.

## Data sources

**NSE changed bhavcopy format in 2024.** Legacy `cm<DD><MON><YYYY>bhav.csv.zip`
serves 2021-06 to 2024-03. UDiFF `BhavCopy_NSE_CM_..._F_0000.csv.zip` serves
2024-01-01 onward. They overlap through early 2024, which is what makes the
parity test possible. Verified 0 mismatches across 3 overlapping sessions,
~2,100 symbols each, OHLCV and ISIN identical.

**Yahoo Finance is unusable from this network.** Every endpoint returns 429,
including the crumb endpoint, so no session can be established. Removed from
the plan entirely rather than retried.

**Corporate action announcement dates do not exist in the feed.** The API
exposes `caBroadcastDate` but it was empty on all 3,152 sampled rows. `known_at`
is therefore the ex-date, which is later than the true announcement. That errs
toward knowing less, the only safe direction for a point-in-time store.

**Fyers 1-minute depth is unverified.** No access token available. Nothing in
P1 depends on it.

## Identity

**Neither symbol nor ISIN is a stable key.** Measured across 449 sessions: 219
ISINs appear under more than one symbol (renames), and 279 symbols appear under
more than one ISIN (reissued on face-value changes). A company is the connected
component of the graph linking both over time. Entity id is the smallest ISIN
in the component, chosen because it is stable under insertion order.

Without this, five years of ZYDUSLIFE begins in 2022 and the CADILAHC years
read as a different company that ceased to exist.

## Corporate actions

**Consolidations scale history up, and that is correct.** NSE writes both
"Face Value Split ... From Rs 10 To Re 1" and "Consolidation Of Equity Shares
From Re 1 To Rs 10". Only the direction of the numbers separates them, so the
ratio decides the kind rather than the wording.

VERTOZ consolidated Re 1 to Rs 10 on 2025-06-25 and its close jumped 9.17 to
87.11. A price factor of 10 is right. An earlier check asserted every factor
was at or below 1; that assumption was false.

**Only bonus ratios and face-value changes carry a computable factor.**
Dividends, demergers and rights are retained with no factor rather than
guessed at. Rights issues do affect price but need the subscription price to
compute, which the feed does not give.

## Spine semantics (spine_v1, frozen)

Prices are stored raw as integer minor units and never adjusted in place.
Adjusting means every future split rewrites history and breaks byte-for-byte
reproducibility.

Timestamps are UTC microseconds. A daily bar is stamped at session close
(10:00 UTC), not midnight, because that is the first moment the bar is
complete. Midnight would place the bar before the information in it existed.

Bar identity is (venue, symbol, granularity, ts_utc). Ingestion is idempotent
on that key.

Adjustment factors live in their own table and are applied at read time, never
written into prices.

No row may carry information unavailable at its ts_utc.

Bars partition by time rather than symbol, matching the cross-sectional read
pattern the research loop runs constantly. Row-group statistics prune
single-symbol reads adequately without a partition per symbol.

`consolidation` was added to the adjustment kinds after the VERTOZ finding.
Additive: no existing row changes meaning.

## Approximations

**Turnover is close x volume.** The bhavcopy carries a true traded-value
column but the spine bar schema is frozen without it. This misprices days with
a wide intraday range. Tolerable because turnover is a ranking input, not a
traded quantity.

## Traps already hit

**`data/` in .gitignore must be anchored as `/data/`.** Unanchored, it also
matches `src/zentrade/adapters/data/`, which silently excluded the entire
data-adapter package from version control. Caught before the first commit.

**The wall-clock guard must resolve full dotted paths.** An earlier version
matched `datetime.now()` but missed `datetime.datetime.now()`, because it only
looked one attribute level deep. Found by injecting a deliberate violation
rather than trusting a green run.

**Long-running jobs must flush their output.** The backfill's progress log was
block-buffered, so a 45-minute job showed nothing until it finished.

**Rewriting a partition per session is O(days).** The spine writer rewrites a
whole partition per call, so the backfill batches by partition and writes once
per year.

## P2: canonical engine and replay

**Features must be computed on adjusted prices.** The engine originally read
raw bars and produced a `dist_from_252d_high` of -0.6362 for HDFCBANK, which
is implausible. HDFCBANK issued a Bonus 1:1 on 2025-08-26 and the raw close
halved from 1964.10 to 973.40, so every feature spanning that date compared
pre-bonus to post-bonus prices. Adjusted, the figure is -0.2779.

Adjustment now happens in the PIT source, bounded by as_of, using exact
rational arithmetic rather than exp/ln so repeated runs agree bit for bit.
Applying only actions effective at or before as_of is point-in-time correct:
the look-ahead risk is applying a FUTURE split, which the bound prevents.

**Turnover is invariant under adjustment.** Price scales by the factor and
volume by its inverse, so their product is unchanged. Confirmed on real data:
the liquidity screen returns an identical ranking adjusted or raw. This is why
the P1 screen was not corrupted by the same bug.

**The liquidity screen bypassed the PIT layer.** Written in P1, it called the
raw spine reader directly with its own as_of bound. Not leaking, but the
guarantee rested on one call site staying correct rather than on the boundary.
Now takes a PitDataSource like everything else.

**A shuffle test needs a positive control.** A shuffle test that always passes
proves nothing. The suite pairs it with an injected-leakage case that must
push AUC above 0.95, so a broken harness fails loudly rather than reporting
clean.

## P3: universal shadow labeling

**Labels use adjusted prices.** The M11 v1 note recorded corporate-action
adjustment as explicitly excluded and flagged the omission as a risk. P2 built
adjustment into the PIT layer, so labeling inherits it and the risk does not
carry over. A split no longer manufactures a fake stop-out.

**The decision session sets the levels but never resolves them.** Its close is
the entry and its bar feeds the ATR that derives target and stop, both
legitimate because the session has closed. The forward scan starts at the next
session. A test spiking the decision bar's high initially looked like leakage;
it was not. It widened the ATR and moved the levels, which is correct. The
real invariant is that resolution never happens at or before the decision
timestamp.

**Truncation invariance is what makes historical study possible.** Labels that
were final at one data horizon are byte-identical at a later one; only PENDING
ones move. Verified on real data across a three month gap: 44,771 final labels
compared, zero changed, and all 292 pending ones resolved.

**Most labels resolve early.** Median four sessions to resolution against a
21-session horizon, because a 1x ATR stop is close. That is why only a few
hundred labels sit PENDING at any as_of rather than a full horizon's worth.

**Ambiguity resolves to STOP.** A daily bar touching both levels cannot order
the intrabar events. Assuming the favourable ordering would flatter exactly
the results that matter most.

**Project root is derived from the package, not directory depth.** A driver
using parents[4] worked for modules two levels deep and silently pointed at
the wrong directory for one at three, producing an empty universe rather than
an error.

## P4: paper execution and cost model

**Latency is structural, not simulated.** An order is only eligible against a
bar strictly later than its submission timestamp, so there is no code path
from signal to fill within the same session. Nothing needs to remember to
insert a delay.

**Zero volume is not a rejection.** An accepted order facing an untradeable
session could not fill; the venue did not refuse it. REJECTED belongs to
submission time. The order ages toward expiry instead, which also means a
permanently suspended symbol releases its order rather than holding it
forever. The transition table caught this: ACCEPTED to REJECTED is not a legal
edge, and the table was right.

**Cash is reserved at submission and released on any terminal state.** Without
it, several orders sized independently against the same balance can
collectively overspend it. Reservation makes that arithmetically impossible
rather than unlikely.

**Bootstrap cost assumptions, none of them calibrated.** No realised fill
exists yet, so every rate is the published-rate estimate and every one is set
at or above the expected true value:

    brokerage        0.03% capped at Rs20
    STT              0.1% delivery both sides; 0.025% intraday sell only
    exchange txn     0.003%
    SEBI turnover    0.0001%
    stamp duty       0.015% delivery buy; 0.003% intraday buy
    GST              18% on brokerage + exchange + SEBI
    DP charge        Rs15.93 flat, delivery sell only

Measured on a real simulated book: 0.12% to 0.17% of turnover depending on
order size. All charges round UP, never down, because rounding a fee down
flatters exactly the results that matter.

**Slippage is half-spread plus square-root impact, times a conservatism
multiplier of 1.5.** The multiplier is not tuned and is not meant to be. It
exists so the first results cannot be flattered by an optimistic cost
assumption, and it should come down only when real fills justify it. Stage 3
of the cost plan refits this; stage 1 is where we are.

**A simulation that only fills cleanly proves nothing.** The first
verification run exercised only FILLED and passed 25 of 26 checks. The
scenario was too easy, not the code. It now deliberately submits oversized,
unaffordable and cancelled orders so partial fills, expiry, rejection and
ambiguity all run.

## P5: trading core and risk core

**Bounded composition, implemented as specified.** Regime confidence, strategy
health and novelty are three instruments pointed at one question, so they
compose by min. Drawdown is about the account rather than the model, so it is
a separate axis and multiplies. Exactly two factors, never four. Measured:
0.075 where the four-factor product would give 0.063.

**Fail closed means an unevaluable check is a rejection.** An unpriced symbol
or a missing timestamp means the state is unknown, and trading on unknown
state is the failure this component exists to prevent. There is no default-
allow path.

**Halted blocks entries but never exits.** Risk-reducing sells stay permitted
and are exempt from the turnover and trade-count budgets, because a budget
that prevents you closing a position is a budget that traps you in one.
Kill-switch engagement cancels working orders and stops new entries; it does
not flatten, per the paper-trading risk policy.

**The kill switch cannot reset itself.** Engaging is automatic and cheap.
Disengaging requires a named operator. A switch that resets itself is not a
kill switch.

**Snapshots hand out copies.** Research receives fresh containers every call,
so mutating what it receives cannot reach authoritative state. Sole-writer is
enforced structurally rather than by convention.

**A limit that never binds is a limit that was never tested.** The first
hostile sweep asserted no exposure breach and passed trivially: with five
symbols the per-symbol limit binds first every time, so gross and sector were
never approached. A long-only book also has gross equal to net, so whichever
is lower dominates the other entirely. Each value limit now gets a
configuration in which it is genuinely the tightest, and is driven until it
binds.

**Default limits**

    position value        Rs 5,00,000 per symbol
    gross exposure        Rs 50,00,000
    net exposure          Rs 40,00,000
    sector exposure       Rs 15,00,000
    symbols held          25
    trades per session    20
    turnover per session  Rs 1,00,00,000
    daily loss            Rs 2,50,000      -> kill switch
    max drawdown          20%              -> kill switch
    price drift           100 bps
    proposal age          5 minutes
    viability floor       Rs 10,000
    drawdown ladder       5% -> 0.8, 10% -> 0.6, 15% -> 0.3

## P5 persistence: SQLite WAL core

**Sole-writer is enforced by the database, not by discipline.** The Core opens
core.db read-write; everything else opens it with mode=ro, where SQLite itself
refuses the write. A second writer taking BEGIN IMMEDIATE is refused by the
file lock. The invariant is physical.

**Constraints live in the schema, not only in Python.** positions.quantity has
a CHECK for strictly positive, orders has CHECK(filled_quantity <= quantity),
and client_order_id is UNIQUE. Duplicate orders and negative positions are
impossible at the storage layer even if a caller is wrong.

**One transaction per checkpoint.** A partial write is not a state the Core
can be in, so the whole snapshot commits together or not at all.

**The journal is the record; materialised state is a checkpoint.**
replay_positions rebuilds cash and positions from the fill log alone, and
journal_agrees_with_state asserts the two match. If they ever disagree the
checkpoint is wrong and the journal wins.

**Restart is not a reset.** Kill state, reason, trip count and system state all
persist. A process that comes back up with an engaged switch stays halted
until a named operator resets it.

**In-flight orders recover as AMBIGUOUS and halt.** A process that died with
orders working cannot know whether they filled. Marking them either way
diverges from the venue, so recovery marks them AMBIGUOUS, engages the switch
with EXECUTION_DIVERGENCE and waits for reconciliation. This is the frozen
spec's rule that ambiguous order state halts rather than guesses.

**Exits under HALTED still obey correctness.** Being allowed to exit is not
being allowed to exit incorrectly: an oversized sell is still refused for
insufficient position, and cash and quantity conservation still hold.

## P6: baseline predictor and calibration

**No model demonstrated out-of-sample value after costs.** This is the result,
not a setback, and it was reached without forcing a promotion.

**The cost hurdle exceeds the average gross move.** Round trip is 73.55 bps
against a mean forward return of roughly 30 bps on the evaluation window.
Random entry at every rate returns about -44 bps net. That is the number any
edge has to clear before anything else matters.

**The base rate is not stationary.** TRAIN 0.4162, CALIBRATION 0.3132,
EVALUATION 0.3588. A ten point swing in how often a 2x ATR target is reached
before a 1x ATR stop. A model fitted at 41.6 percent is miscalibrated by
construction on a 35.9 percent period, which is exactly what the results show.

**Two apparent positives were artifacts, and both were killed.** A constant
predictor has no spread, so its "top decile" is whichever rows argsort left
first, which here means the alphabetically earliest symbols. That produced a
spurious +27.64 bps at t=3.49. Selections now detect ties and report degenerate
rankings rather than attributing a return to a signal that does not exist.
Separately, a p>=0.35 tail of 98 rows out of 24,066 showed +94 bps at t=1.17,
below the deflated threshold of 2.23 at twelve trials. Every decision metric
now carries a t-statistic, because a net return with no t-statistic beside it
is a number rather than evidence.

**Cost arithmetic does not belong in core/.** The architecture guard caught
learning importing core.costs. The boundary exists to stop Research and
Learning trading or mutating state, not to stop them costing a trade they are
only measuring, so costs moved to the package root and Side lifted into the
kernel. The guard was right and the fix was structural, not an exemption.

**High volatility is the only regime near break-even.** LOW -52.59 bps,
MID -74.96 bps, HIGH -3.80 bps net. Not evidence of anything yet, and it comes
from a tercile proxy rather than the frozen taxonomy, but it is where a later
search would start.

## Development protocol (protocol_v1)

**The P6 evaluation window is a frozen holdout: 2025-08-05 to 2026-08-25.**
Development runs on 2022-06-03 to 2025-07-09 and is split again inside itself
into dev-train, dev-calibration and dev-validation. Every decision about a
feature, threshold or model is made on dev-validation.

The holdout's value comes entirely from never having informed anything, so a
single look destroys it permanently and silently. `assert_no_holdout` runs
before anything is fitted, and `HoldoutLedger` makes a look an explicit
recorded act rather than an ordinary function call. Looks recorded so far: 0.

## Feature block 1: relative strength — REJECTED

Three features against the cross-section of the same session: excess return at
5 and 21 days, and percentile rank of 21-day return. Sector-relative and
beta-adjusted variants were not built: the spine carries no sector map and no
index series, and inventing either would make the block untestable rather than
complete.

**Verdict: 0 of 12 configurations improved significantly.** Best was
logistic_unpenalised with Platt at t=1.70 against a deflated threshold of 2.68
at 36 cumulative trials. Several configurations were significantly worse, the
identity-calibrated arms at t=-4.40 and -4.36, which is three extra parameters
adding variance without signal.

**The first verdict rule was wrong and was replaced.** It compared best arm
against best arm, which selected isotonic in one arm and Platt in the other
and reported that selection as if it were the block. The test is now paired:
same model, same calibrator, same rows, only the features differ. That is the
only comparison that answers whether the block adds information.

**A rejected block cannot enter an active schema.** `require_active` refuses
it. The code stays as the record of the trial; what it may not do is quietly
become part of what the system runs on.

**Worth carrying forward:** on dev-validation the ranked top decile returned
-16.90 bps net against random entry at -108.31 bps. The models rank better
than chance while still losing money, because the whole window had a negative
mean gross return. Ranking is not the binding problem; the cost hurdle is.

## Feature block 2: multi-timeframe alignment — REJECTED

Three sign-agreement encodings over the horizons already in the base block:
weighted alignment across five horizons, short-versus-long conflict, and
adjacent-pair dispersion. The block adds no new data, only an encoding a
linear model cannot reach: agreement is a sign interaction rather than a
weighted sum, so a logistic regression on the levels cannot express it.

Measured correlation against the horizons the features derive from:
conflict 0.124, dispersion 0.122, alignment 0.742. The first two are
near-orthogonal, which is what v4 6.1 predicted. Alignment passes the 0.8
anti-duplication rule but is the weakest of the three.

**Verdict: 0 of 12 configurations improved significantly at t>2.86.** Best was
logistic_unpenalised with isotonic at t=1.77.

**The failure mode differs from block 1 and the difference matters.** Relative
strength made several configurations significantly worse, at t=-4.40, which is
extra parameters buying variance. Multi-timeframe alignment made nothing
significantly worse, worst case t=-0.12, and four of twelve improved without
reaching significance. It is harmless rather than harmful, which is what an
encoding with a real but small effect looks like when the sample cannot
resolve it.

**Two v4 features were deliberately not built.** `compression_state`
duplicates `vol_compression` already in the base block, and
`htf_level_distance` would correlate with the existing 252-day extreme
distances. Adding either would have violated the anti-duplication rule to
inflate the block.

**Data limitation: daily horizons only.** The spine holds daily bars and the
Fyers 1-minute probe is still blocked on a token, so 1m to 1h alignment could
not be built or tested. This result rejects daily horizon alignment and says
nothing about intraday alignment, which is where v4 6.2 expected the effect to
live.

## Economic observation, recorded separately

On the development validation window the ranked top decile returned -16.90 bps
net against random entry at -108.31 bps. Ranking is meaningfully better than
chance while still losing money, because that window's mean gross return was
negative and the round-trip hurdle is 73.55 bps.

Recorded as an observation only. It was not used to select, tune or judge
either feature block, and it should not be: it points at horizon, turnover and
cost structure rather than at features, and acting on it inside a feature
experiment would be exactly the contamination the protocol exists to prevent.

## Search inflation is being charged

The deflated threshold has risen from 2.23 at 12 trials to 2.86 at 60. Each
block tested raises the bar for the next one, which is the intended behaviour:
testing more hypotheses raises the evidence required rather than the evidence
available.

## Feature block 3: trade location — PENDING an operator ruling

Three features, each an existing percent distance divided by atr14_pct:
extension_atr_20, extension_atr_50, high_distance_atr. The hypothesis was that
five percent above a moving average is an extended position in a quiet name
and noise in a volatile one, and that a linear model cannot recover this from
the distance and the ATR separately because a ratio is not a weighted sum.

**Two frozen rules disagree, so the block is held rather than decided.**

The pre-registered paired test says KEEP. Three of twelve configurations
improve significantly at t>2.98: logistic_elasticnet/identity t=4.56,
logistic_unpenalised/identity t=4.41, logistic_elasticnet/platt t=3.21.
Nothing is significantly worse.

The v4 5.3 anti-duplication rule says REJECT. The three features correlate
0.920, 0.917 and 0.855 with the percent distances they divide, against a 0.80
ceiling. My hypothesis was wrong about why: ATR varies far less across the
cross-section than the distance does, so each ratio is dominated by its
numerator.

**A caveat that matters more than either rule.** Two of the three significant
results sit on the identity calibrator, which has the worst absolute log loss
at 0.6467 against 0.6264 for the calibrated arms. The improvement shrinks as
calibration improves: identity 0.00098, platt 0.00033, isotonic 0.00014. That
pattern says much of what the block adds is calibration-like information,
useful to an uncalibrated model and largely redundant once Platt or isotonic
has already pulled predictions toward the base rate. Exactly one significant
improvement lands on a well-calibrated configuration.

Effect size is 0.0004 log loss, roughly 0.06 percent relative.

Four v4 trade-location features could not be built: distance_from_trigger and
time_since_trigger need setup typing, distance_from_vwap needs a turnover
column the frozen bar schema lacks (the bhavcopy carries traded value and
quantity, whose ratio is exactly daily VWAP), time_since_catalyst needs the
Event Store, and session_phase needs intraday timestamps.

A PENDING status was added so the block is neither active nor rejected, and
require_active now gates on ACTIVE rather than merely excluding REJECTED.

## Economic observation, still recorded separately

Unchanged and still not used to tune anything. On dev-validation the ranked
top decile returns -10.96 to -24.72 bps net against random entry at -108.31
bps. Ranking beats chance; net economics stay negative because the round-trip
hurdle is 73.55 bps against a window whose mean gross return was negative.
The one positive selection this round, top 5 percent at +33.56 bps, carries
t=1.47 and is not significant.

## Block 3 ruling and future variants

Operator ruling 2026-08-28: trade location REJECTED on four grounds. The three
features breach the anti-duplication ceiling at 0.920, 0.917 and 0.855; the
benefit concentrates in the poorly calibrated identity configuration; it
shrinks materially under proper calibration; and the remaining calibrated
effect is too small to justify permanent schema complexity.

The ruling rejects what was tested, not trade-location intelligence. Five
variants are recorded as FUTURE/UNTESTED with the change each is blocked on,
and none has been built or measured:

    distance_from_trigger   setup typing, which defines a trigger at all
    time_since_trigger      setup typing plus intraday timestamps
    distance_from_vwap      a turnover column in the bar schema. The bhavcopy
                            carries traded value and quantity and their ratio
                            is exactly daily VWAP, so this is a spine_v2
                            change rather than a data gap
    time_since_catalyst     the Event Store, not built
    session_phase           intraday timestamps

## Feature block 4: market context — REJECTED, and the reason matters

Three features: breadth above the 20-day average, breadth advancing, and
cross-sectional dispersion of 21-day returns. All computed from the same
session's universe.

**This block passed the anti-duplication gate cleanly**, max correlation 0.446
against a 0.80 ceiling, so unlike block 3 it fails on evidence rather than
redundancy.

**The result worth keeping is the inflation, not the verdict.** A market
feature takes one value per session, shared by every row that session carries.
Treating 14,350 rows as independent observations of something that varies 161
times overstates the evidence by roughly the square root of rows per session.

    configuration                     raw t    clustered t
    logistic_unpenalised / identity    4.46           0.98
    logistic_elasticnet  / identity    4.41           0.97
    logistic_elasticnet  / platt       1.71           0.76

The raw figures clear the 3.06 threshold comfortably. The clustered ones are
nowhere near it. Without day-clustered inference this block would have been
promoted on noise, which is precisely the failure v4 0.1 and 4 predicted.

The clustering was verified before use on a synthetic case with perfect
intra-cluster correlation: it recovered a 7.09x inflation against a
theoretical 7.07x, collapsing a spurious t=8.65 to t=1.22.

**Every block from here that varies at the market or sector level must use
clustered inference.** Symbol-level blocks may continue with the per-row test.

## Feature block 5: setup typing — pre-registered rule returns KEEP, held PENDING

Seven mutually exclusive types resolved by a fixed priority order, encoded as
seven binary indicators with `none` as the reference level. `event_driven`,
the eighth type in v4 8.1, was not built because it needs the Event Store.

**First block to satisfy its pre-registered rule with no competing rule
objecting.** 5 of 12 configurations improve significantly at t>3.12, none is
worse, and anti-duplication passes cleanly at 0.448 against the 0.80 ceiling.

**The improvement survives calibration, which is what separates it from trade
location.** Block 3's benefit collapsed from 0.00098 at identity to 0.00014 at
isotonic, which said it was substituting for calibration. Here it holds:
identity 0.00092, platt 0.00046, isotonic 0.00069, and both platt and isotonic
arms clear the threshold at 4.56, 4.49 and 3.21.

**Four caveats that belong beside the verdict.**

Only 1 of 7 types is individually distinguishable from the pooled hit rate,
volatility_expansion at z=-2.43, and with seven tests a Bonferroni threshold
of 2.69 means even that one does not survive multiplicity. The types do not
have different payoffs.

The fitted weight concentrates in that same type: coefficient -0.0406 against
a mean of 0.0151 across the seven, and 0.0363 across the base features. Seven
features were added and roughly one carries the effect.

The mechanism is therefore not what the block's name suggests. A linear model
cannot represent conjunctions, so the dummies act as regional intercept
corrections for a misspecified model rather than as evidence that setups
differentiate payoff. That is real value, but it is a statement about the
model's shape rather than about the market's.

Net economics remain negative at every selection depth. Ranking improves,
top decile from -24.72 to -9.81 bps, and the 73.55 bps hurdle still dominates.

Effect size is roughly 0.1 percent relative on log loss.

Held PENDING rather than activated: changing the live schema is an operator
decision, and the same discipline applied to block 3.

## Standing rule confirmed

Market and sector-varying features require clustered inference, permanently.
Symbol-level blocks may continue with the per-row paired test. Setup typing is
symbol-level, so the per-row test was correct here and clustering was neither
required nor used.

## Block 5 ruling: setup_typing v1 ACTIVATED

Operator ruling 2026-08-28. Active schema becomes
(symbol_technical, setup_typing), 19 features.

    previous  6b1d5f9218e2c08d35ea6510fdc71f1942726fba386104dc613163234256566a
    ACTIVE    f1a55535a4c02540b34b2947b6a9b000e980f72279d261ba9d8b7cd23e5cb392

The hash change means every artifact fitted against features_v1 now fails to
load. That is the schema gate working, not a regression.

Constraints recorded with the ruling and stored on the block itself rather
than only in a changelog:

1. NOT evidence of positive net trading edge. Net economics remain negative
   while the cost hurdle dominates.
2. The gain is an incremental correction to model misspecification, not proof
   that setup labels are alpha.
3. The seven definitions and thresholds are pre-registered and must not be
   tuned on these results.
4. mean_reversion and breakdown are thin-support categories, recorded in
   SETUP_THIN_SUPPORT.
5. setup_typing stays independently versioned and ablatable.

## The ablation control is now the live schema

Every subsequent block is tested against whatever is active, not against
base-only. Comparing a new block to a stale baseline would credit it with
gains an already-accepted block is delivering.

## Feature block 6: contradiction — REJECTED

Three conjunctions of opposing signals: unconfirmed_strength, momentum
divergence, and volume without progress. Tested against base plus
setup_typing, not base alone.

0 of 12 configurations improved significantly at t>3.178; best reached 2.55.
Nothing was significantly worse, so this is the harmless-not-helpful pattern
rather than added variance. Anti-duplication passed at 0.392.

htf_conflict was deliberately not re-tested. It was part of block 2, which was
rejected, and re-running a rejected feature inside a new block would launder
it past its own result.

**An ordering effect worth stating.** At block 1's threshold of 2.23 this
block would have passed. It does not now because 156 trials have accumulated.
The penalty is correct, since testing more hypotheses should raise the
evidence required rather than the evidence available, but it does mean the
order blocks are tested in affects which of them clear. A block tested early
faces a lower bar than the same block tested late.

## Data capability audit (2026-08-28)

Feature research on daily data is frozen. Every capability below was probed
against a live source rather than recalled. Five of nine are obtainable, four
of them cheaply, and one is already in the cache.

**Four capabilities recorded as blocked were not blocked.** They were assumed
unavailable rather than checked.

**VWAP is already on disk.** Every bhavcopy carries traded value and traded
quantity in both formats. Their ratio landed inside the session low-high range
on 2,865 of 2,865 UDiFF rows and 2,128 of 2,128 legacy rows. Only a schema
column separates the system from it.

**The announcement feed has better timestamps than the one already in use.**
NSE corporate-announcements carries exchdisstime, populated to the second on
2,594 of 2,594 sampled rows, back to at least 2020-01. The corporate-actions
feed already consumed has an equivalent field empty on all 3,152 rows.

**Sectoral indices remove the point-in-time problem a sector map creates.**
One daily file carries 165 indices including 50 sectoral ones, verified to
2019-01. A symbol-to-sector map is a current snapshot and using it for 2022
would be a mild look-ahead; comparing against a sector index needs no
membership map at all.

**Order flow does not exist at this access level.** No free NSE archive carries
depth or aggressor side, and Fyers streams live only, so there is no history to
train on. v4 7.4's ruling is confirmed.

Two rejected blocks were rejected partly for missing data that exists.
Relative strength used a universe average because no sector or index series was
available, and market context used a universe proxy for the same reason.
Neither result is invalidated, since both were tested honestly against what was
available, but neither settles the question its block was asking.

### Sequence

    0  run the Fyers depth probe          one command, ~12 calls
       Gates capabilities 1, 2 and 3, and would reorder everything below.
       Not knowing this number is the largest avoidable unknown in the project.
    1  spine_v2 turnover + trade_count    no network, rebuild from cache
    2  index_bars table                   ~1,300 requests, ~13 MB
    3  delivery data into spine_v2        ~1,300 requests, ~325 MB
    4  Event Store from announcements     ~260 requests, highest complexity
    -  order flow: never, the data does not exist

Nothing is built until step 0 has run. The sequence assumes intraday is
unavailable; if it proves deep, the intraday capabilities move to the front.

## spine_v2 intraday storage

The probe returned INTRADAY-FIRST, so the spine gained 1m, 5m and 15m
alongside the existing daily. The four spine laws are unchanged. spine_v2 is a
superset of spine_v1, not a reinterpretation of it.

**The daily migration is proven, not assumed.** Bumping SEMANTICS_ID moves the
whole tree, so daily was rebuilt under v2 from the bhavcopy cache with no
network. All six year partitions came back byte-identical to v1, 2,778,160
rows across 1,296 sessions, 2021-06-01 to 2026-08-27. A copy would have been
faster and would have proven nothing.

**The adjustment table could not be rebuilt the same way.** Corporate actions
are fetched live and there is no raw cache behind them, unlike bhavcopy, so
that one file was copied forward and verified identical by hash. This is a real
gap: the adjustment table is the only part of the spine that is not
reproducible offline. Worth closing when corpactions next needs a change.

**Deduplication is enforced at parse time, not left to the writer.** The writer
already deduped on (ts_utc, symbol) and would have absorbed provider
duplication silently. Catching it in the parser makes the count visible.
Measured on a full 100-day 15m request for RELIANCE: 1,775 raw candles, 1,750
distinct, 25 dropped, exactly one trailing session repeated. The 30-day sample
showed zero duplicates, so a sample-only test would have proven nothing about
the dedup path.

**The provider stream is not chronological when it duplicates.** The same
100-day request tripped the unordered-file flag. The parser's sort is
load-bearing, not tidiness.

**lookback_sessions counts bars, so it needed a granularity divisor.** At 1m a
request for 375 would previously have bought 375 calendar days of window
instead of one session. SpinePitSource now divides by bars_per_session, which
leaves daily behaviour unchanged because daily yields one bar per session.

**as_of is exclusive at the reader, so the FutureDataRequested guard is
unreachable through read_bars.** read_bars filters ts_utc < end_ts, so a bar
stamped exactly at as_of is dropped before the guard sees it. The guard stays
as defence against a future reader change. The harness now tests both halves
separately: that the reader withholds the bar at as_of, and that the guard
fires when a source does hand one back.

### Sample validation, 2026-08-28

3 symbols (RELIANCE, TCS, SBIN), June 2026, all three granularities, 63
symbol-sessions each. verify_intraday.py: 33/33.

    granularity   rows     per session   sessions   IST span
    1m            23,625   375 exact     21         09:15..15:29
    5m             4,725    75 exact     21         09:15..15:25
    15m            1,575    25 exact     21         09:15..15:15

Every symbol-session is exactly complete, no duplicates, no out-of-session
stamps, chronological per symbol, no sessions missing against the daily spine,
re-ingestion inserts nothing and leaves bytes stable, and a clean-room rebuild
into a fresh tree is byte-identical.

State invariants after the migration: holdout looks 0, trial count 156
(threshold 3.178), active schema (symbol_technical, setup_typing), 19 features.
No model was fitted in this phase.

## Intraday session boundary, corrected during the full backfill

The first spine_v2 rule admitted any bar stamped at or before 15:30. That is
wrong. A bar stamped T covers [T, T + interval), so it belongs to the session
only if it closes by the bell, and the last valid stamp is 15:29 at 1m, 15:25
at 5m and 15:15 at 15m.

The June sample never exposed this because Fyers did not emit a 15:30 bar in
that month. The full archive does: 45 fifteen-minute bars stamped exactly
15:30, each one a 26th candle in a 25-candle session. The bug was found by the
over-count check, not by the out-of-session check, which had been written
against the same wrong constant.

`last_bar_minute` now derives the cutoff from the interval, and the three
values it produces match the maxima independently observed in the June sample.

**Correcting a parse rule requires a purge, not a re-ingest.** write_bars
merges incoming rows into whatever the partition already holds, which is what
makes ingestion idempotent, but it also means a row the parser has stopped
emitting survives another pass. intraday_backfill grew an explicit --rebuild
that drops the granularity's partitions first. It refuses any granularity that
is not intraday.

**Verification must not run against a cache that is still being written.** The
harness read a growing cache mid-backfill and reported idempotency and
clean-room failures that were pure artefacts. It now detects a running fetch
and skips the cache-dependent checks rather than reporting a false negative.

**Bulk backfill runs at the provider cap, not the idle policy.** MODE_RATES
throttles to 1 req/s outside market hours, which is a politeness policy for
quiet live-trading periods. PER_MINUTE_CAP is the provider constraint. At the
idle rate the full archive takes long enough that the access token expires
mid-run, so the backfill script raises its own limiter to the cap and leaves
the shared policy alone.
