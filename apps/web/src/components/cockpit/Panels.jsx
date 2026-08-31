import { useEffect, useState } from "react";
import api from "../../services/api.js";
import { clockTime, duration, percent, rupees, signedRupees, ratio, isKnown,
         titleCase, severityClass, UNKNOWN } from "./format.js";

// ---- current thought -------------------------------------------------------

export const CurrentThought = ({ narration }) => {
    const thought = narration?.currentThought;
    if (!thought) {
        return (
            <section className="ck-panel">
                <h2>Senior trader</h2>
                <div className="ck-idle">
                    <span className="ck-idle-dot" />
                    {narration?.brain === "MONITORING"
                        ? "Monitoring open positions"
                        : "Observing — not reasoning"}
                </div>
            </section>
        );
    }

    const stage = (kind) => thought.stages.find((s) => s.kind === kind) ?? null;
    const formed = stage("THESIS_FORMED");
    const challenged = stage("THESIS_CHALLENGED");
    const changeMind = stage("WHAT_WOULD_CHANGE_MY_MIND");
    const decision = stage("DECISION");

    return (
        <section className="ck-panel ck-panel-active">
            <h2>Senior trader · thinking</h2>
            <div className="ck-thought">
                <div className="ck-thought-head">
                    <span className="ck-symbol">{thought.symbol ?? UNKNOWN}</span>
                    <span className="ck-muted">{titleCase(thought.trigger)}</span>
                </div>
                <dl>
                    <dt>Thinking about</dt>
                    <dd>{formed?.setup ?? formed?.thesis ?? "forming a view"}</dd>
                    <dt>Thesis</dt>
                    <dd>{formed?.thesis ?? UNKNOWN}</dd>
                    <dt>Challenge</dt>
                    <dd>{challenged?.strongestObjection ?? UNKNOWN}</dd>
                    <dt>Counter-thesis</dt>
                    <dd>{challenged?.counterThesis ?? UNKNOWN}</dd>
                    <dt>What could invalidate this</dt>
                    <dd>{(changeMind?.conditions ?? []).join("; ")
                        || formed?.invalidationConditions?.join("; ") || UNKNOWN}</dd>
                    <dt>Confidence basis</dt>
                    <dd>{(decision?.confidenceBasis ?? []).join("; ")
                        || "INSUFFICIENT BASIS"}</dd>
                    <dt>Decision</dt>
                    <dd>{decision?.action ?? "pending"}</dd>
                </dl>
            </div>
        </section>
    );
};

// ---- market world ----------------------------------------------------------

export const MarketWorld = ({ world }) => {
    if (!world) return <section className="ck-panel"><h2>World</h2>
        <p className="ck-muted">{UNKNOWN}</p></section>;

    const symbols = (world.symbols ?? [])
        .filter((s) => Number.isFinite(s.price))
        .sort((a, b) => Math.abs(b.vwapDistance ?? 0) - Math.abs(a.vwapDistance ?? 0))
        .slice(0, 12);

    return (
        <section className="ck-panel">
            <h2>Live world</h2>
            <div className="ck-world-head">
                <span>session <b>{world.session ?? UNKNOWN}</b></span>
                <span>regime <b>{world.market?.regime ?? UNKNOWN}</b></span>
                <span>breadth <b>{world.market?.breadth ?? UNKNOWN}</b></span>
                <span>median move <b>{percent(world.market?.medianAbsMove
                    ? world.market.medianAbsMove * 100 : null)}</b></span>
                <span>observed <b>{world.symbols?.length ?? 0}</b></span>
            </div>
            {symbols.length ? (
                <table className="ck-table">
                    <thead><tr>
                        <th>Symbol</th><th>Price</th><th>VWAP</th>
                        <th>VWAP dist</th><th>MTF</th><th>Bars</th>
                    </tr></thead>
                    <tbody>
                        {symbols.map((s) => (
                            <tr key={s.symbol}>
                                <td className="ck-symbol">{s.symbol}</td>
                                <td>{s.price?.toFixed(2) ?? UNKNOWN}</td>
                                <td>{s.vwapAvailable ? s.vwap?.toFixed(2) : UNKNOWN}</td>
                                <td className={(s.vwapDistance ?? 0) >= 0 ? "ck-up" : "ck-down"}>
                                    {percent(s.vwapDistance !== null && s.vwapDistance !== undefined
                                        ? s.vwapDistance * 100 : null)}
                                </td>
                                <td>{s.mtf?.aligned ? "aligned" : s.mtf ? "mixed" : UNKNOWN}</td>
                                <td className="ck-muted">
                                    {s.barsSeen ? `${s.barsSeen.m1}/${s.barsSeen.m5}/${s.barsSeen.m15}` : UNKNOWN}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            ) : <p className="ck-muted">
                No observation pass has completed yet this session.
            </p>}
        </section>
    );
};

// ---- positions -------------------------------------------------------------

const Timeline = ({ symbol, onClose }) => {
    const [data, setData] = useState(null);
    const [error, setError] = useState(null);

    useEffect(() => {
        let cancelled = false;
        api.get(`/internal/cockpit/position/${encodeURIComponent(symbol)}`, { baseURL: "/" })
            .then(({ data: body }) => { if (!cancelled) setData(body); })
            .catch(() => { if (!cancelled) setError("No open thesis for this position."); });
        return () => { cancelled = true; };
    }, [symbol]);

    return (
        <div className="ck-modal" role="dialog" aria-label={`${symbol} timeline`}>
            <div className="ck-modal-body">
                <div className="ck-modal-head">
                    <h3>{symbol} · how the belief evolved</h3>
                    <button type="button" onClick={onClose}>close</button>
                </div>
                {error ? <p className="ck-muted">{error}</p> : null}
                {!data && !error ? <p className="ck-muted">loading…</p> : null}
                {data ? (
                    <div className="ck-timeline">
                        <div className="ck-tl-item ck-tl-entry">
                            <time>{clockTime(data.originalThesis.openedAt)}</time>
                            <div>
                                <strong>ENTRY · ORIGINAL THESIS (immutable)</strong>
                                <p>{data.originalThesis.rationale ?? UNKNOWN}</p>
                                <p className="ck-muted">
                                    setup {data.originalThesis.setupType ?? UNKNOWN} ·
                                    stop {rupees(data.originalThesis.stopPaise)} ·
                                    target {rupees(data.originalThesis.targetPaise)}
                                </p>
                                {data.originalThesis.invalidationConditions?.length ? (
                                    <p className="ck-muted">
                                        invalidated by: {data.originalThesis.invalidationConditions.join("; ")}
                                    </p>
                                ) : null}
                            </div>
                        </div>
                        {data.reassessments.map((r) => (
                            <div key={r.id} className="ck-tl-item">
                                <time>{clockTime(r.at)}</time>
                                <div>
                                    <strong>
                                        {r.trigger ? titleCase(r.trigger.type) : "REASSESSMENT"}
                                        {" · "}{r.action}
                                        {r.executed ? " · executed" : ""}
                                    </strong>
                                    <p>{r.whatChanged ?? UNKNOWN}</p>
                                    <p className="ck-muted">
                                        thesis still valid: {r.thesisStillValid === null
                                            ? UNKNOWN : r.thesisStillValid ? "yes" : "no"}
                                        {r.riskDecision ? ` · risk ${r.riskDecision}` : ""}
                                    </p>
                                </div>
                            </div>
                        ))}
                        {!data.reassessments.length ? (
                            <p className="ck-muted">
                                No reassessment yet — nothing material has happened since entry.
                            </p>
                        ) : null}
                    </div>
                ) : null}
            </div>
        </div>
    );
};

// ---- the persistent account ------------------------------------------------
//
// One continuous paper account. It was opened once, and every figure here was
// read back from the database, not accumulated in this process: what is on the
// screen is what survives a restart.

// A figure the account does not have is not coloured as a gain: UNKNOWN in
// green reads as good news, which is the one thing it never is.
const moneyClass = (paise, signed) => {
    if (!signed || !isKnown(paise)) return "ck-money-value";
    return Number(paise) >= 0 ? "ck-money-value ck-up" : "ck-money-value ck-down";
};

const Money = ({ label, paise, signed = false, hint = null }) => (
    <div className="ck-money">
        <span className="ck-money-label">{label}</span>
        <span className={moneyClass(paise, signed)}>
            {signed ? signedRupees(paise) : rupees(paise)}
        </span>
        {hint ? <span className="ck-money-hint">{hint}</span> : null}
    </div>
);

export const Account = ({ account }) => {
    if (!account) {
        return <section className="ck-panel"><h2>Account</h2>
            <p className="ck-muted">Account state {UNKNOWN}.</p></section>;
    }

    const day = account.sessions?.[0] ?? null;
    const failed = account.reconciliation?.checks?.filter((c) => !c.ok) ?? [];

    return (
        <section className="ck-panel">
            <h2>Account <span className="ck-muted">· paper · persistent</span></h2>
            <div className="ck-money-grid">
                <Money label="Equity" paise={account.equityPaise}
                       hint={account.fullyPriced ? null : "some positions unpriced"} />
                <Money label="Cash" paise={account.cashPaise} />
                <Money label="Realised P&L" paise={account.realisedPnlPaise} signed
                       hint={account.openingAdjustmentPaise
                           ? `${signedRupees(account.openingAdjustmentPaise)} realised before this record`
                           : null} />
                <Money label="Unrealised P&L" paise={account.unrealisedPnlPaise} signed />
                <Money label="Since opening" paise={account.totalPnlPaise} signed
                       hint={`from ${rupees(account.startingCapitalPaise)}`} />
                <Money label="Costs paid" paise={account.costsPaise} />
            </div>

            <dl className="ck-account-meta">
                <dt>Committed to positions</dt>
                <dd>{rupees(account.marginUsedPaise)} · {account.positions?.length ?? 0} open</dd>
                <dt>Opened</dt>
                <dd>{account.openedAt ? new Date(account.openedAt).toLocaleDateString("en-IN")
                                      : UNKNOWN}</dd>
                {day ? (<>
                    <dt>Today</dt>
                    <dd>
                        opened {rupees(day.opening_cash_paise)} ·
                        {" "}{day.orders_placed} order(s) ·
                        {" "}{day.decisions_made} decision(s)
                    </dd>
                </>) : null}
            </dl>

            {failed.length ? (
                <p className="ck-bad">
                    DID NOT RECONCILE: {failed.map((c) => c.name).join(", ")}
                    {account.reconciliation.driftPaise
                        ? ` · drift ${signedRupees(account.reconciliation.driftPaise)}` : ""}
                </p>
            ) : (
                <p className="ck-muted ck-reconciled">
                    Reconciled: cash equals starting capital plus realised P&L, less costs
                    and margin committed.
                </p>
            )}

            {account.sessions?.length > 1 ? (
                <ol className="ck-sessions">
                    {account.sessions.slice(0, 8).map((sn) => (
                        <li key={sn.session_date}>
                            <time>{String(sn.session_date).slice(0, 10)}</time>
                            <span>{rupees(sn.closing_cash_paise)}</span>
                            <span className={Number(sn.realised_pnl_paise) >= 0
                                             ? "ck-up" : "ck-down"}>
                                {signedRupees(sn.realised_pnl_paise)}
                            </span>
                        </li>
                    ))}
                </ol>
            ) : null}
        </section>
    );
};

// ---- the decision record ---------------------------------------------------
//
// Every decision, including the ones that produced no trade. Read from the
// database on demand, which is why it is still here after a restart.

export const DecisionHistory = () => {
    const [decisions, setDecisions] = useState(null);
    const [error, setError] = useState(null);
    const [openId, setOpenId] = useState(null);

    useEffect(() => {
        let cancelled = false;
        api.get("/internal/cockpit/decisions?limit=40", { baseURL: "/" })
            .then(({ data }) => { if (!cancelled) setDecisions(data.decisions ?? []); })
            .catch(() => { if (!cancelled) setError("Decision history unavailable."); });
        return () => { cancelled = true; };
    }, []);

    if (error) return <section className="ck-panel"><h2>Decision record</h2>
        <p className="ck-muted">{error}</p></section>;
    if (!decisions) return <section className="ck-panel"><h2>Decision record</h2>
        <p className="ck-muted">loading…</p></section>;
    if (!decisions.length) return <section className="ck-panel"><h2>Decision record</h2>
        <p className="ck-muted">No decision has been recorded yet.</p></section>;

    const open = decisions.find((d) => d.id === openId) ?? null;

    return (
        <section className="ck-panel">
            <h2>Decision record <span className="ck-muted">({decisions.length})</span></h2>
            <ul className="ck-decisions">
                {decisions.map((d) => (
                    <li key={d.id}>
                        <button type="button" onClick={() => setOpenId(d.id)}>
                            <time>{clockTime(d.decidedAt)}</time>
                            <span className="ck-symbol">{d.symbol}</span>
                            <span>{d.action}</span>
                            <span className={d.executed ? "ck-up" : "ck-muted"}>
                                {d.executed ? "traded" : (d.blockedReason ? "blocked" : "no trade")}
                            </span>
                        </button>
                    </li>
                ))}
            </ul>
            {open ? (
                <div className="ck-modal" role="dialog"
                     aria-label={`${open.symbol} decision`}>
                    <div className="ck-modal-body">
                        <div className="ck-modal-head">
                            <h3>{open.symbol} · {open.action} · {clockTime(open.decidedAt)}</h3>
                            <button type="button" onClick={() => setOpenId(null)}>close</button>
                        </div>
                        <dl className="ck-decision">
                            <dt>Triggered by</dt>
                            <dd>{open.trigger
                                ? `${titleCase(open.trigger.type)}${open.trigger.reason
                                    ? ` — ${open.trigger.reason}` : ""}`
                                : UNKNOWN}</dd>
                            <dt>Thesis</dt>
                            <dd>{open.thesis ?? UNKNOWN}</dd>
                            <dt>Supporting</dt>
                            <dd>{open.supporting?.join("; ") || UNKNOWN}</dd>
                            <dt>Contradicting</dt>
                            <dd>{open.contradicting?.join("; ") || UNKNOWN}</dd>
                            <dt>Challenge</dt>
                            <dd>{open.challengeVerdict ?? UNKNOWN}
                                {open.counterThesis ? ` — ${open.counterThesis}` : ""}</dd>
                            <dt>Alternatives considered</dt>
                            <dd>{open.alternatives?.join("; ") || UNKNOWN}</dd>
                            <dt>What would change its mind</dt>
                            <dd>{open.whatWouldChange?.join("; ") || UNKNOWN}</dd>
                            <dt>Evidence</dt>
                            <dd>
                                {open.evidence?.length ? (
                                    <ul className="ck-evidence">
                                        {open.evidence.map((e, i) => (
                                            <li key={i}>
                                                <span className="ck-muted">{e.tier}</span>
                                                {" "}{e.statement}
                                            </li>
                                        ))}
                                    </ul>
                                ) : UNKNOWN}
                            </dd>
                            <dt>Risk gate</dt>
                            <dd>{open.risk
                                ? `${open.risk.decision}${open.risk.code
                                    ? ` (${open.risk.code})` : ""}`
                                : "not reached"}</dd>
                            <dt>Outcome</dt>
                            <dd>{open.executed
                                ? `executed ${open.quantity ?? UNKNOWN} at ${rupees(open.pricePaise)}`
                                : (open.blockedReason ?? "no order")}</dd>
                        </dl>
                    </div>
                </div>
            ) : null}
        </section>
    );
};

export const Positions = ({ positions }) => {
    const [open, setOpen] = useState(null);

    if (!positions?.length) {
        return <section className="ck-panel"><h2>Positions</h2>
            <p className="ck-muted">Flat. No open positions.</p></section>;
    }

    return (
        <section className="ck-panel">
            <h2>Positions <span className="ck-muted">({positions.length})</span></h2>
            <div className="ck-positions">
                {positions.map((p) => (
                    <button type="button" key={p.symbol} className="ck-position"
                            onClick={() => setOpen(p.symbol)}>
                        <div className="ck-pos-head">
                            <span className="ck-symbol">{p.symbol}</span>
                            <span className={p.unrealisedPnlPaise >= 0 ? "ck-up" : "ck-down"}>
                                {signedRupees(p.unrealisedPnlPaise)}
                            </span>
                        </div>
                        <div className="ck-pos-grid">
                            <span>qty {p.quantity ?? UNKNOWN}</span>
                            <span>entry {rupees(p.entryPricePaise)}</span>
                            <span>now {rupees(p.currentPricePaise)}</span>
                            <span>held {duration(p.holdingSeconds)}</span>
                            <span>stop {ratio(p.stopDistance)}</span>
                            <span>target {ratio(p.targetDistance)}</span>
                        </div>
                        {p.stale ? <span className="ck-bad">DATA STALE</span> : null}
                        {!p.hasThesis ? (
                            <span className="ck-bad">
                                NO THESIS — cannot be reassessed or protected
                            </span>
                        ) : null}
                        <span className="ck-muted ck-pos-hint">click for the timeline</span>
                    </button>
                ))}
            </div>
            {open ? <Timeline symbol={open} onClose={() => setOpen(null)} /> : null}
        </section>
    );
};

// ---- orders ----------------------------------------------------------------

const LIFECYCLE = ["NEW", "ACCEPTED", "WORKING", "PARTIALLY_FILLED", "FILLED"];

export const OrderLifecycle = ({ openOrders, todaysOrders }) => {
    const orders = [...(openOrders ?? [])];
    const seen = new Set(orders.map((o) => o.id));
    for (const o of todaysOrders ?? []) if (!seen.has(o.id)) orders.push(o);

    if (!orders.length) {
        return <section className="ck-panel"><h2>Orders</h2>
            <p className="ck-muted">No orders today.</p></section>;
    }

    return (
        <section className="ck-panel">
            <h2>Order lifecycle</h2>
            <div className="ck-orders">
                {orders.slice(0, 12).map((o) => {
                    const reached = LIFECYCLE.indexOf(o.state);
                    const terminal = !LIFECYCLE.includes(o.state);
                    return (
                        <div key={o.id} className="ck-order">
                            <div className="ck-order-head">
                                <span className="ck-symbol">{o.symbol}</span>
                                <span className="ck-action">{o.side}</span>
                                <span>{o.filledQuantity ?? 0}/{o.quantity} sh</span>
                                <span>{rupees(o.pricePaise)}</span>
                                <span className={`ck-state ${terminal ? "ck-state-terminal" : ""}`}>
                                    {o.state}
                                </span>
                            </div>
                            {terminal ? (
                                <p className="ck-muted">
                                    terminal state — {o.state.toLowerCase()}
                                </p>
                            ) : (
                                <ol className="ck-lifecycle">
                                    {LIFECYCLE.map((state, i) => (
                                        <li key={state}
                                            className={i <= reached ? "ck-reached" : ""}>
                                            {state}
                                        </li>
                                    ))}
                                </ol>
                            )}
                        </div>
                    );
                })}
            </div>
        </section>
    );
};

// ---- event stream ----------------------------------------------------------

const FILTERS = ["ALL", "MARKET", "REASONING", "TRADES", "POSITIONS", "RISK", "SYSTEM"];

export const EventStream = ({ events }) => {
    const [filter, setFilter] = useState("ALL");
    const shown = (filter === "ALL" ? events : events.filter((e) => e.category === filter))
        .slice(-120).reverse();

    return (
        <section className="ck-panel">
            <h2>Event stream</h2>
            <div className="ck-filters">
                {FILTERS.map((f) => (
                    <button type="button" key={f}
                            className={f === filter ? "ck-filter ck-filter-on" : "ck-filter"}
                            onClick={() => setFilter(f)}>{f}</button>
                ))}
            </div>
            <ol className="ck-eventlist">
                {shown.map((e) => (
                    <li key={e.seq} className={severityClass(e.severity)}>
                        <time>{clockTime(e.at)}</time>
                        <span className="ck-ev-kind">{titleCase(e.kind)}</span>
                        {e.symbol ? <span className="ck-symbol">{e.symbol}</span> : null}
                        <span className="ck-muted">
                            {e.reason ?? e.verdict ?? e.action ?? e.state ?? ""}
                        </span>
                    </li>
                ))}
                {!shown.length ? <li className="ck-muted">nothing in this category yet</li> : null}
            </ol>
        </section>
    );
};

// ---- system health ---------------------------------------------------------

const statusOf = (ok, degraded) => (ok ? "healthy" : degraded ? "degraded" : "failed");

// A plane that is ON and not answering is not the same as a plane that is off.
// Reporting both as "off" would hide the one that matters.
// Tokens are the binding constraint, not requests: a day's allowance buys tens
// of decisions, so the operator needs to see it draining.
const modelDetail = (runtime) => {
    const m = runtime?.model;
    if (!m) return UNKNOWN;
    if (m.exhausted) return `budget exhausted — retries in ${m.resumesInSeconds}s`;
    const t = m.tokens;
    if (!t) return `${m.rpm}/min · ${m.queued} queued`;
    const pct = Math.round(t.fractionRemaining * 100);
    const reserved = t.discoveryPermitted
        ? "" : " · discovery paused, reserve held for open positions";
    return `${t.used.toLocaleString()}/${t.budget.toLocaleString()} tokens `
        + `(${pct}% left)${reserved}`;
};

const planeStatus = (runtime, plane) => {
    if (!runtime) return "failed";
    const mode = runtime?.fastPlane?.mode;
    if (!mode || mode === "off") return "off";
    if (!plane?.alive) return "failed";
    if (runtime.fastPlane.divergence) return "degraded";
    if (!runtime.fastPlane.listening) return "degraded";
    return "healthy";
};

const planeDetail = (runtime, plane) => {
    if (!runtime) return "the trader is not running";
    const mode = runtime?.fastPlane?.mode;
    if (!mode || mode === "off") return "off — the Node reflex is protecting";
    if (!plane?.alive) return plane?.reason ?? "no heartbeat";
    const ticks = plane.plane?.ticksIngested ?? UNKNOWN;
    return `${mode} · ${ticks} ticks · divergence ${runtime.fastPlane.divergence ?? 0}`;
};

export const SystemHealth = ({ snapshot }) => {
    const health = snapshot?.health;
    const runtime = snapshot?.runtime;
    if (!health) return <section className="ck-panel"><h2>System</h2>
        <p className="ck-muted">{UNKNOWN}</p></section>;

    const deps = health.boot?.dependencies ?? {};
    const conn = health.connection ?? {};
    const running = snapshot?.agentRunning !== false;
    const rows = [
        ["Fyers feed", conn.state === "CONNECTED"
            ? (conn.trusted ? "healthy" : "stale") : "failed", conn.state ?? UNKNOWN],
        ["Postgres", statusOf(deps.database, false), deps.database ? "connected" : "unreachable"],
        ["Redis", statusOf(deps.redis, false), deps.redis ? "connected" : "unreachable"],
        ["Go fast plane", planeStatus(runtime, snapshot?.fastPlane),
            planeDetail(runtime, snapshot?.fastPlane)],
        ["Autonomous trader", running ? "healthy" : "failed",
            running ? `${runtime?.orchestrator?.phase ?? UNKNOWN} · pid ${runtime?.pid ?? UNKNOWN}`
                    : (snapshot?.agentReason ?? "not running")],
        ["Scheduler", running && runtime?.orchestrator?.scheduler?.healthy
            ? "healthy" : running ? "degraded" : "failed",
            `${runtime?.orchestrator?.scheduler?.jobCount ?? 0} jobs`],
        ["Queue", running ? "healthy" : "failed",
            `depth ${runtime?.orchestrator?.queue?.depth ?? 0}`],
        ["Risk", health.newExposurePermitted ? "healthy" : "degraded",
            health.exposureBlockedBecause ?? "new exposure permitted"],
        ["Reasoning model", running
            ? (runtime?.model?.exhausted ? "failed"
                : runtime?.model?.tokens && !runtime.model.tokens.discoveryPermitted
                    ? "degraded" : "healthy")
            : "failed",
            modelDetail(runtime)],
        ["Reflex lane", running && runtime?.reflex ? "healthy" : "failed",
            runtime?.reflex ? `${runtime.reflex.armedSymbols ?? 0} armed` : UNKNOWN],
    ];

    return (
        <section className="ck-panel">
            <h2>System health</h2>
            <table className="ck-table ck-health">
                <tbody>
                    {rows.map(([name, status, detail]) => (
                        <tr key={name}>
                            <td>{name}</td>
                            <td><span className={`ck-dot ck-dot-${status}`} />{status}</td>
                            <td className="ck-muted">{detail}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
            <p className="ck-muted ck-asof">as of {clockTime(snapshot.at)} IST</p>
        </section>
    );
};

// ---- decision cards --------------------------------------------------------

export const DecisionCards = ({ cards }) => {
    if (!cards?.length) {
        return <section className="ck-panel"><h2>Decision cards</h2>
            <p className="ck-muted">No autonomous trade has been made yet.</p></section>;
    }
    return (
        <section className="ck-panel">
            <h2>Decision cards</h2>
            {cards.map((c, i) => (
                <article key={`${c.symbol}-${c.seq ?? i}`} className="ck-card">
                    <div className="ck-card-head">
                        <span className="ck-symbol">{c.symbol}</span>
                        <span className="ck-action">{c.action}</span>
                        <span>{c.quantity ?? UNKNOWN} sh</span>
                        <span>{rupees(c.pricePaise)}</span>
                        <time>{clockTime(c.at)}</time>
                    </div>
                    <dl>
                        <dt>Trigger</dt><dd>{titleCase(c.trigger)}</dd>
                        <dt>Thesis</dt><dd>{c.thesis ?? UNKNOWN}</dd>
                        <dt>Counter-thesis</dt><dd>{c.counterThesis ?? UNKNOWN}</dd>
                        <dt>Supporting</dt><dd>{c.supportingEvidence?.join("; ") || UNKNOWN}</dd>
                        <dt>Contradicting</dt><dd>{c.contradictingEvidence?.join("; ") || UNKNOWN}</dd>
                        <dt>R:R</dt><dd>{ratio(c.riskReward?.ratio)}</dd>
                        <dt>Cost hurdle</dt><dd>{c.costHurdleBps} bps</dd>
                        <dt>Opportunity cost</dt><dd>{c.opportunityCost?.verdict ?? UNKNOWN}</dd>
                        <dt>Risk</dt><dd>{c.riskDecision ?? UNKNOWN} · {c.riskReason ?? ""}</dd>
                        <dt>Order</dt><dd>{c.orderState ?? UNKNOWN}</dd>
                    </dl>
                </article>
            ))}
        </section>
    );
};
