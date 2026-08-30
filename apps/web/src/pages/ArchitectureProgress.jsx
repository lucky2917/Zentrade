import { useEffect } from "react";

// The public ZenTrade Brain architecture and progress document.
//
// Rendered outside the trading application shell: no navbar, no ticker, no
// market socket and no authentication, because this is a reference document
// for technical reviewers rather than a screen in the product.
//
// Content is synchronised with the authoritative internal architecture and
// progress report. No claim on this page may be added or altered here without
// changing that document first.

const PAGE_TITLE = "ZenTrade Brain — Architecture & Progress";
const PAGE_DESCRIPTION =
    "Architecture and progress report for ZenTrade Brain, a senior-trader-style " +
    "autonomous trading system for the Indian equity market. Paper mode only.";

const CONTENTS = [
    ["p1", "Objective"], ["p2", "Target architecture"], ["p3", "Why the split"],
    ["p4", "Reasoning model"], ["p5", "Data flow"], ["p6", "Safety architecture"],
    ["p7", "Implemented architecture"], ["p8", "End-to-end flow"], ["p9", "Progress"],
    ["p10", "What has been proven"], ["p11", "Remaining gaps"], ["p12", "Roadmap"],
    ["p13", "Formal summary"],
];

const NOT_THIS = [
    ["A stock screener", "A screener ranks and stops. This must decide, act, and live with the consequence."],
    ["A periodic signal generator", "A signal on a timer is blind between ticks. Markets are not."],
    ["A language-model wrapper", "The model contributes interpretation only, never arithmetic, permission, sizing or execution rights."],
    ["A bot polling a model every few seconds", "Expensive, slow and wrong: most of what a trader does requires no thought, because it was decided in advance."],
];

const CYCLE = [
    "observe", "perceive", "detect change", "understand", "form thesis",
    "challenge thesis", "evaluate opportunity", "decide", "revalidate",
    "risk check", "act", "monitor", "detect change", "think again",
];
const CYCLE_KEY = new Set(["form thesis", "challenge thesis", "revalidate", "risk check"]);

const STATE_MODEL = [
    ["Market", "Breadth, synchronisation, median move, shock condition, session phase"],
    ["Symbol", "Last price, running high and low, VWAP distance, multi-timeframe direction, volatility"],
    ["Portfolio", "Cash, gross and net exposure, position count, session turnover, realised loss"],
    ["Positions", "Quantity, entry, current price, unrealised P&L, distance to stop and target, holding time, data freshness"],
    ["News", "Point-in-time visible announcements, classified and deduplicated"],
    ["Regime", "Derived from evidence held; UNKNOWN when unsupported"],
    ["Risk", "Limit headroom, drawdown state, unresolved execution ambiguity"],
    ["Active theses", "The immutable record of why each position exists and what would prove it wrong"],
    ["Recent decisions", "Previous belief, what changed, and when it was last reassessed"],
];

const TIERS = [
    {
        id: "TIER 0", name: "Reflex", cadence: "every tick · in memory · <1 ms", llm: "never",
        steps: [
            ["normalise tick", ""], ["symbol state: last, running high/low, sequence", ""],
            ["feed liveness", ""], ["edge-test pre-committed levels", "hot"],
            ["protective action", "hot"], ["emit event", ""],
        ],
    },
    {
        id: "TIER 1", name: "Perception", cadence: "bar boundary · clock-driven", llm: "never",
        steps: [
            ["closed 1m bars", ""], ["5m / 15m derived", ""], ["VWAP", ""], ["MTF", ""],
            ["volatility", ""], ["breadth", ""], ["market state", "key"], ["anomaly detection", ""],
        ],
    },
    {
        id: "PARALLEL", name: "News intelligence", cadence: "60 s poll", llm: "never",
        steps: [
            ["exchange announcements", ""], ["normalise", ""], ["point-in-time validation", "key"],
            ["deduplicate", ""], ["classify", ""], ["materiality", ""], ["event", ""],
        ],
    },
    {
        id: "TIER 2", name: "Attention", cadence: "per event · durable", llm: "never",
        steps: [
            ["market + news events", ""], ["priority", ""], ["severity (monotonic)", ""],
            ["coalescing", ""], ["pending · leased · handled", "key"], ["single-flight per symbol", ""],
        ],
    },
    {
        id: "TIER 3", name: "Senior trader brain", cadence: "material event only", llm: "exactly 2",
        steps: [
            ["trader state", "key"], ["market", ""], ["symbol", ""], ["portfolio", ""],
            ["position", ""], ["original thesis", ""], ["evidence", ""],
            ["thesis formation", "key"], ["adversarial challenge", "key"],
            ["alternative hypotheses", ""], ["what changed", ""],
            ["what would invalidate it", ""], ["cost / R:R / opportunity cost", ""], ["decision", ""],
        ],
    },
    {
        id: "TIER 4", name: "Revalidation", cadence: "immediately before execution", llm: "never",
        steps: [
            ["re-read price", "hot"], ["position", "hot"], ["portfolio", "hot"],
            ["market state", "hot"], ["decision age", "hot"], ["observation version", "hot"],
            ["hard risk gate", "key"], ["execution", "key"],
        ],
    },
    {
        id: "TIER 5", name: "Supervision", cadence: "5–60 s", llm: "never",
        steps: [
            ["execution state", ""], ["fill", ""], ["reconciliation", ""], ["position state", ""],
            ["monitoring", ""], ["recovery", ""], ["audit", ""],
        ],
    },
];

const CADENCES = [
    ["Every tick", "Update state; detect pre-committed boundaries; act immediately", "Never"],
    ["Every bar boundary", "Bars, VWAP, MTF, volatility, breadth, anomalies", "Never"],
    ["Every material event", "Wake the reasoning system", "Exactly 2"],
    ["Before execution", "Re-read the world; reject decisions formed against a world that moved", "Never"],
    ["Continuously (5–60 s)", "Reconcile, supervise, expire, recover, report", "Never"],
];

const QUESTIONS = [
    ["1", "What is happening?", "Thesis formation, over trader state", null],
    ["2", "What facts do I actually know?", "Evidence tier FACT", null],
    ["3", "What is merely an observation?", "Tier OBSERVATION", null],
    ["4", "What am I inferring?", "Tier INFERENCE — the ceiling for anything the model says", null],
    ["5", "What is my current thesis?", "Thesis formation output", null],
    ["6", "Why could this thesis be wrong?", "Adversarial challenge, a separate call", null],
    ["7", "What alternative explanation exists?", "Challenge: alternative hypotheses", null],
    ["8", "What evidence contradicts me?", "Weighed deterministically in synthesis", null],
    ["9", "What changed since the last assessment?", "Previous belief carried in trader state", null],
    ["10", "Is the setup attractive after costs?", "Deterministic: 73.55 bps round-trip hurdle", null],
    ["11", "What is the downside?", "Risk-reward from the thesis's own stop", null],
    ["12", "What is the opportunity cost?", "Deterministic: cash share, concentration", null],
    ["13", "Is this better than other opportunities?", "See remaining gaps", "no"],
    ["14", "Has the market regime changed?", "Market state and regime derivation", null],
    ["15", "Am I exposed to this risk elsewhere?", "Exposure limits only, no correlation", "part"],
    ["16", "Has the decision become stale?", "Tier 4: drift and decision age", null],
    ["17", "What would make me change my mind?", "Challenge: what would change the decision", null],
];

const EVIDENCE_TIERS = [
    ["FACT", "Measured and quoted", "“last price is 1030”"],
    ["OBSERVATION", "Measured and summarised", "“breadth is broad decline, 78% of 200 symbols”"],
    ["INFERENCE", "Interpretation — the model's ceiling", "“buyers are defending this level”"],
    ["HYPOTHESIS", "Candidate explanation", "“this could be short covering”"],
    ["PREDICTION", "Claim about the future", "“this should continue”"],
];

const SITUATIONS = [
    ["New candidate", "Is there enough evidence to establish a position?",
     "Must clear the cost hurdle; must name invalidation conditions or it is forced to hold; blocked into a market-wide decline"],
    ["Held position", "Is the original thesis still valid?",
     "Prompt carries the immutable entry thesis and previous belief; explicitly told not to form a fresh opinion"],
    ["Profitable position", "Is this still working, or am I giving profit back?",
     "Time decay evaluated: a thesis held most of its horizon without resolving has decayed regardless of price"],
    ["Losing position", "Was I wrong, or is this noise?",
     "Contradicting evidence weighs harder; a broken thesis escalates hold to exit"],
    ["Stop / invalidation", "Nothing is asked before acting",
     "Tier 0 protects first, then hands the crossing to reasoning to decide what it meant"],
    ["Market-wide shock", "Does this symbol's story survive the market's story?",
     "Deterministic block on new long exposure into a synchronised decline; the model cannot argue past it"],
];

const DATA_FLOW = [
    ["1", "Tick → normalised tick", "Field names resolved, symbol mapped, receipt timestamp, source stamped",
     "The vendor's shape must not leak into the domain, and a polled quote must never be mistaken for a streamed tick"],
    ["2", "Tick → reflex state", "Last price, running high and low since last evaluation, sequence, liveness",
     "The only place that sees every price. A spike that retraces inside one interval exists only here"],
    ["3", "Reflex → protective action", "Protective exit submitted; lane disarms; event raised",
     "The decision was made at entry. Re-deriving it through a model inverts the purpose of a stop"],
    ["4", "Ticks → closed 1m bar", "Open-high-low-close accumulates; volume is the delta of cumulative session volume",
     "Summing the raw field would multiply a day's volume by the tick count; a bar published on the next tick makes cadence a function of liquidity"],
    ["5", "1m → 5m / 15m", "Rolled up by bucket from the stored series",
     "Derivation from one source keeps granularities consistent by construction, not coincidence"],
    ["6", "Bars → intelligence", "VWAP accumulates forward only; multi-timeframe direction; volatility ratio; anomaly baselines sliced strictly before the observation; breadth",
     "Bar-scale quantities. A baseline including the observation would be look-ahead"],
    ["7", "Events → attention", "Persisted with lifecycle; severity monotonic; coalesced; prioritised",
     "Events arrive faster than reasoning consumes them, and a dropped condition must return"],
    ["8", "Event → trader state", "Assembled into one typed structure with tiered evidence, before any model call",
     "The model should reason over settled facts, not decide what is measured versus guessed"],
    ["9", "Trader state → decision", "Formation proposes; challenge attacks; synthesis prices it and can only downgrade",
     "A view nobody attacked is not a view that has been tested"],
    ["10", "Decision → revalidation", "Drift and age evaluated; exit re-priced and sized to what is held",
     "The model thought for seconds. The market did not wait"],
    ["11", "Intent → risk → fill", "Fail-closed authorisation; reservation, transitions, fill identity, cash and position in one transaction",
     "Authorisation and execution are separate concerns, and cash must move exactly once"],
    ["12", "Fill → position → next tick", "Position state; reflex lane armed with the thesis's levels",
     "The loop closes. The next tick is evaluated against commitments that now exist"],
];

const AI_CANNOT = [
    ["Bypass risk", "The execution port is reached only through the gate; the gate reads no field the model sets"],
    ["Choose an illegal action", "Action vocabulary restricted by position state before the proposal is used"],
    ["Override stale data", "Staleness computed from tick age and source; the gate rejects new exposure fail-closed"],
    ["Invent quantity", "A buy with no usable integer quantity degrades to hold"],
    ["Execute directly", "One execution port; reasoning returns a decision, never an order"],
    ["Override portfolio constraints", "Exposure, concentration, symbol count, turnover and loss limits are arithmetic"],
    ["Promote its own evidence", "Model statements clamped to INFERENCE at the boundary"],
    ["Supply a probability", "Discarded; expected value stays insufficient-basis without a calibrated source"],
];

const MECHANISMS = [
    ["Immutable thesis", "Database trigger", "Only close fields may change. History cannot be rewritten after the fact"],
    ["Evidence hierarchy", "Evidence module", "Tier by origin; the model cannot exceed INFERENCE"],
    ["Deterministic calculations", "Synthesis module", "Risk-reward, cost hurdle, expected value, opportunity cost, thesis age — no model input"],
    ["Hard risk gate", "Risk gate module", "Fail-closed. Anything unevaluable is a rejection; no default-allow path"],
    ["Execution state machine", "Execution engine", "Nine states; illegal transitions rejected; ambiguous deliberately non-terminal"],
    ["Single execution authority", "Runtime execution port", "Everything approved passes through one port"],
    ["Idempotency", "Unique order identity; fill identity", "A repeat produces no second order and no double-counted fill, including under contention"],
    ["Reconciliation", "Reconciliation module", "Unknown external state produces ambiguous rather than a guess"],
    ["Stale data protection", "Source-aware freshness", "A polled quote cannot impersonate a live tick"],
    ["Fresh-world revalidation", "Revalidation module", "A decision cannot execute against a materially changed world"],
    ["Restart recovery", "Orchestrator recovery", "Positions, orders, theses, pending events and armed levels all return"],
    ["Durable events", "Event lifecycle", "Pending, leased, handled; unhandled work survives a crash"],
    ["Fail-closed behaviour", "Throughout", "No model, no answer, malformed answer, timeout — all yield a safe hold"],
    ["Audit trail", "Five append-only tables", "Every decision, rejection and fallback recorded"],
    ["Correlation identifiers", "Threaded event to order", "One identifier reconstructs an entire trade"],
];

const S = { OK: "ok", BUILT: "built", PART: "part", IDLE: "idle", NO: "no" };
const STATUS_LABEL = {
    ok: "Built + tested", built: "Built", part: "Partial",
    idle: "Available, unused", no: "Not built",
};

const IMPLEMENTED = [
    ["Research spine", "Point-in-time bar storage, frozen semantics", S.OK, "75.8M one-minute rows, 100 symbols, 2,263 sessions, 2017–2026"],
    ["Point-in-time correctness", "Storage, labelling and news boundaries", S.OK, "Leakage suite; news boundary inclusive by design"],
    ["Deterministic replay", "Replay determinism suite", S.OK, "557 research tests"],
    ["Market data ingestion", "Auth, websocket, rate limiting", S.BUILT, "Reconnect with backoff; never run through a live session", S.NO],
    ["Tick handling", "Normalisation and source stamping", S.BUILT, "Field names audited against one captured sample only"],
    ["Reflex layer (Tier 0)", "Reflex lane", S.OK, "17 unit and 7 integration tests; 69 ns per tick measured"],
    ["Bar aggregation", "Bar aggregator", S.OK, "33 tests; clock-driven close; volume as delta"],
    ["1m / 5m / 15m", "Roll-up from stored one-minute series", S.OK, "Consistent by construction"],
    ["VWAP", "Session VWAP", S.OK, "Session-scoped, forward-accumulating, point-in-time safe"],
    ["Multi-timeframe", "MTF context", S.PART, "Tested, but the 5m and 15m windows both span the session once the day matures"],
    ["Market state", "Breadth and synchronisation", S.OK, "10 tests; injected into every trader state"],
    ["Anomaly detection", "Price, volume, volatility, VWAP deviation", S.OK, "Baselines strictly before the observation"],
    ["News", "Announcement ingestion and materiality", S.PART, "Point-in-time correct, exchange time handled; store is in-memory and lost on restart"],
    ["Attention / event queue", "Durable event lifecycle", S.OK, "11 lifecycle tests; monotonic severity"],
    ["Trader state", "State assembly", S.OK, "Assembled before any model call"],
    ["Evidence hierarchy", "Evidence tiering", S.OK, "Model clamped to INFERENCE"],
    ["Thesis formation", "Formation prompt and validation", S.OK, "An unfalsifiable thesis is forced to hold"],
    ["Counter-thesis", "Adversarial challenge", S.OK, "Separate call; an unparseable challenge is treated as adverse"],
    ["Deterministic synthesis", "Synthesis and cost hurdle", S.OK, "Downgrade-only; 73.55 bps hurdle"],
    ["Position reassessment", "Reassessment path", S.OK, "Asks about the original thesis, not a fresh opinion"],
    ["Thesis memory", "Immutable thesis records", S.OK, "Immutable by trigger; reassessments linked to their event"],
    ["Position monitoring", "Monitor and position state", S.OK, "Demoted to a safety net; the reflex lane owns detection"],
    ["Execution state machine", "Execution engine", S.OK, "Nine states; reservations; overfill and negative-position guards"],
    ["Ledger", "Single money model", S.OK, "10 conservation tests; shared by the engine and end-of-day close"],
    ["Paper venue", "Simulated venue", S.OK, "10 scripted behaviours including silent and duplicate acknowledgement"],
    ["Hard risk gate", "Risk gate", S.OK, "40 adversarial tests"],
    ["Revalidation", "Fresh-world revalidation", S.OK, "15 tests; revives the gate's own drift and age guards"],
    ["Reconciliation", "Order reconciliation", S.OK, "Matched, mismatch, ambiguous"],
    ["Restart recovery", "Recovery and re-arming", S.OK, "Positions, orders, theses, pending events, armed levels"],
    ["Portfolio state", "Account-scoped portfolio", S.OK, "Exposure and drawdown"],
    ["Opportunity ranking", "Candidate screen", S.PART, "Sorted by absolute move, capped at five. No comparison between candidates"],
    ["Sector / correlation", "Sector present on all 200 symbols", S.IDLE, "No module in the brain reads it. No correlation estimate exists anywhere"],
    ["Scheduler", "Named-job scheduler", S.OK, "Overlap prevention, error isolation, drain on stop"],
    ["Orchestrator", "Autonomous orchestrator", S.OK, "Nine registered jobs; lifecycle; recovery"],
    ["Boot lifecycle", "Ordered bootstrap", S.OK, "Ten ordered stages; critical versus degradable"],
    ["Operator observability", "Authenticated operator report and halt control", S.BUILT, "Read-only state report plus an emergency halt"],
    ["Testing", "59 suites", S.OK, "871 application tests and 557 research tests"],
    ["Live broker connectivity", "—", S.NO, "No order-placement code exists anywhere in the system. The boundary is absence, not a configuration flag"],
];

const SIMULATED = [
    ["Model transport", "Every reasoning test scripts it. Real latency, rate limits and output variance under session load are unmeasured"],
    ["Venue behaviour", "Fills at the intent price with no slippage or spread; the default is immediate fill"],
    ["Tick stream", "All ticks are synthetic and perfectly ordered"],
    ["Market conditions", "Breadth, shocks and anomalies are constructed, never observed"],
];

const PROGRESS = [
    ["Safety & determinism", 85, 8],
    ["Observation & reflex", 80, 8],
    ["Market perception", 60, 7],
    ["Senior reasoning", 75, 10],
    ["Position intelligence", 70, 7],
    ["Portfolio intelligence", 25, 8],
    ["Execution reliability", 70, 9],
    ["Recovery & auditability", 80, 8],
    ["Live operation", 0, 20],
    ["Demonstrated edge", 10, 15],
];

const MOVERS = [
    ["One clean live observation session", "+8 to +12"],
    ["Five unattended paper sessions", "+5"],
    ["Portfolio ranking and sector awareness", "+5"],
    ["A measured edge surviving costs", "+10 or more — nothing substitutes for it"],
];

const PROVEN = [
    ["Reflex protection", "A tick crossing the stop produces a filled protective order, and the model was never called"],
    ["Reflex is edge-triggered", "Fifty further ticks below the stop produce zero additional orders"],
    ["Intra-interval extremes", "A spike and retrace between evaluations is retained in the running high and low"],
    ["Cash conservation", "A flat round trip nets exactly two brokerage charges; profitable and losing round trips return principal plus or minus profit to the paise, through the end-of-day close as well"],
    ["Reservation integrity", "Reservation is never smaller than the debit across sizes and prices; cash cannot be driven negative by filling to the limit"],
    ["Stale decision protection", "A decision at one price is refused at another beyond 30 bps; a 45-second-old decision expires; both of the gate's own guards now demonstrably fire"],
    ["Exit is never blocked", "Re-priced however far the market has run, and sized down to what is still held"],
    ["Event durability", "A critical condition dropped by a full queue returns to pending; it is marked handled only after reasoning completed"],
    ["Restart recovery", "Pending events re-queued; every open position re-armed before the next tick"],
    ["Severity monotonicity", "A later warning cannot downgrade a recorded critical"],
    ["Concurrency", "Two entry paths racing on one symbol produce one analysis, one order, one thesis"],
    ["Idempotency", "Identical intent identity returns the same order; racing submissions are idempotent rather than erroring"],
    ["Thesis immutability", "Enforced by database trigger; the entry rationale is unchanged after exit in every lifecycle test"],
    ["Risk gate", "40 adversarial tests; fail-closed on missing intent, context, portfolio, price or quantity"],
    ["Market-wide protection", "A long is refused into a synchronised decline despite a clean chart; exits are never blocked by breadth"],
    ["Failure injection", "No model, throws, times out, malformed, challenge unavailable — every path yields a safe hold"],
    ["Research invariants", "Trials 156, threshold 3.178, active schema unchanged, holdout looks 0"],
];

const GAPS = [
    {
        n: "Gap 1", title: "Live market session validation", blocking: true,
        why: "Every guarantee above is proven against synthetic input. Tick shape, arrival rate, reconnect behaviour and real latency are all assumptions.",
        state: "Never attempted.",
        dep: "None — this is first.",
        done: "One full session observed with entries disabled, producing measured tick rates, reflex latency, anomaly firing rates and model latency.",
    },
    {
        n: "Gap 2", title: "Single authoritative time source",
        why: "Data access reads the wall clock while the orchestrator holds an injected clock, so a decision's timestamp is not rigorously the instant its inputs were bound to.",
        state: "Clock injected into the orchestrator and scheduler only.",
        dep: "None.",
        done: "One time source throughout, and a replay test proving identical inputs produce identical decisions.",
    },
    {
        n: "Gap 3", title: "Reflex and latency validation",
        why: "69 nanoseconds is the in-memory evaluation only. The protective order adds four database round trips, unmeasured under load.",
        state: "In-memory path benchmarked; end-to-end path untimed.",
        dep: "Gap 1.",
        done: "99th-percentile latency measured from crossing tick to order record, against a target under 250 ms.",
    },
    {
        n: "Gap 4", title: "Bounded parallel reasoning",
        why: "Three events per five seconds, processed sequentially. A volatile open backs up; events are no longer lost, but they are delayed.",
        state: "Single-flight per symbol exists; concurrency across symbols does not.",
        dep: "Gap 2.",
        done: "A burst of 40 simultaneous events handled within a minute with no critical position event expiring.",
    },
    {
        n: "Gap 5", title: "Execution engine as sole writer", blocking: true,
        why: "Against a real broker, more than one writer is precisely how positions and reality diverge.",
        state: "The manual path and the end-of-day close write completed orders and move cash directly. All writers now share the ledger arithmetic, so cash is consistent, but the state machine is bypassable.",
        dep: "None, but must precede any broker adapter.",
        done: "Every order record originates from the execution engine.",
    },
    {
        n: "Gap 6", title: "Portfolio-level opportunity ranking",
        why: "Twenty simultaneous triggers produce the top five by move size, evaluated one at a time. The system cannot answer whether one opportunity is better than another.",
        state: "Opportunity cost computed per candidate; no ranking between them.",
        dep: "Gap 4.",
        done: "Candidates ordered by measured edge, and a lower-ranked one demonstrably refused when capital is better used elsewhere.",
    },
    {
        n: "Gap 7", title: "Sector and correlation awareness",
        why: "The system can hold five positions that are one bet.",
        state: "Sector is present on all 200 symbols and read by no module in the brain. No correlation estimate exists anywhere.",
        dep: "Gap 6.",
        done: "Concentration evaluated by sector and realised correlation, not only symbol count.",
    },
];

const GAPS_MINOR = [
    ["Durable news", "A restart loses the day's announcements. Point-in-time correctness holds; durability does not."],
    ["Test isolation", "Parallel suites share one database; roughly one run in four fails on a constraint violation that passes in isolation. A flaky suite is where a real regression hides."],
    ["Order realism", "The default venue fills instantly at the intent price, so every timing assumption is untested and simulated profit and loss flatters reality."],
];

const GAPS_FINAL = [
    ["Unattended sessions", "Autonomy is unattended operation, not a passing test. Currently zero. Depends on gaps 1 to 5, 8, 9 and 10."],
    ["Demonstrated edge", "Everything above is machinery. Research is explicit that net economics remain negative while the 73.55 bps hurdle dominates. Complete when a pre-registered hypothesis survives the deflated threshold on data never used for selection."],
];

const EXTRA_FLAWS = [
    ["Sector data present on 200 symbols, read by nothing in the brain", "Open — gap 7"],
    ["The 5m and 15m windows both span the session, making alignment weaker than it reads", "Open — no correction attempted; it would change screening behaviour"],
    ["Tick timestamps are receipt time, not exchange time, so bar boundaries drift with network latency", "Open — acceptable, but undocumented until now"],
    ["More than one writer still touches orders, cash and positions", "Open — gap 5"],
    ["Integration suites are not isolated", "Open — gap 9"],
];

const ROADMAP = [
    ["Current architecture", "Tier 0 to 5 implemented, 871 tests, paper only", "now"],
    ["Live observation", "One session, entries disabled, everything measured", ""],
    ["Time consistency", "Single clock throughout; exact replay", ""],
    ["Reflex and latency validation", "99th-percentile crossing tick to order record under 250 ms", ""],
    ["Parallel reasoning", "Bounded concurrency; relevance-based expiry", ""],
    ["Single execution authority", "Every order record originates in the engine", ""],
    ["Portfolio intelligence", "Cross-candidate ranking, then sector and correlation", ""],
    ["Durable news", "Announcements survive restart with their time boundary intact", ""],
    ["Realistic paper execution", "Acknowledgement delay, partial fills, slippage by default", ""],
    ["Multi-session unattended soak", "Five consecutive sessions, zero intervention", ""],
    ["Broker adapter", "Replaces the venue object only", "live"],
    ["Broker reconciliation", "Real external state, real ambiguity resolution", "live"],
    ["Controlled live validation", "Smallest viable size, hard caps, operator present", "live"],
    ["Autonomous readiness", "", "live"],
];

const SUMMARY = [
    ["What is ZenTrade Brain?",
     "A deterministic, restart-safe, risk-gated autonomous paper trading system for the Indian equity market, built around a senior-trader model of decision-making. It separates reflex from judgement: pre-committed actions execute on the tick that triggers them, and judgements wait for a material event."],
    ["How does it think?",
     "It assembles a trader state — market, symbol, portfolio, position, original thesis, current evidence, news and risk — before any model is called. It forms a thesis, then attacks it with a second, adversarial call whose only job is to break it. A deterministic synthesis prices the surviving view against a 73.55 bps round-trip hurdle and can only ever downgrade it. Exactly two model calls per material event, never per tick."],
    ["How does it react?",
     "Every tick updates an in-memory symbol state and tests the levels the thesis committed to at entry. A stop or invalidation crossing submits a protective exit immediately — measured at 69 nanoseconds of evaluation — and only then raises an event for reassessment. No language model sits between a tick and a pre-committed protective action."],
    ["How does it protect itself?",
     "A fail-closed risk gate that reads no field the model sets; a fresh-world revalidation step that refuses decisions formed against a world that has moved; source-aware staleness so a polled quote cannot impersonate a live tick; single flight per symbol; intent-derived idempotency; a nine-state execution machine where an unknowable outcome becomes ambiguous rather than a guess; and one ledger, proven to conserve cash to the paise."],
    ["How does it remember?",
     "An immutable trade thesis, enforced by database trigger, recording why each position exists and what would prove it wrong. Every reassessment is appended against that thesis and linked to the event that caused it. History cannot be rewritten after the fact."],
    ["How does it reassess?",
     "Not by forming a fresh opinion. The reassessment carries the immutable entry thesis and the previous belief, and asks whether what was believed at entry is still true. The outcome is recorded whether it acts or not, because why it held is as important as why it sold."],
    ["How does it execute?",
     "Through one port. A decision becomes an intent, the intent is revalidated against the current world, the risk gate authorises it, and the engine moves cash and position in a single transaction with fill identity and reservation tracking. Paper only. No order-placement code exists in the system; the safety boundary is absence, not a configuration flag."],
    ["How does it recover?",
     "On restart it reconstructs positions, orders, open theses, pending events and the protective levels armed for every held position, and resumes without duplicate actions."],
    ["What has been built?",
     "Tiers 0 through 5 in full: reflex, perception, attention, judgement, revalidation and supervision. 871 application tests and 557 research tests pass. Research invariants intact — 156 trials, threshold 3.178, holdout looks 0."],
    ["What remains?",
     "Live validation of every assumption about the real feed; a single authoritative time source; bounded parallel reasoning; the execution engine as sole writer; portfolio-level opportunity ranking; sector and correlation awareness; durable news; realistic order modelling; five unattended sessions; and, separately from all engineering, a demonstrated edge."],
    ["How far are we?",
     "45% toward a senior-level autonomous trading platform, measured by behavioural capability. Six of ten capability categories score 60% or above. The total is held down by the two that matter most and score lowest: live operation at 0%, and demonstrated trading edge at 10%."],
];

const barClass = (v) => (v >= 60 ? "hi" : v >= 25 ? "mid" : "lo");

const Meta = () => (
    <div className="ap-meta">
        <dl>
            <dt>Date</dt><dd><b>30 August 2026</b></dd>
            <dt>System status</dt><dd><b>Paper mode only. Not live.</b> No order-placement code exists in the system.</dd>
            <dt>Source of truth</dt><dd>The ZenTrade Brain implementation, at its 2026-08-30 state</dd>
            <dt>Assessment source</dt><dd>Internal adversarial architecture review and correction</dd>
            <dt>Verification</dt><dd><b>871</b> application tests · <b>557</b> research tests · research holdout looks <b>0</b></dd>
            <dt>Overall progress</dt><dd><b>45%</b> toward a senior-level autonomous trading platform</dd>
        </dl>
    </div>
);

const Table = ({ head, rows, className = "" }) => (
    <div className={`ap-tablewrap ${className}`}>
        <table>
            <thead><tr>{head.map((h) => <th key={h}>{h}</th>)}</tr></thead>
            <tbody>{rows}</tbody>
        </table>
    </div>
);

const Part = ({ id, n, title, children }) => (
    <section className="ap-part" id={id}>
        <div className="ap-part-head">
            <div className="ap-part-n">PART {n}</div>
            <h2>{title}</h2>
        </div>
        {children}
    </section>
);

const ArchitectureProgress = () => {
    useEffect(() => {
        const previousTitle = document.title;
        document.title = PAGE_TITLE;

        let created = false;
        let description = document.querySelector('meta[name="description"]');
        const previousDescription = description ? description.getAttribute("content") : null;
        if (!description) {
            description = document.createElement("meta");
            description.setAttribute("name", "description");
            document.head.appendChild(description);
            created = true;
        }
        description.setAttribute("content", PAGE_DESCRIPTION);

        document.documentElement.classList.add("ap-root");
        return () => {
            document.title = previousTitle;
            if (created) description.remove();
            else if (previousDescription !== null) description.setAttribute("content", previousDescription);
            document.documentElement.classList.remove("ap-root");
        };
    }, []);

    return (
        <div className="ap-page">
            <header className="ap-masthead">
                <div className="ap-brand">
                    <span className="ap-brand-mark">ZenTrade</span>
                    <span className="ap-brand-div" aria-hidden="true">/</span>
                    <span className="ap-brand-doc">Brain</span>
                    <span className="ap-brand-tag">Official architecture document</span>
                </div>
                <a className="ap-brand-home" href="/">Back to the platform</a>
            </header>

            <main className="ap-wrap">
                <div className="ap-cover">
                    <div className="ap-eyebrow">Formal technical document</div>
                    <h1>ZenTrade Brain — Architecture &amp; Progress</h1>
                    <p className="ap-tagline">
                        Architecture and progress report for a senior-trader-style autonomous
                        trading system for the Indian equity market.
                    </p>
                    <Meta />

                    <nav className="ap-index" aria-label="Contents">
                        <h2>Contents</h2>
                        <ol>
                            {CONTENTS.map(([id, label]) => (
                                <li key={id}><a href={`#${id}`}>{label}</a></li>
                            ))}
                        </ol>
                    </nav>

                    <p className="ap-note">
                        This document was written from inspection of the implementation. Where a
                        claim is made, the component and the test that proves it are named. Where
                        something is unproven, it is marked unproven rather than described in
                        language that implies otherwise.
                    </p>
                </div>

                {/* PART 1 */}
                <Part id="p1" n="1" title="Objective">
                    <p className="ap-body">
                        A senior-trader-like autonomous system operating continuously in the Indian
                        equity market: one that watches without pause, notices when something
                        material changes, forms a view, attacks its own view before acting on it,
                        acts only when the evidence justifies the cost, protects open positions the
                        instant a pre-committed level is breached, and keeps asking whether what it
                        believed at entry is still true.
                    </p>

                    <h3 className="ap-sub">What it is explicitly not</h3>
                    <Table head={["Not this", "Why the distinction matters"]} rows={NOT_THIS.map(([a, b]) => (
                        <tr key={a}><td>{a}</td><td>{b}</td></tr>
                    ))} />

                    <h3 className="ap-sub">The intended operating cycle</h3>
                    <div className="ap-tier">
                        <div className="ap-tier-side">
                            <div className="ap-tier-id">THE LOOP</div>
                            <div className="ap-tier-name">Not a pipeline</div>
                            <div className="ap-tier-cad">the last step returns to the first</div>
                        </div>
                        <div className="ap-flow">
                            {CYCLE.map((step, i) => (
                                <span key={step + i} className="ap-flow-item">
                                    <span className={`ap-step${CYCLE_KEY.has(step) ? " key" : ""}`}>{step}</span>
                                    <span className="ap-arrow" aria-hidden="true">
                                        {i === CYCLE.length - 1 ? "↺" : "→"}
                                    </span>
                                </span>
                            ))}
                        </div>
                    </div>

                    <h3 className="ap-sub">State the system must continuously maintain</h3>
                    <p className="ap-body">
                        A senior trader does not reconstruct the world each time they are asked a
                        question. They hold a current model of it.
                    </p>
                    <Table head={["Model", "Content"]} rows={STATE_MODEL.map(([a, b]) => (
                        <tr key={a}><td>{a}</td><td>{b}</td></tr>
                    ))} />
                </Part>

                {/* PART 2 */}
                <Part id="p2" n="2" title="Target architecture">
                    <p className="ap-body">
                        Six tiers, each with its own clock and its own responsibility. The
                        highlighted steps are the ones that must never wait on a language model.
                    </p>
                    <div className="ap-tiers">
                        {TIERS.map((tier, ti) => (
                            <div key={tier.id}>
                                <div className="ap-tier">
                                    <div className="ap-tier-side">
                                        <div className="ap-tier-id">{tier.id}</div>
                                        <div className="ap-tier-name">{tier.name}</div>
                                        <div className="ap-tier-cad">{tier.cadence}</div>
                                        <div className={`ap-tier-llm ${tier.llm === "never" ? "no" : "yes"}`}>
                                            model calls: {tier.llm}
                                        </div>
                                    </div>
                                    <div className="ap-flow">
                                        {tier.steps.map(([label, kind], i) => (
                                            <span key={label + i} className="ap-flow-item">
                                                <span className={`ap-step${kind ? ` ${kind}` : ""}`}>{label}</span>
                                                {i < tier.steps.length - 1 && (
                                                    <span className="ap-arrow" aria-hidden="true">{"→"}</span>
                                                )}
                                            </span>
                                        ))}
                                    </div>
                                </div>
                                {ti < TIERS.length - 1 && (
                                    <div className="ap-tier-gap" aria-hidden="true">{"↓"}</div>
                                )}
                            </div>
                        ))}
                    </div>
                    <div className="ap-loopback">
                        <b>Tier 5 is not a terminus.</b> A fill changes the position, which re-arms
                        the reflex lane, which changes what the next tick means. Reconciliation
                        changes what the risk gate will permit. Recovery repopulates the attention
                        queue. <b>The loop closes back into Tier 0.</b>
                    </div>
                </Part>

                {/* PART 3 */}
                <Part id="p3" n="3" title="Why the architecture is split this way">
                    <blockquote className="ap-quote">
                        The boundary between the fast path and the slow path is not drawn by latency
                        budget. It is drawn by who already made the decision.
                    </blockquote>
                    <p className="ap-body">
                        A thesis is a pre-commitment. It names its stop, its target and the
                        conditions that would prove it wrong, and the risk gate has already
                        authorised the position those levels belong to. Executing a pre-commitment
                        requires no judgement, so it belongs on the tick. Forming or revising a view
                        requires judgement, so it belongs on the event.
                    </p>
                    <p className="ap-body">
                        This is why simply reducing the position monitor from 15 seconds to 1 second
                        would not have solved the problem: it polls faster for a decision that
                        should not be polled for at all.
                    </p>
                    <Table head={["Cadence", "Responsibility", "Model calls"]} rows={CADENCES.map(([a, b, c]) => (
                        <tr key={a}><td>{a}</td><td>{b}</td><td className="ap-mono">{c}</td></tr>
                    ))} />
                    <blockquote className="ap-quote">
                        Continuous observation does not mean continuous model calls.
                    </blockquote>
                    <p className="ap-body">
                        The reflex layer is deterministic and extremely fast: measured at{" "}
                        <b>69 nanoseconds per tick</b> across a 200-symbol universe with 25 armed
                        positions, roughly 14 million tick evaluations per second. It runs on every
                        tick because it can. The reasoning layer is slow and expensive, so it wakes
                        only when something material has happened. A quiet position costs zero model
                        calls, and this is asserted by test.
                    </p>
                    <p className="ap-body">
                        Placing a language model between a tick and a pre-committed protective
                        action would make protection depend on network latency to a third-party
                        inference provider. That is the single most important structural decision in
                        this document.
                    </p>
                </Part>

                {/* PART 4 */}
                <Part id="p4" n="4" title="Senior trader reasoning model">
                    <p className="ap-body">
                        The reasoning layer is structured around the questions a disciplined senior
                        trader actually asks. Each maps to a field the system either computes
                        deterministically or requires the model to supply.
                    </p>
                    <Table head={["#", "Question", "Where it is answered"]} rows={QUESTIONS.map(([n, q, a, flag]) => (
                        <tr key={n}>
                            <td className="ap-mono">{n}</td>
                            <td>{q}</td>
                            <td>
                                {flag === "no" && <span className="ap-chip no">Not answered</span>}
                                {flag === "part" && <span className="ap-chip part">Partial</span>}
                                {flag ? " " : ""}{a}
                            </td>
                        </tr>
                    ))} />

                    <h3 className="ap-sub">The evidence hierarchy</h3>
                    <p className="ap-body">
                        Tier is assigned by <b>origin</b>, never by the model's claim about its own
                        confidence. A model statement is clamped to inference at the boundary; it
                        cannot promote itself to fact.
                    </p>
                    <Table head={["Tier", "Meaning", "Example"]} rows={EVIDENCE_TIERS.map(([t, m, e]) => (
                        <tr key={t}><td className="ap-mono">{t}</td><td>{m}</td><td>{e}</td></tr>
                    ))} />

                    <h3 className="ap-sub">How the reasoning differs by situation</h3>
                    <Table head={["Situation", "The question asked", "Distinct behaviour"]} rows={SITUATIONS.map(([s, q, b]) => (
                        <tr key={s}><td>{s}</td><td>{q}</td><td>{b}</td></tr>
                    ))} />

                    <h3 className="ap-sub">What the model may not decide</h3>
                    <p className="ap-body">
                        Evidence tiering, regime derivation, risk-reward, the cost hurdle, expected
                        value, opportunity cost, thesis age, staleness, action legality, confidence,
                        every downgrade, revalidation and the risk gate are all decided without it.
                        Structural consequences: a probability supplied by the model is discarded and
                        expected value stays insufficient-basis; a target implying under 73.55 bps is
                        refused however convincing the prose; no target at all is a refusal, not a
                        pass; stale data blocks new exposure but never blocks an exit.
                    </p>
                </Part>

                {/* PART 5 */}
                <Part id="p5" n="5" title="Data flow">
                    <p className="ap-body">
                        Each stage states what enters, what changes, what leaves, and why the stage
                        exists at all.
                    </p>
                    <Table head={["#", "Stage", "Changes", "Why it exists"]} rows={DATA_FLOW.map(([n, s, c, w]) => (
                        <tr key={n}>
                            <td className="ap-mono">{n}</td><td>{s}</td><td>{c}</td><td>{w}</td>
                        </tr>
                    ))} />
                </Part>

                {/* PART 6 */}
                <Part id="p6" n="6" title="Safety architecture">
                    <blockquote className="ap-quote">
                        The model provides interpretation. The deterministic system provides
                        permission.
                    </blockquote>

                    <h3 className="ap-sub">What the model cannot do</h3>
                    <Table head={["Cannot", "Enforced by"]} rows={AI_CANNOT.map(([a, b]) => (
                        <tr key={a}><td>{a}</td><td>{b}</td></tr>
                    ))} />

                    <h3 className="ap-sub">The mechanisms</h3>
                    <Table head={["Mechanism", "Implementation", "Guarantee"]} rows={MECHANISMS.map(([a, b, c]) => (
                        <tr key={a}><td>{a}</td><td>{b}</td><td>{c}</td></tr>
                    ))} />

                    <h3 className="ap-sub">One deliberate exception, stated explicitly</h3>
                    <p className="ap-body">
                        The Tier 0 protective exit <b>does not consult the risk gate</b>. This is a
                        design decision, not an oversight. Risk-reducing actions are exempt from
                        exposure budgets by design — a limit that stops you closing a position is a
                        limit that traps you in one. The position was authorised by the gate when it
                        was opened. And the execution engine remains the authority on whether the
                        sell is possible at all, refusing to create a negative position. Placing a
                        gate on this path would reintroduce exactly the latency the tier exists to
                        remove.
                    </p>
                </Part>

                {/* PART 7 */}
                <Part id="p7" n="7" title="Current implemented architecture">
                    <p className="ap-body ap-legend">
                        Mapped from implementation inspection.
                        <span className="ap-chip ok">Built + tested</span>
                        <span className="ap-chip built">Built</span>
                        <span className="ap-chip part">Partial</span>
                        <span className="ap-chip idle">Available, unused</span>
                        <span className="ap-chip no">Not built</span>
                    </p>
                    <Table head={["Target layer", "Actual components", "Status", "Proof"]}
                        rows={IMPLEMENTED.map(([layer, comp, status, proof, extra]) => (
                            <tr key={layer}>
                                <td>{layer}</td>
                                <td>{comp}</td>
                                <td>
                                    <span className={`ap-chip ${status}`}>{STATUS_LABEL[status]}</span>
                                    {extra && <span className={`ap-chip ${extra}`}>Live validation required</span>}
                                </td>
                                <td>{proof}</td>
                            </tr>
                        ))} />
                </Part>

                {/* PART 8 */}
                <Part id="p8" n="8" title="Current end-to-end flow">
                    <h3 className="ap-sub">A · Fully implemented and tested, against synthetic input</h3>
                    <p className="ap-body">
                        The complete chain runs today under test against a real database and a real
                        cache: synthetic ticks, real bar aggregation, real derived granularities,
                        real intelligence, real screening, real trader state, a scripted model
                        transport, real challenge, real synthesis, real revalidation, real risk
                        gate, real execution engine, real fill, real position, real monitoring, real
                        reassessment, real exit, real reconciliation and a real journal.
                    </p>
                    <p className="ap-body">
                        Demonstrated lifecycles: a clean entry surviving challenge; a false breakout
                        broken by the challenger; a thesis weakening into a partial reduction; a
                        thesis invalidated into an exit; a good-looking setup refused purely on cost
                        grounds; and the tick-level case where a crossing tick produces a protective
                        order with the model never consulted.
                    </p>

                    <h3 className="ap-sub">B · Implemented but only simulated</h3>
                    <Table head={["Area", "What is simulated"]} rows={SIMULATED.map(([a, b]) => (
                        <tr key={a}><td>{a}</td><td>{b}</td></tr>
                    ))} />

                    <h3 className="ap-sub">C · Requires live market validation</h3>
                    <p className="ap-body">
                        Real tick field names and arrival rates; actual reflex latency end to end
                        including the database write; reconnect behaviour against the real socket;
                        the warm-up timeline — detectors arm around 09:37, multi-timeframe context
                        completes at 09:46, the earliest candidate near 10:01, all measured by
                        simulation only; real anomaly firing rates; announcement polling during a
                        session; model latency under load; and one complete lifecycle on real prices.
                    </p>

                    <h3 className="ap-sub">D · Not yet implemented</h3>
                    <p className="ap-body">
                        Live broker connectivity; portfolio-level opportunity ranking; sector and
                        correlation awareness; durable news; bounded parallel reasoning; a single
                        authoritative time source; realistic order latency and partial-fill
                        modelling in the default path.
                    </p>

                    <blockquote className="ap-quote warn">
                        No behaviour described in this document has ever been observed against a
                        live market session. Paper and synthetic results are not live validation.
                    </blockquote>
                </Part>

                {/* PART 9 */}
                <Part id="p9" n="9" title="Current progress">
                    <p className="ap-body">
                        Measured by behavioural capability against the destination — not by file
                        count, test count or module count. Each category is scored on what the
                        system can demonstrably do, then weighted by that category's contribution to
                        a senior-level autonomous trading platform operating continuously in the
                        Indian market.
                    </p>

                    <div className="ap-overall">
                        <div className="ap-overall-score">
                            <div className="ap-big">45<span>%</span></div>
                            <div className="ap-big-cap">toward a senior-level autonomous trading platform</div>
                        </div>
                        <div className="ap-bars">
                            <div className="ap-bar-head">
                                <span>Category</span><span /><span>Score</span><span>Weight</span>
                            </div>
                            {PROGRESS.map(([label, score, weight]) => (
                                <div className="ap-bar-row" key={label}>
                                    <div className="ap-bar-lbl">{label}</div>
                                    <div className="ap-bar-track">
                                        <div className={`ap-bar-fill ${barClass(score)}`}
                                            style={{ width: `${Math.max(score, 1)}%` }} />
                                    </div>
                                    <div className="ap-bar-pct">{score}</div>
                                    <div className="ap-bar-wt">{weight}</div>
                                </div>
                            ))}
                        </div>
                    </div>

                    <h3 className="ap-sub">Why the total is far below the average of the categories</h3>
                    <p className="ap-body">
                        Six of ten categories score 60% or above. The total is 45% because the two
                        heaviest — live operation and demonstrated edge — carry 35% of the weight
                        between them and score 0% and 10%. This is deliberate. A system that has
                        never operated and has no proven edge is not a trader, however well built.
                    </p>

                    <h3 className="ap-sub">What would move the number most</h3>
                    <Table head={["Change", "Estimated effect"]} rows={MOVERS.map(([a, b]) => (
                        <tr key={a}><td>{a}</td><td className="ap-mono">{b}</td></tr>
                    ))} />
                </Part>

                {/* PART 10 */}
                <Part id="p10" n="10" title="What has been proven">
                    <p className="ap-body">
                        Verified by running the suites during this documentation pass:{" "}
                        <b>871</b> application tests passed across three consecutive clean runs,{" "}
                        <b>557</b> research tests passed, 6 skipped.
                    </p>
                    <Table head={["Guarantee", "Proof"]} rows={PROVEN.map(([a, b]) => (
                        <tr key={a}><td>{a}</td><td>{b}</td></tr>
                    ))} />
                    <blockquote className="ap-quote warn">
                        871 passing tests prove the implementation matches its tests. They do not
                        prove the architecture is correct for live autonomous trading, and they say
                        nothing about profitability.
                    </blockquote>
                    <p className="ap-body">
                        Two of the most serious defects found in this project — a ledger that
                        destroyed principal on every end-of-day close, and two risk guards that could
                        never fire — existed for weeks underneath a fully green suite.
                    </p>
                </Part>

                {/* PART 11 */}
                <Part id="p11" n="11" title="Remaining gaps">
                    <p className="ap-body">Dependency-ordered.</p>
                    {GAPS.map((g) => (
                        <div className={`ap-gap${g.blocking ? " blocking" : ""}`} key={g.n}>
                            <div className="ap-gap-stripe" />
                            <div className="ap-gap-in">
                                <div className="ap-gap-top">
                                    {g.blocking && <span className="ap-chip no">Blocking</span>}
                                    <span className="ap-chip idle">{g.n}</span>
                                </div>
                                <h4>{g.title}</h4>
                                <div className="ap-gap-grid">
                                    <div><div className="ap-k">Why it matters</div><div className="ap-v">{g.why}</div></div>
                                    <div><div className="ap-k">Current state</div><div className="ap-v">{g.state}</div></div>
                                    <div><div className="ap-k">Dependency</div><div className="ap-v">{g.dep}</div></div>
                                    <div><div className="ap-k">Done when</div><div className="ap-v">{g.done}</div></div>
                                </div>
                            </div>
                        </div>
                    ))}

                    <div className="ap-gap">
                        <div className="ap-gap-stripe" />
                        <div className="ap-gap-in">
                            <div className="ap-gap-top"><span className="ap-chip part">Gaps 8–10</span></div>
                            <h4>Durable news · isolated test databases · realistic order modelling</h4>
                            <div className="ap-gap-grid">
                                {GAPS_MINOR.map(([k, v]) => (
                                    <div key={k}><div className="ap-k">{k}</div><div className="ap-v">{v}</div></div>
                                ))}
                            </div>
                        </div>
                    </div>

                    <div className="ap-gap blocking">
                        <div className="ap-gap-stripe" />
                        <div className="ap-gap-in">
                            <div className="ap-gap-top">
                                <span className="ap-chip no">Blocking</span>
                                <span className="ap-chip idle">Gaps 11–12</span>
                            </div>
                            <h4>Five unattended sessions · demonstrated trading edge</h4>
                            <div className="ap-gap-grid">
                                {GAPS_FINAL.map(([k, v]) => (
                                    <div key={k}><div className="ap-k">{k}</div><div className="ap-v">{v}</div></div>
                                ))}
                            </div>
                        </div>
                    </div>

                    <h3 className="ap-sub">Additional findings from this inspection</h3>
                    <Table head={["Finding", "State"]} rows={EXTRA_FLAWS.map(([a, b]) => (
                        <tr key={a}><td>{a}</td><td>{b}</td></tr>
                    ))} />
                </Part>

                {/* PART 12 */}
                <Part id="p12" n="12" title="Final roadmap">
                    <p className="ap-body">
                        Dependency-ordered. Each stage is independently testable and independently
                        revertible.
                    </p>
                    <ol className="ap-road">
                        {ROADMAP.map(([title, detail, kind], i) => (
                            <li key={title}>
                                <div className={`ap-road-step${kind ? ` ${kind}` : ""}`}>
                                    <h4>{title}</h4>
                                    {detail && <p>{detail}</p>}
                                </div>
                                {i < ROADMAP.length - 1 && (
                                    <div className="ap-road-link" aria-hidden="true">{"↓"}</div>
                                )}
                            </li>
                        ))}
                    </ol>
                    <h3 className="ap-sub">Two constraints on this sequence</h3>
                    <p className="ap-body">
                        <b>Single execution authority must precede the broker adapter.</b> More than
                        one writer against a paper ledger is a correctness problem; more than one
                        writer against a real broker is how an account and reality diverge
                        irrecoverably.
                    </p>
                    <p className="ap-body">
                        <b>Demonstrated edge is not a stage in this pipeline.</b> It runs in
                        parallel, in the research track, under the frozen protocol. No amount of
                        engineering progress substitutes for it, and controlled live validation
                        should not begin without it.
                    </p>
                </Part>

                {/* PART 13 */}
                <Part id="p13" n="13" title="Formal architecture summary">
                    <div className="ap-qa">
                        {SUMMARY.map(([q, a]) => (
                            <div className="ap-qa-item" key={q}>
                                <h4>{q}</h4>
                                <p>{a}</p>
                            </div>
                        ))}
                    </div>
                    <div className="ap-closing">
                        <h3>Closing statement</h3>
                        <p>
                            The architecture is now substantially aligned with the intended
                            senior-trader model. Observation is continuous, protection is immediate
                            and deterministic, judgement is event-driven and adversarial, permission
                            is arithmetic, and the audit trail reconstructs any action from a single
                            correlation identifier.
                        </p>
                        <p>
                            <b>Live operation and demonstrated economic edge remain unproven.</b>{" "}
                            ZenTrade Brain has never processed a tick from a live market session, and
                            the research record states plainly that no measured edge currently
                            survives the cost hurdle. The system is, at this point, good enough to be
                            trusted to refuse correctly. It is not yet good enough to be trusted to
                            act.
                        </p>
                    </div>
                </Part>

                <footer className="ap-footer">
                    <span>ZenTrade Brain — Architecture &amp; Progress</span>
                    <span>30 August 2026</span>
                    <span>Paper mode only · not live</span>
                    <span>871 application tests · 557 research tests · holdout looks 0</span>
                </footer>
            </main>
        </div>
    );
};

export default ArchitectureProgress;
