# Selective Go / C++ architecture

Written 2026-08-30. Supersedes the "migrate to Go or C++" framing in
`docs/TECHNOLOGY_MIGRATION_ARCHITECTURE.md` and
`docs/OPTIMAL_TECH_STACK_AND_MIGRATION_AUDIT.md`.

ZenTrade is intentionally polyglot. Each boundary below is justified by a
measurement or by a structural property, and the ones that are not justified are
rejected in writing.

---

## 1. Current architecture

One Node process owns everything on the live path:

```
Fyers HSM socket ──> sanitiseTick ──> reflex lane (Tier 0)
                            ├────────> Redis cache + pub/sub
                            └────────> bar aggregator (Tier 1)

same process also runs:
  observation + anomaly pass (Tier 2)      every 15 s
  reasoning, 2 LLM calls per event         seconds each
  Express API, Socket.io fan-out
  Postgres execution engine (Tier 4/5)
  REST polling behind a per-process rate limiter
  nightly labeler / calibration / memory / reflection jobs
```

A second Node process for research support, a Python research stack
(`ZentradeBrain/`), and a Go library (`go/marketdata`, `go/decision`) that
nothing in production calls yet.

**The structural fact:** tick receipt, deterministic protection, LLM
orchestration and HTTP serving share one event loop and one process lifetime.

---

## 2. Target architecture

```
        ┌──────────────── FAST MARKET PLANE ────────────────┐
        │                                                    │
  Fyers HSM socket                                           │
        │  (vendor SDK, Node — see §4.0)                     │
        ▼                                                    │
  feed edge  ── normalised tick ─────────────────────────────┤
  (Node, minimal)   zentrade.marketdata.tick.v1              │
        │                                                    │
        ▼                                                    │
  marketdatad (Go)                                           │
    · live world state, sharded per symbol                   │
    · deterministic reflex on pre-committed levels           │
    · continuous material-change detection                   │
    · feed liveness / staleness                              │
    · single-owner enforcement                               │
        │                                                    │
        │  material event  zentrade.marketdata.event.v1      │
        └──────────────────────┬─────────────────────────────┘
                               ▼
                    SENIOR TRADER BRAIN  (TypeScript / Node)
                      thesis · counter-thesis · alternatives
                      evidence hierarchy · regime · R:R · EV
                      opportunity cost · fresh-world revalidation
                               │
                               ▼
                    HARD RISK GATE      (TypeScript, deterministic)
                               │
                               ▼
                    EXECUTION           (TypeScript + Postgres)
                               │
                               ▼
                    MONITORING ──────────────────────────────↺

        RESEARCH PLANE (Python): PIT · spine · Polars · DuckDB ·
        features · training · calibration · replay · backtest
```

Two invariants the boundary exists to enforce:

- **The fast market plane never waits for the LLM.** It cannot: no model client
  is linked into it.
- **The Senior Trader Brain is never responsible for deterministic safety.** It
  cannot be: the pre-committed levels are evaluated on the other side of a
  process boundary.

---

## 3. Component-to-language matrix

| Component | Today | Target | Why |
|---|---|---|---|
| Fyers HSM data socket | Node (vendor SDK) | **Node, isolated process** | vendor protocol is obfuscated; see §4.0 |
| Tick normalisation | Node | Node feed edge | must sit with the SDK that produces the raw frame |
| Live world state | Node | **Go** | long-running, per-symbol concurrent, zero-alloc |
| Deterministic reflex | Node | **Go** | must not share a lifetime or a loop with the brain |
| Continuous detection | Node | **Go** | same plane as the state it reads |
| Feed liveness / staleness | Node | **Go** | timer-driven supervision of the plane it owns |
| Bar aggregation | Node | Node (review later) | Redis-bound, 0.047 ms after the incremental fix |
| Observation / anomaly (Tier 2) | Node | Node | 13.57 ms per pass, bar cadence, not a bottleneck |
| Senior reasoning pipeline | Node | **Node** | LLM-bound; see §7 |
| Risk gate | Node | **Node** | must sit with the decision it gates |
| Execution + ledger | Node + Postgres | **Node** | I/O-bound on Postgres; see §7 |
| Reconciliation | Node | Node | I/O-bound |
| REST client + rate limiter | Node | Node, single owner | see §5.3 |
| Express API, Socket.io | Node | **Node** | orchestration and fan-out |
| Operator surface | Node | **Node** | |
| PIT / spine / features / training | Python | **Python** | see §7 |
| Backtest / replay | Python | **Python** | |
| Decision parity harness | Go | Go | already used for cross-runtime checks |
| Order book / microstructure | — | **C++, future** | see §4 |

---

## 4. C++ candidates — evaluated and rejected for today

### 4.0 A prerequisite finding

`node_modules/fyers-api-v3/HSM/datasocket.min.js` (79 KB) and
`HSM_Package/hslib.js` (58 KB) are **fully obfuscated**, the package ships
`javascript-obfuscator` as a dev dependency, and there is **no `.proto` schema in
the package** despite `protobufjs` being a runtime dependency.

The Fyers HSM data socket is therefore a proprietary binary protocol with no
published schema. Reimplementing it in Go or C++ means reverse-engineering
obfuscated code against a venue that cannot be exercised outside market hours.

**That is the definition of speculative code, and it is rejected.** The vendor
SDK stays in Node. This is a vendor constraint, not a language preference, and
it is the reason the fast plane is split into a feed edge and a state plane
rather than being one Go service.

### 4.1 Tick hot path — REJECTED

| Question | Answer |
|---|---|
| Current bottleneck | none |
| Measured | Node 83 ns p50, 208 ns p99, 1,125 ns p99.9 under GC. Go 21.05 ns/op, 0 allocs |
| Bound by | nothing; it is arithmetic on a map lookup |
| Load | 200 symbols. At a generous 1,000 ticks/s the Node reflex consumes 83 µs per second, **0.0083 % of one core** |

C++ would save roughly 60 ns per tick against Go and about 3 µs per second in
total. It would cost manual memory management on the one path where a
use-after-free is a wrong trade, a third toolchain, and a third set of build and
deploy failures. **Rejected. The workload is four orders of magnitude below
saturation.**

### 4.2 Market-state updates — REJECTED

Per-symbol map write, three integer comparisons, one counter. 21 ns in Go with
zero allocations. There is nothing for C++ to reclaim.

### 4.3 Deterministic reflex — REJECTED

Same measurement. The reflex is **0.0056 %** of the protective path it feeds;
the other 99.9944 % is four serial Postgres transactions at 2.236 ms p50 /
35.874 ms p99, against a managed instance whose bare `SELECT 1` is **322.6 ms
p50**. Rewriting the 0.0056 % in C++ is the wrong end of the problem by five
orders of magnitude. **The real work here is collapsing four transactions into
one, and that is a SQL change, not a language change.**

### 4.4 Microstructure calculations — REJECTED TODAY

None exist. ZenTrade consumes last-traded price and cumulative session volume.
There is no spread, no imbalance, no queue position, no depth. There is nothing
to compute.

### 4.5 High-frequency event processing — REJECTED

Peak material-event rate is bounded by the event queue at 200 items with
per-(symbol, type) coalescing, drained 6 at a time. This is human-scale.

### 4.6 Level-2 / order-book processing — **FUTURE CANDIDATE**

This is the one place C++ would earn its keep, and it is documented rather than
built.

If ZenTrade consumes full market depth: 200 symbols × 20 levels × 2 sides, with
every update mutating a book and recomputing derived microstructure. That is
roughly **100× the current message rate with per-message data-structure
mutation** rather than a scalar compare. At that point cache layout, arena
allocation and the absence of a GC stop being decoration and start being the
design.

**The boundary is pre-drawn:** a book engine would sit inside the fast market
plane, behind `zentrade.marketdata.v1`, consuming raw depth frames and emitting
the same `MarketEvent` type the Go lane emits today. Nothing upstream or
downstream changes. **No speculative code is written until depth data exists and
its rate is measured.**

### 4.7 Large-universe numerical processing — REJECTED, belongs to Python

Feature engineering over 75.8 M rows already runs in Polars and DuckDB, which
are themselves Rust and C++ underneath. Writing our own C++ to compete with
them would be slower and less correct. **Python already is the C++ here.**

---

## 5. Go candidates

### 5.1 Deterministic fast plane — **ACCEPTED, this migration**

The eleven questions:

**1. What is the current bottleneck?** Not throughput. It is *coupling*. Tick
receipt, deterministic protection, LLM orchestration and HTTP serving share one
event loop and one process lifetime.

**2. What is the measured latency/throughput?** Reflex evaluation 83 ns p50.
But before the incremental-bar fix, a tick arriving at a minute boundary waited
**86.844 ms p50, 95.035 ms max** to be evaluated, because 200 symbols rebuilt
derived bars synchronously on the same loop. That was one identified CPU
consumer on a loop that hosts many.

**3. CPU, I/O, concurrency or event-loop bound?** **Event-loop bound**, and
lifetime-coupled. The reflex is not slow; it is *interruptible by unrelated
work*, and it dies whenever the brain dies.

**4. Why does the current language become a limitation?** It does not, at this
volume. Node evaluates the reflex in 83 ns and that is fast enough. The
limitation is the **single-threaded shared loop and the shared process
lifetime** — and `index.js` exits the process on `uncaughtException`, so any
unhandled error anywhere in the brain drops the market feed mid-session.

**5. Why Go?** A separate process is the fix, and the language question is which
one. Go because: the work is naturally per-symbol concurrent and shards cleanly
across cores (measured, 5.4×); the **protective** path compiles to zero
allocations, so there is no GC tail on the path that must never pause; a single
static binary has no `node_modules` and a ~10 MB RSS; and — the argument that
actually decides it — **a language boundary makes accretion structurally
impossible**. Note what is NOT in that list: raw speed. On the real detection
workload Go is 1.35× Node, which is not a reason to migrate anything. A minimal Node edge process would
give the same isolation today and would drift back into a brain within a
quarter, because adding an import is free. Across a language boundary, adding a
model client to the deterministic safety path is not a temptation, it is a
rewrite.

**6. Why C++?** It is not. See §4.3. The margin over Go is ~60 ns on a path
consuming 0.0083 % of a core.

**7. Why NOT TypeScript?** Honest answer: TypeScript in a separate minimal
process would work at today's volume. It is rejected on the structural argument
in (5) and on the GC tail (p99.9 1,125 ns vs 21 ns, a 40× difference that does
not matter today and will matter with depth data), **not** on throughput. Anyone
claiming Node is too slow for 1,000 ticks/s is wrong.

**8. Why NOT Python?** GIL, allocation per tick, and no reason to introduce a
third runtime on the latency-sensitive path when the research plane already owns
Python for what Python is good at.

**9. What system-level improvement should result?** The feed and the
deterministic protection survive a brain restart. Protection cannot be delayed
by reasoning, HTTP or a nightly job. The safety path becomes auditable in
isolation: one binary, one contract, one set of fixtures.

**10. What complexity does this introduce?** A second deployable, a process
boundary on the tick path (measured at **708 ns, 305 bytes** per event), a
versioned contract that must be kept in step, two runtimes to observe, and
cross-language parity to maintain. This is real cost and it is the price of the
isolation.

**11. Rollback strategy?** See §14. The Node reflex is not deleted; it stays
behind a source-of-truth flag, and cutover is one setting.

### 5.2 Fyers WebSocket ownership — **REJECTED (vendor constraint)**

Rejected for the reason in §4.0: the protocol is obfuscated and unschematised.
The socket stays on the vendor SDK in Node. It is moved into its **own minimal
process** so it no longer shares a lifetime with the brain — the isolation win
is achieved without reverse-engineering a vendor binary protocol.

### 5.3 REST client + rate limiter — **FIXED, and deliberately NOT in Go**

There is a genuine defect: the Bottleneck reservoir is **per process**
(`PER_MINUTE_CAP = 180`), while the daily budget counter lives in Redis and is
shared. Two processes therefore permit 360 calls/minute against one shared
100,000/day budget, and the per-minute ceiling is silently violated by exactly
the number of instances running.

That is a correctness bug, not a performance one, and **the fix is not Go** — it
is a shared counter. `claimMinuteSlot` now increments one Redis key per minute,
atomically, and every instance consults it. The counter **fails closed**: an
unreachable budget refuses the call, because the entire point of a shared
ceiling is that no instance may proceed on its own private belief about it.

Migrating this to Go would have fixed a correctness bug by accident and taught
the wrong lesson about when a language change is the answer.

### 5.4 Reconciliation, broker communication, execution infrastructure — **REJECTED**

All Postgres round-trip bound against an instance measuring 322.6 ms p50 on
`SELECT 1`. The language contributes nothing to that number. Moving them to Go
would relocate the wait, not remove it.

### 5.5 Concurrent event distribution — **REJECTED**

Socket.io fan-out to a handful of browser clients. Node is the correct tool and
the volume is trivial.

---

## 6. TypeScript responsibilities — retained deliberately

| Retained | Why |
|---|---|
| Senior reasoning pipeline | LLM-bound. Two model calls dominate at seconds each; the orchestration around them is nanoseconds. Go would make it slower to change and no faster to run. |
| Risk gate | Deterministic, but it must sit **with** the decision it gates. Splitting the decision from its gate across a process boundary adds a failure mode and buys nothing. |
| Execution engine, ledger, reconciliation | Postgres-bound. |
| Express API, Socket.io, operator surface | Application orchestration. |
| Event orchestration, queue, scheduler | Coordination, not computation. |

**The Senior Trader Brain must stay easy to evolve.** It is the part of this
system most likely to change weekly. It is not moved to Go for uniformity.

---

## 7. Python responsibilities — retained deliberately

| Retained | Why |
|---|---|
| PIT discipline, spine_v2 (75.8 M rows, 2,263 sessions) | working, correct, and the invariants are frozen |
| Polars / DuckDB feature engineering | already Rust and C++ underneath; our own C++ would be slower and less correct |
| Training, calibration, replay, backtesting | ecosystem is the reason to be here |
| Research invariants (trials 156, threshold 3.178, holdout looks 0) | rewriting the harness risks the numbers that justify the strategy |

**No measured reason to move any of it exists.** It is not rewritten.

---

## 8. Performance measurements

Every number below was measured in this repository, not estimated.

### 8.1 The fast plane, measured after this migration

| Measurement | Before | After | Note |
|---|---|---|---|
| Go protective path, serial | 21.05 ns/op, 0 allocs | **29.84 ns/op, 0 allocs** | +8.8 ns: the shard hash plus the detection hook. Still zero allocation. |
| Go, parallel across 200 symbols | **122.1 ns/op** | **22.49 ns/op** | **5.4× — the sharding win**, measured by collapsing to one shard and back |
| Go, parallel on ONE symbol | 123.6 ns/op | 115.4 ns/op | unchanged in substance, and correctly so — see below |
| Full detection, 100k-tick replay: Node | — | **186.3 ns/tick** | median of 5 |
| Full detection, 100k-tick replay: Go | — | **137.9 ns/tick** | **1.35×, not 4×** |
| Go detection allocations | — | **1.34 allocs/tick** | closures in the detect path; see 8.3 |

**Same-symbol contention is inherent, not a lock defect.** Two ticks on one
symbol must serialise or the sequence stops being monotonic and the running high
and low stop being correct. The original "123.6 ns/op parallel" figure was
measuring exactly that, and reading it as a lock-design problem was wrong.
Sharding fixes the case that actually occurs — 200 symbols interleaved on one
connection — and leaves the inherent case alone.

### 8.2 A claim walked back

An earlier draft of this document said the Go hot path "compiles to zero
allocations". That is true of the **protective** path and only that path
(29.84 ns/op, 0 B, 0 allocs, verified above). The **continuous detection** path
allocates about 1.34 times per tick, from closures in the detector.

More importantly, the speed advantage over Node on the *real* workload is
**1.35×, not the 4× the bare reflex suggested**. Detection does string
formatting and window maintenance, and both runtimes pay for that similarly.

Left unoptimised deliberately. At 1,000 ticks/second that is 1,340 allocations
per second, which Go's allocator does not notice, and removing the closures
would cost readability on the one path that must stay auditable. Measuring
before optimising is the rule; the measurement says do nothing.

**This weakens the performance case for Go, and the case was never performance.**
It is isolation. §5.1 already said so; these numbers say it harder.

### 8.3 The measurements that decided the architecture

| Measurement | Value |
|---|---|
| Node reflex, per tick | 83 ns p50 · 208 ns p99 · **1,125 ns p99.9 under GC** |
| Tick → reflex during bar rebuild, before fix | **86.844 ms p50 · 95.035 ms max** |
| Tick → reflex, after incremental bars | **0.047 ms p50 · 0.242 ms max** (1,847×) |
| Full derived rebuild, 200 symbols | 87.53 ms |
| `observeUniverse` one pass | 13.57 ms |
| Protective exit path, end to end | 2.236 ms p50 · 35.874 ms p99 (4 serial transactions) |
| Reflex share of that path | **0.0056 %** |
| Production Postgres `SELECT 1` | **322.6 ms p50** |
| IPC event round trip | 708 ns, 305 bytes |

**What these numbers say.** The tick path is not the bottleneck and no language
will make it one. The bottleneck is Postgres round trips, and the single
highest-value latency change available anywhere in this system is collapsing the
four-transaction protective exit into one — roughly 4×, in SQL, in TypeScript.
The Go migration is justified on **isolation**, and this document says so rather
than dressing it up as speed.

---

## 9. Decision rationale summary

| Decision | Justification | Kind |
|---|---|---|
| Fast plane → Go | event-loop coupling + shared process lifetime; structural enforcement | architectural |
| Fyers socket stays Node | vendor protocol obfuscated, no schema, untestable | vendor constraint |
| Feed edge isolated | brain `process.exit(1)` currently drops the feed | lifecycle |
| Per-symbol sharding in Go | 123.6 → target ~25 ns/op parallel | measured |
| C++ rejected everywhere today | 0.0083 % of one core at peak | measured |
| C++ future for order book | ~100× message rate with per-message mutation | projected, unbuilt |
| Reasoning stays TypeScript | LLM-bound; change velocity matters more | measured |
| Execution stays TypeScript | Postgres-bound at 322.6 ms p50 | measured |
| Research stays Python | Polars/DuckDB already native; invariants frozen | risk |
| Rate limiter not migrated | the defect is distributed state, not language | correctness |

---

## 10. Service boundaries

| Service | Language | Owns | Lifetime |
|---|---|---|---|
| `feed-edge` | Node | the vendor socket, raw frame → normalised tick | tied to token validity; restarts independently of the brain |
| `marketdatad` | Go | world state, reflex, detection, liveness | long-running, single owner per environment |
| `brain` | Node | reasoning, risk, execution, API, operator | restarts freely without dropping the feed |
| research | Python | PIT, features, training, replay | offline |

Communication is **Redis pub/sub and streams**, already a dependency, chosen over
gRPC because it is present, because the consumers are few, and because 708 ns is
far below anything on this path that matters.

---

## 11. Data contracts

`zentrade.marketdata.v1`, frozen, in `contracts/market-data/v1/`, with golden
fixtures that both runtimes execute.

- Money is **integer paise**, never a float, in either runtime, at any point.
- Timestamps are **epoch milliseconds UTC**.
- **Receipt time and exchange time are separate fields**, never conflated.
- **Unknown enum values are rejected**, never defaulted.
- **Sequence is monotonic per symbol**, assigned by the owner of the stream.
- The contract id is embedded in every message; an unrecognised id is rejected.

A change to any field requires v2, and v1 and v2 may coexist.

---

## 12. State ownership

Exactly one owner per piece of state. This is the rule the architecture exists
to make enforceable.

| State | Owner | Everyone else |
|---|---|---|
| Raw frame → normalised tick | `feed-edge` | consumes |
| Live world state (last/high/low/sequence) | `marketdatad` | reads a snapshot |
| Armed commitments | `marketdatad`, written by the brain at entry | |
| Feed liveness | `marketdatad` | reads |
| Bars 1m/5m/15m | brain (bar aggregator) | reads Redis |
| Theses, orders, fills, cash, positions | brain + Postgres | |
| Event lifecycle (PENDING/LEASED/HANDLED) | brain + Postgres | |
| Research artefacts | Python | never on the decision path |

**How duplicate Fyers connections are prevented.** Today they are not: nothing
claims ownership, so two instances open two sockets. `marketdatad` takes a Redis
lease (`SET NX PX`, renewed on a heartbeat) and `feed-edge` refuses to open the
socket without a valid lease. One owner per environment, enforced, and a crashed
owner's lease expires so a replacement can take over.

---

## 13. Failure model

| Failure | Behaviour |
|---|---|
| Brain crashes or redeploys | feed and reflex keep running; brain recovers PENDING events on restart |
| `marketdatad` crashes | lease expires; a replacement takes ownership and rebuilds state from ticks; armed commitments reloaded from Postgres by the brain |
| `feed-edge` crashes | lease expires; reconnect with backoff; `marketdatad` reports staleness within its sweep interval |
| Token expires 03:00 IST | `feed-edge` fails its auth stage loudly; brain reports DEGRADED; no exposure permitted |
| Feed silent but socket open | staleness sweep raises CRITICAL for armed symbols; **no trade is made on the absence of data** |
| Redis unavailable | fast plane holds state in memory and keeps protecting; publication resumes on reconnect |
| Postgres unavailable | detection continues; execution refuses; nothing is silently dropped |
| Two owners race | second fails to acquire the lease and exits non-zero |
| Contract mismatch | consumer rejects the message rather than interpreting it |

---

## 14. Rollback model

The Node reflex is **not deleted**. Both implementations run against the same
contract and the same fixtures.

1. **Shadow** — `marketdatad` consumes the same ticks and writes to a separate
   namespace. A comparator diffs its events against Node's. No consumer reads it.
2. **Cutover** — one setting names the source of truth. The brain reads the Go
   plane's events; the Node reflex keeps running and keeps being compared.
3. **Rollback** — flip the setting back. No data migration, no schema change, no
   redeploy of the brain required. The Node path was never removed.
4. **Removal** — only after a full session with zero divergence, and it remains
   in git history behind the contract that both implementations satisfy.

---

## 15. Migration order

| # | Step | Status |
|---|---|---|
| 1 | Freeze `zentrade.marketdata.v1` + golden fixtures | **done** |
| 2 | Go reflex library with proven parity | **done** |
| 3 | Per-symbol sharding (removes the 5.4× parallel penalty) | **done** |
| 4 | Continuous detection at parity with Node | **done** |
| 5 | Staleness with resumption semantics | **done** |
| 6 | Cross-language parity on generated fixtures | **done** — 20 fixtures |
| 7 | Failure + concurrency tests | **done**, `-race` |
| 8 | `marketdatad` service: lease, subscribe, publish, health | **done** |
| 9 | Shadow comparator against a replayed stream | **done** — 100,000 ticks, 848 events, zero divergence |
| 10 | Command contract: the brain arms the plane | **done** — `zentrade.marketdata.command.v1` |
| 11 | Bridge wired into the runtime, OFF by default | **done** — real-binary end-to-end test |
| 12 | Restart replay: a plane that starts late still protects | **done** |
| 13 | Rate limiter: shared per-minute ceiling | **done** — Redis counter, fails closed |
| 14 | Push delivery + plane heartbeat | **done** — pub/sub, not polling |
| 15 | Plane events drive protection in `live` | **done** — proven against the real binary end to end |
| 16 | Duplicate reasoning loop removed | **done** — `runLoopCycle` deleted, guard repointed |
| 17 | Live shadow for one full session | blocked on a live session |
| 18 | Controlled cutover to `live` by default | after 17 |
| 19 | Isolate `feed-edge` into its own process | after 18 |
| 20 | Collapse the 4-transaction protective exit | independent, highest latency value |

---

## 16. Interview explanation

**Why C++ here?** Nowhere, today, and that is the point. The tick path consumes
0.0083 % of one core at peak. I measured it before deciding. C++ is pre-scoped
for one future workload — Level-2 order-book processing, roughly 100× the
message rate with per-message book mutation — and the boundary is already drawn
behind the same contract, but no code is written until the data exists.

**Why Go here?** The deterministic fast plane. Not for speed: Node evaluates the
reflex in 83 ns and that is fast enough. For isolation. Tick receipt and
protection shared an event loop with LLM orchestration and HTTP serving, and a
measured 86.844 ms of head-of-line blocking proved that coupling was real. They
also shared a process lifetime, and the brain exits on any uncaught exception. A
minimal Node process would isolate it today and would drift back into a brain,
because adding an import is free. A language boundary makes that a rewrite.

**Why TypeScript retained?** The reasoning pipeline is LLM-bound — two model
calls at seconds each — so the orchestration around them is free at any speed.
It is also the part that changes weekly. Execution is Postgres-bound at 322.6 ms
p50. Neither gets faster in Go, and both get slower to change.

**Why Python retained?** 75.8 M rows through Polars and DuckDB, which are Rust
and C++ underneath. Writing my own would be slower and less correct. The research
invariants are frozen and rewriting the harness risks the numbers.

**How do the services communicate?** Redis pub/sub and streams, under a frozen
versioned contract with golden fixtures both runtimes execute. Integer paise,
epoch-ms UTC, receipt and exchange time separate, unknown enums rejected, per
symbol monotonic sequence. 708 ns round trip, which is nothing against a 2.2 ms
protective path.

**How does market-data ownership work?** One owner per environment, holding a
Redis lease renewed on a heartbeat. The feed edge will not open a socket without
a valid lease, so two instances cannot both connect. A crashed owner's lease
expires and a replacement takes over.

**How does state ownership work?** One owner per piece of state, listed in §12.
World state belongs to the fast plane. Money and orders belong to Postgres via
one ledger. Research artefacts never touch the decision path.

**How is rate limiting handled?** Badly, today, and I know exactly how: the
Bottleneck reservoir is per process while the budget counter is in Redis, so N
instances permit N × 180 calls per minute. The fix is a Redis token bucket, not
a language migration — and I did not migrate it to Go, because that would have
fixed a correctness bug by accident and taught me the wrong lesson.

**How does the fast path differ from the reasoning path?** The fast path acts on
pre-commitments. A thesis named its stop, its target and its invalidation, and
the risk gate already approved the position those levels belong to — so when a
tick crosses one, there is no judgement left to make. The reasoning path decides
what the crossing *meant*, afterwards.

**Why isn't the LLM on the critical safety path?** Because it was, and it cost
about 35 seconds from a stop being lost to an order existing: a 15-second poll,
a queue, then two sequential model calls. It is now 0.047 ms and no model is
consulted. Structurally, the fast plane has no model client linked into it.

**How do failures and restarts work?** §13. The short version: the brain can die
without the feed dying, the feed can die without positions going unprotected
silently, and nothing trades on the absence of data.

**How does rollback work?** One setting names the source of truth. The Node
implementation is never deleted and keeps running in shadow. No schema change,
no data migration.

**What benchmarks justified each migration?** §8, every one measured here. And
the most important thing those benchmarks did was **stop** things: they are why
C++ is rejected everywhere, why the reasoning path stays in TypeScript, why the
rate limiter was not migrated, and why the Go case is argued on isolation rather
than on speed. One of them made me walk back a claim in my own design document
— Go turned out to be 1.35× Node on the real workload, not 4× — and the
architecture is better for the correction, because it now rests on the reason
that actually holds.
