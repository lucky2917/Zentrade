# The C++ boundary

**Status: no C++ production code exists in ZenTrade, and adding any today would
be wrong.** This document records why, and pre-draws the boundary so that when
the workload arrives it is an implementation task rather than an architecture
task.

---

## 1. Why not today

Measured in this repository, not estimated:

| Path | Cost |
|---|---|
| Reflex evaluation, Go | 28.99 ns/op, **0 B, 0 allocations** |
| Reflex evaluation, Node | 83 ns p50 · 208 ns p99 · 1,125 ns p99.9 under GC |
| Full detection, 100k-tick replay, Go | 150.4 ns/tick |
| Full detection, 100k-tick replay, Node | 186.3 ns/tick |
| Universe | 200 symbols |

At a generous 1,000 ticks/second the whole fast plane consumes **0.0083 % of one
core**. C++ would reclaim roughly 60 ns per tick against Go — about 60 µs per
second — and would cost manual memory management on the one path where a
use-after-free is a wrong trade, plus a third toolchain and a third class of
build failure.

The decisive number is elsewhere entirely: the reflex is **0.0056 %** of the
protective path it feeds. The other 99.9944 % is four serial Postgres
transactions at 2.236 ms p50 / 35.874 ms p99, against an instance whose bare
`SELECT 1` measures **322.6 ms p50**. Optimising the 0.0056 % in C++ is the
wrong end of the problem by five orders of magnitude.

**There is also nothing to compute.** ZenTrade consumes last-traded price and
cumulative session volume. There is no spread, no order-book imbalance, no queue
position, no depth. Microstructure code with no microstructure data would be
code that measures nothing.

---

## 2. The workload that would justify it

Level-2 market depth.

| | Today | With depth |
|---|---|---|
| Data per symbol | 1 price, 1 volume | 20 levels × 2 sides |
| Work per message | 3 integer compares | mutate a book, recompute derived state |
| Message rate | ~1k/s peak | **~100× that** |
| Data structure | map lookup | order book with per-price-level aggregation |

At that point the design question changes from "is the language fast enough" to
"what is the cache layout and where does allocation happen". Arena allocation,
struct-of-arrays level storage and the absence of a GC stop being decoration and
become the design. That is C++'s case, and it is a real one.

Derived quantities that would live there: bid-ask spread, depth imbalance,
weighted mid, queue position, microprice, book pressure, sweep detection,
iceberg inference.

---

## 3. The boundary, pre-drawn

```
   Level-2 depth frames
            │
            ▼
   ┌──────────────────────┐
   │  book engine (C++)   │   order book, microstructure derivation
   │  ── future ──        │   arena allocated, no GC, cache-conscious
   └──────────┬───────────┘
              │  zentrade.marketdata.event.v1   ← UNCHANGED
              ▼
   ┌──────────────────────┐
   │  fast plane (Go)     │   world state, reflex, detection, liveness
   └──────────┬───────────┘
              │  zentrade.marketdata.event.v1
              ▼
   ┌──────────────────────┐
   │ Senior Trader Brain  │   TypeScript
   └──────────────────────┘
```

**The engine emits the same `MarketEvent` the Go plane emits today.** Nothing
upstream or downstream changes. The contract in `contracts/market-data/v1/` is
already the interface, the golden fixtures are already the specification, and a
C++ implementation would execute the same fixtures the Node and Go
implementations execute.

The seam is already real, not aspirational: `MarketEvent` is emitted by an
`EventSink` interface, and a book engine would be one more producer behind it.

---

## 4. Preconditions — all of them, before a line is written

1. Depth data is actually subscribed and arriving.
2. Its message rate is **measured**, not assumed.
3. A Go implementation is built first and **profiled to saturation**. If Go
   holds, C++ is not needed — the same standard that rejected it for the tick
   path.
4. The derived quantities are specified and frozen in a contract version.
5. Golden fixtures exist for those quantities, generated from the incumbent.

**If step 3 shows Go keeping up, the answer stays no.** This document is not a
commitment to write C++; it is a commitment to know when to.

---

## 5. What would be wrong

Writing a C++ tick handler now, to have C++ in the repository. It would be
faster on a path that is already 4 orders of magnitude below saturation, it
would need its own parity fixtures and its own build, and the first
memory-safety bug would be in the code that decides whether to exit a position.

The interview answer is the honest one: **I measured, and the measurement said
no. So I drew the boundary and left it empty.**
