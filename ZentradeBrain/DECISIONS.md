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
