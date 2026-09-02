import { useCallback, useEffect, useMemo, useState } from "react";
import api from "../services/api.js";
import { clockTime, duration, rupees, signedRupees, ratio, text, titleCase,
         severityClass, tierClass, isKnown, UNKNOWN } from "../components/cockpit/format.js";
import "./Logbook.css";

// The logbook.
//
// Everything the trader wrote down for a session, in the order it happened.
// Every row here was persisted at the time by the system itself: the decisions
// and the full reasoning inside them, the model calls each one cost, the
// conditions that woke it, the orders, fills, theses and reassessments, and the
// runtime's own comings and goings.
//
// Read only, and it invents nothing. A value the system does not have renders
// as UNKNOWN rather than as a plausible number, and a section with no rows says
// so rather than showing an empty frame that reads as broken.

// The nine record types the session store keeps. Counted from the database,
// not from what this page happened to load.
const TALLY = [
    ["decisions", "decisions"],
    ["marketEvents", "market events"],
    ["modelCalls", "model calls"],
    ["orders", "orders"],
    ["fills", "fills"],
    ["theses", "theses"],
    ["reassessments", "reassessments"],
    ["agentEvents", "agent events"],
];

// The API may be asleep. A free host takes the better part of a minute to boot,
// so the page waits that out rather than reporting the record as unavailable.
const WAKE_LIMIT_MS = 90_000;
const PROBE_TIMEOUT_MS = 8_000;
const REFRESH_MS = 20_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LANES = [
    { id: "all", label: "Everything" },
    { id: "reasoning", label: "Reasoning" },
    { id: "execution", label: "Execution" },
    { id: "market", label: "Market" },
    { id: "model", label: "Model calls" },
    { id: "system", label: "System" },
];

// One timeline. Each source is mapped to a common shape so the whole session
// reads in order rather than as six separate tables.
const buildTimeline = (log) => {
    if (!log) return [];
    const rows = [];
    const push = (lane, at, kind, symbol, payload) =>
        rows.push({ lane, at, kind, symbol, payload, ts: new Date(at).getTime() });

    for (const d of log.decisions ?? [])
        push("reasoning", d.at, "DECISION", d.symbol, d);
    for (const c of log.modelCalls ?? [])
        push("model", c.at, "MODEL_CALL", c.symbol, c);
    for (const e of log.marketEvents ?? [])
        push("market", e.at, "MARKET_EVENT", e.symbol, e);
    for (const o of log.orders ?? [])
        push("execution", o.at, "ORDER", o.symbol, o);
    for (const f of log.fills ?? [])
        push("execution", f.at, "FILL", f.symbol, f);
    for (const t of log.theses ?? [])
        push("execution", t.openedAt, "THESIS", t.symbol, t);
    for (const r of log.reassessments ?? [])
        push("reasoning", r.at, "REASSESSMENT", r.symbol, r);
    for (const a of log.agentEvents ?? [])
        push("system", a.at, "AGENT", null, a);

    return rows.sort((a, b) => b.ts - a.ts);
};

// Payload keys arrive as they were stored: camelCase, machine-shaped. Rendered
// as a label a person reads without translating.
const labelOf = (key) => {
    const spaced = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/_/g, " ");
    return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
};

const Field = ({ label, children, value }) => (
    <div className="lb-field">
        <span className="lb-field-label">{label}</span>
        <div className="lb-field-value">{value === undefined ? children : text(value)}</div>
    </div>
);

const Bullets = ({ items, empty = "none stated" }) => {
    const lines = (Array.isArray(items) ? items : items ? [items] : [])
        .map((t) => text(t, "")).filter(Boolean);
    return lines.length
        ? <ul className="lb-bullets">{lines.map((t, i) => <li key={i}>{t}</li>)}</ul>
        : <span className="lb-muted">{empty}</span>;
};

// ---- the decision, opened out ----------------------------------------------
//
// The full chain the system recorded: what woke it, what it knew, what it
// believed, what the challenger said, what the arithmetic measured, what the
// gates did, and what happened.

const DecisionBody = ({ d, calls = [] }) => {
    const s = d.synthesis ?? {};
    const gates = s.entryGates ?? [];
    const spend = calls.reduce(
        (n, c) => n + (c.promptTokens ?? 0) + (c.completionTokens ?? 0), 0);
    return (
        <div className="lb-body">
            <div className="lb-chain">
                <Field label="Woke on">
                    {d.trigger
                        ? `${titleCase(d.trigger.type)}${d.trigger.reason ? ` — ${d.trigger.reason}` : ""}`
                        : UNKNOWN}
                </Field>
                <Field label="Thesis" value={d.thesis} />
                <Field label="Model proposed">
                    <span className={`lb-act lb-act-${s.proposedAction ?? "NONE"}`}>
                        {text(s.proposedAction, "not recorded")}
                    </span>
                    {s.proposedAction && s.proposedAction !== d.action ? (
                        <span className="lb-arrow"> → became {d.action}</span>
                    ) : null}
                </Field>
            </div>

            <div className="lb-evidence">
                <span className="lb-sub">Facts it reasoned from</span>
                {d.evidence?.length ? d.evidence.map((e, i) => (
                    <div key={i} className={`lb-ev ${tierClass(e.tier)}`}>
                        <span className="lb-ev-tier">{text(e.tier, "?")}</span>
                        <span>{text(e.statement)}</span>
                    </div>
                )) : <span className="lb-muted">no evidence recorded</span>}
            </div>

            <div className="lb-two">
                <div>
                    <span className="lb-sub">Supporting</span>
                    <Bullets items={d.supporting} />
                </div>
                <div>
                    <span className="lb-sub">Contradicting</span>
                    <Bullets items={d.contradicting} />
                </div>
            </div>

            <div className="lb-challenge">
                <span className="lb-sub">
                    The challenge
                    <em className={`lb-verdict lb-v-${d.challengeVerdict ?? "NONE"}`}>
                        {text(d.challengeVerdict, "not challenged")}
                    </em>
                </span>
                <Field label="Counter-thesis" value={d.counterThesis} />
                <Field label="Alternatives"><Bullets items={d.alternatives} /></Field>
                <Field label="What would change its mind">
                    <Bullets items={d.whatWouldChange} />
                </Field>
            </div>

            <div className="lb-synth">
                <span className="lb-sub">The arithmetic</span>
                <div className="lb-grid">
                    <Field label="Risk / reward">{ratio(s.riskReward?.ratio)}</Field>
                    <Field label="Edge" value={s.edge?.verdict} />
                    <Field label="Stop">{rupees(s.stopPaise)}</Field>
                    <Field label="Target">{rupees(s.targetPaise)}</Field>
                    <Field label="Setup" value={s.setupType} />
                    <Field label="Horizon" value={s.horizon} />
                </div>
                {s.edge?.reason ? <Field label="Cost test" value={s.edge.reason} /> : null}
            </div>

            {gates.length ? (
                <div className="lb-gates">
                    <span className="lb-sub">Gates that acted</span>
                    <Bullets items={gates} />
                </div>
            ) : null}

            {calls.length ? (
                <div className="lb-calls">
                    <span className="lb-sub">
                        What it cost<em>{calls.length} call{calls.length > 1 ? "s" : ""}
                        {spend ? ` · ${spend.toLocaleString("en-IN")} tokens` : ""}</em>
                    </span>
                    {calls.map((c, i) => (
                        <div key={i} className="lb-call">
                            <span className="lb-call-agent">{text(c.agent).replace(/_/g, " ")}</span>
                            <span className={c.status === "ok" ? "lb-good" : "lb-bad"}>{text(c.status)}</span>
                            <span className="lb-muted">
                                {isKnown(c.latencyMs) ? `${c.latencyMs} ms` : UNKNOWN}
                            </span>
                            <span className="lb-muted">
                                {isKnown(c.promptTokens)
                                    ? `${c.promptTokens} in · ${c.completionTokens ?? 0} out`
                                    : (c.error ? text(c.error) : UNKNOWN)}
                            </span>
                        </div>
                    ))}
                </div>
            ) : null}

            <div className="lb-outcome">
                <Field label="Risk gate">
                    {d.risk
                        ? `${d.risk.decision}${d.risk.code ? ` — ${d.risk.code}` : ""}`
                        : "not reached"}
                </Field>
                <Field label="Outcome">
                    {d.executed
                        ? `EXECUTED ${text(d.quantity)} at ${rupees(d.pricePaise)}`
                        : (d.blockedReason ?? "no order")}
                </Field>
                <Field label="Correlation" value={d.correlationId} />
            </div>
        </div>
    );
};

// The reasoning behind a position that is already open. This is the same
// senior-trader chain as an entry, run against a live position, and its
// reasoning field is the longest prose the system stores.
const ReassessmentBody = ({ r }) => (
    <div className="lb-body">
        <div className="lb-chain">
            <Field label="Verdict">
                <span className={`lb-act lb-act-${r.action}`}>{text(r.action)}</span>
                <span className="lb-arrow"> · thesis {r.thesisStillValid === false
                    ? <b className="lb-bad">no longer valid</b> : <b className="lb-good">still holds</b>}</span>
                {r.material ? <span className="lb-arrow"> · change judged <b>material</b></span> : null}
            </Field>
            <Field label="What changed" value={r.whatChanged} />
            <Field label="Confidence" value={r.confidence} />
        </div>
        <div className="lb-synth">
            <span className="lb-sub">Its reasoning</span>
            <p className="lb-prose">{text(r.reasoning)}</p>
        </div>
        <div className="lb-outcome">
            <Field label="Held for">{duration(r.holdingSeconds)}</Field>
            <Field label="Price">{rupees(r.currentPricePaise)}</Field>
            <Field label="Open P&L">
                <span className={(r.unrealisedPnlPaise ?? 0) >= 0 ? "lb-good" : "lb-bad"}>
                    {signedRupees(r.unrealisedPnlPaise)}</span>
            </Field>
            <Field label="Risk gate">
                {r.risk ? `${r.risk.decision}${r.risk.reason ? ` — ${r.risk.reason}` : ""}`
                        : "not reached"}
            </Field>
            <Field label="Acted">{r.executed ? "yes" : "no"}</Field>
        </div>
    </div>
);

const EventBody = ({ e }) => (
    <div className="lb-body">
        <div className="lb-chain">
            <Field label="Detector" value={e.observed?.detector} />
            <Field label="Reason" value={e.reason} />
            <Field label="Severity" value={e.severity} />
        </div>
        {e.observed && Object.keys(e.observed).length ? (
            <div className="lb-synth">
                <span className="lb-sub">What it measured</span>
                <div className="lb-grid">
                    {Object.entries(e.observed).map(([k, v]) => (
                        <Field key={k} label={labelOf(k)} value={v} />
                    ))}
                </div>
            </div>
        ) : null}
        <div className="lb-outcome">
            <Field label="Handling">{text(e.state)}</Field>
            <Field label="Attempts">{text(e.attempts)}</Field>
            <Field label="Handled at">{e.handledAt ? clockTime(e.handledAt) : "not handled"}</Field>
            {e.lastError ? <Field label="Last error" value={e.lastError} /> : null}
            <Field label="Key" value={e.key} />
        </div>
    </div>
);

const OrderBody = ({ o }) => (
    <div className="lb-body">
        <div className="lb-grid">
            <Field label="Side" value={o.side} />
            <Field label="State" value={o.state} />
            <Field label="Mode" value={o.mode} />
            <Field label="Quantity">{text(o.quantity)}</Field>
            <Field label="Filled">{text(o.filledQuantity)}</Field>
            <Field label="Price">{rupees(o.pricePaise)}</Field>
            <Field label="Value">{rupees(o.totalValuePaise)}</Field>
            <Field label="Brokerage">{rupees(o.brokeragePaise)}</Field>
            <Field label="Realised P&L">
                {isKnown(o.pnlPaise)
                    ? <span className={o.pnlPaise >= 0 ? "lb-good" : "lb-bad"}>
                        {signedRupees(o.pnlPaise)}</span>
                    : UNKNOWN}
            </Field>
        </div>
        <div className="lb-outcome">
            {o.rejectionReason ? <Field label="Rejected" value={o.rejectionReason} /> : null}
            {o.ambiguityReason ? <Field label="Ambiguity" value={o.ambiguityReason} /> : null}
            <Field label="Completed">{o.completedAt ? clockTime(o.completedAt) : "open"}</Field>
            <Field label="Client id" value={o.clientOrderId} />
            <Field label="Correlation" value={o.correlationId} />
        </div>
    </div>
);

const ThesisBody = ({ t }) => (
    <div className="lb-body">
        <div className="lb-chain">
            <Field label="Setup" value={t.setupType} />
            <Field label="Horizon" value={t.horizon} />
        </div>
        <div className="lb-synth">
            <span className="lb-sub">Why the position exists</span>
            <p className="lb-prose">{text(t.rationale)}</p>
        </div>
        <div className="lb-gates">
            <span className="lb-sub">What would invalidate it</span>
            <Bullets items={t.invalidationConditions} />
        </div>
        <div className="lb-grid">
            <Field label="Entry">{rupees(t.entryPricePaise)}</Field>
            <Field label="Stop">{rupees(t.stopPaise)}</Field>
            <Field label="Target">{rupees(t.targetPaise)}</Field>
            <Field label="Quantity">{text(t.quantity)}</Field>
            <Field label="Closed">{t.closedAt ? clockTime(t.closedAt) : "open"}</Field>
        </div>
    </div>
);

const ModelCallBody = ({ c }) => (
    <div className="lb-body">
        <div className="lb-grid">
            <Field label="Agent">{text(c.agent).replace(/_/g, " ")}</Field>
            <Field label="Model" value={c.model} />
            <Field label="Status" value={c.status} />
            <Field label="Latency">{isKnown(c.latencyMs) ? `${c.latencyMs} ms` : UNKNOWN}</Field>
            <Field label="Prompt tokens">{text(c.promptTokens)}</Field>
            <Field label="Completion tokens">{text(c.completionTokens)}</Field>
        </div>
        {c.error ? (
            <div className="lb-challenge">
                <span className="lb-sub">Why it failed</span>
                <p className="lb-prose lb-bad">{text(c.error)}</p>
            </div>
        ) : (
            <p className="lb-muted lb-note-line">
                The answer this call produced is stored as the decision itself, not
                duplicated here.
            </p>
        )}
        <div className="lb-outcome">
            <Field label="Decision" value={c.decisionId} />
        </div>
    </div>
);

const AgentBody = ({ a }) => (
    <div className="lb-body">
        <div className="lb-grid">
            {Object.entries(a.detail ?? {}).map(([k, v]) => (
                <Field key={k} label={labelOf(k)}
                       value={Array.isArray(v) ? (v.length ? v.join(", ") : "none") : v} />
            ))}
        </div>
        {!Object.keys(a.detail ?? {}).length
            ? <span className="lb-muted">no detail recorded</span> : null}
    </div>
);

const Row = ({ row, open, onToggle, calls = [] }) => {
    const p = row.payload;
    const head = () => {
        switch (row.kind) {
            case "DECISION": {
                const proposed = p.synthesis?.proposedAction;
                return (<>
                    <span className={`lb-act lb-act-${p.action}`}>{text(p.action)}</span>
                    {proposed && proposed !== p.action
                        ? <span className="lb-muted">was {proposed}</span> : null}
                    <span className="lb-muted">
                        rr {ratio(p.synthesis?.riskReward?.ratio)} · {text(p.synthesis?.edge?.verdict, "—")}
                    </span>
                    {p.executed ? <span className="lb-good">EXECUTED</span> : null}
                </>);
            }
            case "MODEL_CALL":
                return (<>
                    <span className="lb-muted">{text(p.agent).replace(/_/g, " ")}</span>
                    <span className={p.status === "ok" ? "lb-good" : "lb-bad"}>{text(p.status)}</span>
                    <span className="lb-muted">
                        {isKnown(p.latencyMs) ? `${p.latencyMs}ms` : UNKNOWN}
                        {isKnown(p.promptTokens)
                            ? ` · ${p.promptTokens + (p.completionTokens ?? 0)} tok` : ""}
                    </span>
                    {p.error ? <span className="lb-bad">{text(p.error).slice(0, 60)}</span> : null}
                </>);
            case "MARKET_EVENT":
                return (<>
                    <span className={severityClass(p.severity)}>{titleCase(p.type)}</span>
                    <span className="lb-muted">{text(p.reason).slice(0, 78)}</span>
                    <span className="lb-state">{text(p.state)}</span>
                </>);
            case "ORDER":
                return (<>
                    <span className={`lb-act lb-act-${p.side}`}>{text(p.side)}</span>
                    <span>{text(p.quantity)} @ {rupees(p.pricePaise)}</span>
                    <span className="lb-state">{text(p.state)}</span>
                    {isKnown(p.pnlPaise)
                        ? <span className={p.pnlPaise >= 0 ? "lb-good" : "lb-bad"}>
                            {signedRupees(p.pnlPaise)}</span> : null}
                </>);
            case "FILL":
                return (<>
                    <span className="lb-good">FILLED</span>
                    <span>{text(p.quantity)} @ {rupees(p.pricePaise)}</span>
                    <span className="lb-muted">{text(p.executionRef)}</span>
                </>);
            case "THESIS":
                return (<>
                    <span className="lb-muted">{text(p.setupType)}</span>
                    <span>entry {rupees(p.entryPricePaise)} · stop {rupees(p.stopPaise)}
                        {" "}· target {rupees(p.targetPaise)}</span>
                    {p.closedAt ? <span className="lb-muted">closed</span> : null}
                </>);
            case "REASSESSMENT":
                return (<>
                    <span className={`lb-act lb-act-${p.action}`}>{text(p.action)}</span>
                    <span className="lb-muted">{text(p.whatChanged).slice(0, 70)}</span>
                    {isKnown(p.unrealisedPnlPaise)
                        ? <span className={p.unrealisedPnlPaise >= 0 ? "lb-good" : "lb-bad"}>
                            {signedRupees(p.unrealisedPnlPaise)}</span> : null}
                </>);
            case "AGENT":
                return (<>
                    <span className="lb-state">{titleCase(p.kind)}</span>
                    <span className="lb-muted">
                        {p.detail?.reason ? text(p.detail.reason)
                            : p.detail?.cashPaise !== undefined
                                ? `cash ${rupees(p.detail.cashPaise)}` : ""}
                    </span>
                </>);
            default: return null;
        }
    };

    const body = () => {
        switch (row.kind) {
            case "DECISION":     return <DecisionBody d={p} calls={calls} />;
            case "REASSESSMENT": return <ReassessmentBody r={p} />;
            case "MARKET_EVENT": return <EventBody e={p} />;
            case "ORDER":        return <OrderBody o={p} />;
            case "FILL":         return <OrderBody o={{ ...p, side: p.side, state: "FILLED" }} />;
            case "THESIS":       return <ThesisBody t={p} />;
            case "MODEL_CALL":   return <ModelCallBody c={p} />;
            case "AGENT":        return <AgentBody a={p} />;
            default:             return null;
        }
    };
    return (
        <article className={`lb-row lb-${row.kind.toLowerCase()}${open ? " lb-open" : ""}`}>
            <button type="button" className="lb-head"
                    onClick={onToggle} aria-expanded={open}>
                <time>{clockTime(row.at)}</time>
                <span className={`lb-kind lb-k-${row.lane}`}>{row.kind.replace(/_/g, " ")}</span>
                <span className="lb-symbol">{row.symbol ?? "—"}</span>
                <span className="lb-headline">{head()}</span>
                <span className="lb-chev">{open ? "−" : "+"}</span>
            </button>
            {open ? body() : null}
        </article>
    );
};

export const Logbook = () => {
    const [log, setLog] = useState(null);
    const [error, setError] = useState(null);
    const [lane, setLane] = useState("all");
    const [query, setQuery] = useState("");
    const [openId, setOpenId] = useState(null);
    const [date, setDate] = useState(null);
    const [waking, setWaking] = useState(null);

    const load = useCallback(async (forDate, { cold = false } = {}) => {
        const started = Date.now();
        // A sleeping host answers nothing until it has booted. Wake it with the
        // cheapest request there is before asking for a whole session, so the
        // first thing the reader sees is progress rather than a failure.
        if (cold) {
            let attempt = 0;
            while (Date.now() - started < WAKE_LIMIT_MS) {
                try {
                    await api.get("/health", { timeout: PROBE_TIMEOUT_MS });
                    break;
                } catch (err) {
                    // Any reply at all, including a refusal, proves the host is
                    // up. Only a dead connection means it is still booting.
                    if (err.response) break;
                    attempt += 1;
                    setWaking(Math.round((Date.now() - started) / 1000));
                    await sleep(Math.min(1000 * attempt, 4000));
                }
            }
        }

        for (let attempt = 0; ; attempt += 1) {
            try {
                const { data } = await api.get("/internal/cockpit/logbook", {
                    baseURL: "/",
                    params: forDate ? { date: forDate, limit: 5000 } : { limit: 5000 },
                });
                setLog(data); setError(null); setWaking(null);
                return;
            } catch (err) {
                if (err.response?.status === 401) {
                    setWaking(null);
                    setError("Sign in to read the logbook.");
                    return;
                }
                // A cold host can refuse or time out several times before it is
                // ready. Keep trying for as long as a cold start plausibly takes.
                if (cold && Date.now() - started < WAKE_LIMIT_MS) {
                    setWaking(Math.round((Date.now() - started) / 1000));
                    await sleep(Math.min(1500 * (attempt + 1), 5000));
                    continue;
                }
                setWaking(null);
                if (cold) setError("Logbook unavailable.");
                return;
            }
        }
    }, []);

    useEffect(() => { load(date, { cold: true }); }, [load, date]);
    // The session is still being written while it runs. A background refresh
    // never shows the waking state and never replaces a good page with an error.
    useEffect(() => {
        const t = setInterval(() => load(date), REFRESH_MS);
        return () => clearInterval(t);
    }, [load, date]);

    const timeline = useMemo(() => buildTimeline(log), [log]);
    // Each decision cost one or more model calls. Indexed here so a decision can
    // show its own price rather than leaving the calls stranded in another lane.
    const callsByDecision = useMemo(() => {
        const index = new Map();
        for (const c of log?.modelCalls ?? []) {
            const key = c.decisionId ?? c.correlationId;
            if (!key) continue;
            if (!index.has(key)) index.set(key, []);
            index.get(key).push(c);
        }
        return index;
    }, [log]);
    const rows = useMemo(() => {
        const q = query.trim().toLowerCase();
        return timeline.filter((r) => {
            if (lane !== "all" && r.lane !== lane) return false;
            if (!q) return true;
            return JSON.stringify(r.payload).toLowerCase().includes(q)
                || (r.symbol ?? "").toLowerCase().includes(q);
        });
    }, [timeline, lane, query]);

    const counts = useMemo(() => {
        const c = { all: timeline.length };
        for (const r of timeline) c[r.lane] = (c[r.lane] ?? 0) + 1;
        return c;
    }, [timeline]);

    if (waking !== null && !log) return (
        <div className="lb-root lb-centered">
            <div className="lb-wake">
                <span className="lb-wake-dot" />
                <p>Waking the server.</p>
                <p className="lb-muted">
                    It sleeps when idle and takes about a minute to come back.
                    Nothing is lost while it does.
                </p>
                <p className="lb-muted lb-wake-count">{waking}s</p>
            </div>
        </div>
    );
    if (error) return (
        <div className="lb-root lb-centered">
            <div className="lb-wake">
                <p>{error}</p>
                <button type="button" className="lb-retry"
                        onClick={() => { setError(null); load(date, { cold: true }); }}>
                    Try again
                </button>
            </div>
        </div>
    );
    if (!log) return <div className="lb-root lb-centered"><p className="lb-muted">
        reading the logbook…</p></div>;

    const s = log.summary;
    const calls = log.modelCalls ?? [];
    const failed = calls.filter((c) => c.status !== "ok").length;
    const decided = log.decisions ?? [];
    const proposedBuys = decided.filter((d) => d.synthesis?.proposedAction === "BUY").length;
    const executed = decided.filter((d) => d.executed).length;

    // Where the session lost candidates. Every number is counted from stored
    // records, so a stage that stopped nothing shows zero rather than vanishing.
    const ok = calls.filter((c) => c.status === "ok");
    const tokens = calls.reduce(
        (n, c) => n + (c.promptTokens ?? 0) + (c.completionTokens ?? 0), 0);
    const perDecision = decided.length ? Math.round(tokens / decided.length) : 0;
    const meanLatency = ok.length
        ? Math.round(ok.reduce((n, c) => n + (c.latencyMs ?? 0), 0) / ok.length) : 0;
    const funnel = [
        { label: "market events", n: log.counts?.marketEvents ?? 0,
          note: "detectors that fired" },
        { label: "decisions", n: decided.length, note: "reasoned to a verdict" },
        { label: "proposed a buy", n: proposedBuys, note: "the model argued for a position" },
        { label: "cleared costs", n: decided.filter(
            (d) => d.synthesis?.edge?.verdict === "CLEARS_COSTS").length,
          note: "beat the round-trip hurdle" },
        { label: "reached the risk gate", n: decided.filter((d) => d.risk).length,
          note: "deterministic limits" },
        { label: "executed", n: executed, note: "became a position" },
    ];

    return (
        <div className="lb-root">
            <header className="lb-top">
                <div className="lb-title">
                    <h1>Logbook</h1>
                    <span className="lb-muted">
                        every decision, and everything behind it · {log.sessionDate}
                        {log.today && log.today !== log.sessionDate ? (
                            <b className="lb-stale"> latest recorded session,
                                nothing stored yet for {log.today}</b>
                        ) : null}
                    </span>
                </div>
                <div className="lb-stats">
                    <div><b>{decided.length}</b><span>decisions</span></div>
                    <div><b>{proposedBuys}</b><span>proposed buy</span></div>
                    <div><b>{executed}</b><span>executed</span></div>
                    <div><b>{calls.length}</b><span>model calls</span></div>
                    <div className={failed ? "lb-warn" : ""}><b>{failed}</b><span>failed</span></div>
                    <div><b>{tokens.toLocaleString("en-IN")}</b><span>tokens</span></div>
                    {s ? <div><b>{signedRupees(Number(s.realised_pnl_paise))}</b>
                        <span>realised</span></div> : null}
                </div>
            </header>

            <section className="lb-funnel">
                <span className="lb-sub">How the session narrowed</span>
                <div className="lb-funnel-rows">
                    {funnel.map((f) => (
                        <div key={f.label} className="lb-fstep">
                            <div className="lb-fbar"
                                 style={{ width: `${funnel[0].n ? Math.max(2, (f.n / funnel[0].n) * 100) : 0}%` }} />
                            <div className="lb-fbody">
                                <b>{f.n.toLocaleString("en-IN")}</b>
                                <span>{f.label}</span>
                                <em className="lb-muted">{f.note}</em>
                            </div>
                        </div>
                    ))}
                </div>
                <div className="lb-spend">
                    <div><b>{tokens.toLocaleString("en-IN")}</b><span>tokens spent</span></div>
                    <div><b>{calls.length}</b><span>model calls</span></div>
                    <div className={failed ? "lb-warn" : ""}>
                        <b>{failed}</b><span>calls failed</span></div>
                    <div><b>{perDecision.toLocaleString("en-IN")}</b><span>tokens per decision</span></div>
                    <div><b>{meanLatency ? `${(meanLatency / 1000).toFixed(1)}s` : "—"}</b>
                        <span>mean latency</span></div>
                </div>
            </section>

            <div className="lb-controls">
                <div className="lb-lanes">
                    {LANES.map((l) => (
                        <button key={l.id} type="button"
                                className={`lb-lane${lane === l.id ? " lb-lane-on" : ""}`}
                                onClick={() => setLane(l.id)}>
                            {l.label}<em>{counts[l.id] ?? 0}</em>
                        </button>
                    ))}
                </div>
                <input className="lb-search" type="search" value={query}
                       onChange={(e) => setQuery(e.target.value)}
                       placeholder="filter by symbol, reason, anything…" />
                {log.availableDates?.length > 1 ? (
                    <select className="lb-date" value={date ?? log.sessionDate}
                            onChange={(e) => setDate(e.target.value)}>
                        {log.availableDates.map((d) => <option key={d} value={d}>{d}</option>)}
                    </select>
                ) : null}
            </div>

            {rows.length ? (
                <div className="lb-stream">
                    {rows.map((r, i) => (
                        <Row key={`${r.kind}-${r.ts}-${i}`} row={r}
                             calls={r.kind === "DECISION"
                                 ? (callsByDecision.get(r.payload.decisionId)
                                    ?? callsByDecision.get(r.payload.correlationId) ?? [])
                                 : []}
                             open={openId === `${r.kind}-${r.ts}-${i}`}
                             onToggle={() => setOpenId(
                                 openId === `${r.kind}-${r.ts}-${i}` ? null : `${r.kind}-${r.ts}-${i}`)} />
                    ))}
                </div>
            ) : (
                <div className="lb-empty">
                    <p>Nothing recorded here yet.</p>
                    <p className="lb-muted">
                        The logbook fills as the trader works. An empty session is a
                        quiet market, not a broken one.
                    </p>
                </div>
            )}

            {log.sessions?.length ? (
                <section className="lb-ledger">
                    <span className="lb-sub">Session summaries · one stored row per trading day</span>
                    <div className="lb-tablewrap">
                        <table className="lb-table">
                            <thead>
                                <tr>
                                    <th>Session</th><th>Opening cash</th><th>Closing cash</th>
                                    <th>Opening equity</th><th>Closing equity</th>
                                    <th>Realised</th><th>Unrealised</th><th>Costs</th>
                                    <th>Orders</th><th>Opened</th><th>Closed</th><th>Decisions</th>
                                </tr>
                            </thead>
                            <tbody>
                                {log.sessions.map((r) => (
                                    <tr key={r.session_date}
                                        className={r.session_date === log.sessionDate ? "lb-tr-on" : ""}>
                                        <td>{r.session_date}</td>
                                        <td>{rupees(Number(r.opening_cash_paise))}</td>
                                        <td>{rupees(Number(r.closing_cash_paise))}</td>
                                        <td>{rupees(Number(r.opening_equity_paise))}</td>
                                        <td>{rupees(Number(r.closing_equity_paise))}</td>
                                        <td className={Number(r.realised_pnl_paise) < 0 ? "lb-bad" : "lb-good"}>
                                            {signedRupees(Number(r.realised_pnl_paise))}</td>
                                        <td className={Number(r.unrealised_pnl_paise) < 0 ? "lb-bad" : "lb-good"}>
                                            {signedRupees(Number(r.unrealised_pnl_paise))}</td>
                                        <td>{rupees(Number(r.costs_paise))}</td>
                                        <td>{r.orders_placed}</td>
                                        <td>{r.positions_opened}</td>
                                        <td>{r.positions_closed}</td>
                                        <td>{r.decisions_made}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </section>
            ) : null}

            {log.counts ? (
                <section className="lb-tally">
                    <span className="lb-sub">Everything stored for {log.sessionDate}</span>
                    <div className="lb-tally-grid">
                        {TALLY.map(([key, label]) => (
                            <div key={key} className="lb-tally-cell">
                                <b>{(log.counts[key] ?? 0).toLocaleString("en-IN")}</b>
                                <span>{label}</span>
                                {log.returned?.[key] < log.counts[key] ? (
                                    <em className="lb-bad">
                                        showing {log.returned[key].toLocaleString("en-IN")}
                                    </em>
                                ) : null}
                            </div>
                        ))}
                    </div>
                    {log.truncated?.length ? (
                        <p className="lb-muted lb-trunc">
                            This session is larger than one read. Raise the limit to see the rest.
                        </p>
                    ) : (
                        <p className="lb-muted lb-trunc">
                            Every stored row for this session is on this page.
                        </p>
                    )}
                </section>
            ) : null}

            <footer className="lb-foot">
                Paper simulation · read-only · every row was written by the system
                at the time it happened
            </footer>
        </div>
    );
};

export default Logbook;
