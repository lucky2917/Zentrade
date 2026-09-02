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

const DecisionBody = ({ d }) => {
    const s = d.synthesis ?? {};
    const gates = s.entryGates ?? [];
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

const Row = ({ row, open, onToggle }) => {
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

    const expandable = row.kind === "DECISION";
    return (
        <article className={`lb-row lb-${row.kind.toLowerCase()}${open ? " lb-open" : ""}`}>
            <button type="button" className="lb-head"
                    onClick={expandable ? onToggle : undefined}
                    aria-expanded={expandable ? open : undefined}>
                <time>{clockTime(row.at)}</time>
                <span className={`lb-kind lb-k-${row.lane}`}>{row.kind.replace(/_/g, " ")}</span>
                <span className="lb-symbol">{row.symbol ?? "—"}</span>
                <span className="lb-headline">{head()}</span>
                {expandable ? <span className="lb-chev">{open ? "−" : "+"}</span> : null}
            </button>
            {open && expandable ? <DecisionBody d={p} /> : null}
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

    const load = useCallback(async (forDate) => {
        try {
            const { data } = await api.get("/internal/cockpit/logbook", {
                baseURL: "/", params: forDate ? { date: forDate, limit: 5000 } : { limit: 5000 },
            });
            setLog(data); setError(null);
        } catch (err) {
            setError(err.response?.status === 401
                ? "Sign in to read the logbook." : "Logbook unavailable.");
        }
    }, []);

    useEffect(() => { load(date); }, [load, date]);
    // The session is still being written while it runs.
    useEffect(() => {
        const t = setInterval(() => load(date), 20000);
        return () => clearInterval(t);
    }, [load, date]);

    const timeline = useMemo(() => buildTimeline(log), [log]);
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

    if (error) return <div className="lb-root lb-centered"><p>{error}</p></div>;
    if (!log) return <div className="lb-root lb-centered"><p className="lb-muted">
        reading the logbook…</p></div>;

    const s = log.summary;
    const calls = log.modelCalls ?? [];
    const failed = calls.filter((c) => c.status !== "ok").length;
    const tokens = calls.reduce((n, c) => n + (c.promptTokens ?? 0) + (c.completionTokens ?? 0), 0);
    const decided = log.decisions ?? [];
    const proposedBuys = decided.filter((d) => d.synthesis?.proposedAction === "BUY").length;
    const executed = decided.filter((d) => d.executed).length;

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
