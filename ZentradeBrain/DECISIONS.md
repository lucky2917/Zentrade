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
