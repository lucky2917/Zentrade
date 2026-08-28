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
