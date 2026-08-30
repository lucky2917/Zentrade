import { clockTime, ratio, rupees, titleCase, severityClass, tierClass, UNKNOWN }
    from "./format.js";

// The main panel: the senior trader's reasoning, in the order it happened.
//
// Every block below renders a structured artifact the system already produces
// and already journals. None of it is hidden chain-of-thought — that is not
// exposed by the pipeline and is not available to render even if it were
// wanted. What is shown is the thesis, the evidence with its tiers, the
// challenge, the alternatives, the arithmetic and the decision.

const Block = ({ event, children, title, tone = "" }) => (
    <article className={`ck-block ${tone}`}>
        <div className="ck-block-head">
            <time className="ck-time">{clockTime(event.at)}</time>
            <span className="ck-block-title">{title}</span>
            {event.symbol ? <span className="ck-symbol">{event.symbol}</span> : null}
        </div>
        <div className="ck-block-body">{children}</div>
    </article>
);

const Field = ({ label, children }) => (
    <div className="ck-field">
        <span className="ck-field-label">{label}</span>
        <div className="ck-field-value">{children}</div>
    </div>
);

const Bullets = ({ items, empty = "none stated" }) => (
    items?.length
        ? <ul className="ck-bullets">{items.map((t, i) => <li key={i}>{t}</li>)}</ul>
        : <span className="ck-muted">{empty}</span>
);

const RENDERERS = {
    MARKET_OBSERVATION: (e) => (
        <Block event={e} title="MARKET OBSERVATION" tone="ck-quiet">
            <div className="ck-inline">
                <span>{e.observed ?? 0} symbols observed</span>
                <span>{e.positions ?? 0} held</span>
                <span>{e.eventsRaised ?? 0} events</span>
                <span>queue {e.queueDepth ?? 0}</span>
                {e.market?.breadth ? <span>breadth {e.market.breadth}</span> : null}
            </div>
        </Block>
    ),
    MARKET_EVENT: (e) => (
        <Block event={e}
               title={e.source === "FAST_PLANE" ? "FAST PLANE · MATERIAL CHANGE"
                                                : "MARKET CHANGE"}
               tone={`${severityClass(e.severity)}${e.source === "FAST_PLANE" ? " ck-plane" : ""}`}>
            <Field label="What">{titleCase(e.type)} · {e.severity ?? UNKNOWN}</Field>
            <Field label="Detail">{e.reason ?? UNKNOWN}</Field>
            {e.source === "FAST_PLANE" ? (
                <Field label="Detected by">
                    Go fast plane ({e.detector ?? "go_marketdata_v1"}) — deterministic,
                    on the tick, no model consulted
                </Field>
            ) : null}
        </Block>
    ),
    NEWS_EVENT: (e) => (
        <Block event={e} title="NEWS" tone={severityClass(e.severity)}>
            <Field label="Detail">{e.reason ?? UNKNOWN}</Field>
        </Block>
    ),
    MATERIALITY: (e) => (
        <Block event={e} title="MATERIALITY CHECK"
               tone={e.material ? "ck-material" : "ck-quiet"}>
            <Field label="Verdict">{e.verdict ?? UNKNOWN}</Field>
            <Field label="Why">{e.because ?? UNKNOWN}</Field>
        </Block>
    ),
    REASONING_STARTED: (e) => (
        <Block event={e} title="SENIOR TRADER AWAKENED" tone="ck-awaken">
            <Field label="Trigger">{titleCase(e.trigger)}</Field>
            <Field label="Because">{e.because ?? UNKNOWN}</Field>
            <Field label="Route">{e.route ?? UNKNOWN}</Field>
        </Block>
    ),
    WHAT_I_KNOW: (e) => (
        <Block event={e} title="WHAT DO I KNOW?">
            <div className="ck-evidence">
                {e.evidence?.length ? e.evidence.map((ev, i) => (
                    <div key={i} className={`ck-ev ${tierClass(ev.tier)}`}>
                        <span className="ck-ev-tier">{ev.tier}</span>
                        <span className="ck-ev-text">{ev.statement}</span>
                        {ev.value !== null && ev.value !== undefined
                            ? <span className="ck-ev-value">{String(ev.value)}</span> : null}
                    </div>
                )) : <span className="ck-muted">no deterministic evidence available</span>}
            </div>
            <div className="ck-inline">
                <span>regime {e.regime ?? UNKNOWN}</span>
                <span>phase {e.sessionPhase ?? UNKNOWN}</span>
                <span>breadth {e.breadth ?? UNKNOWN}</span>
                {e.dataStale ? <span className="ck-bad">DATA STALE</span> : null}
            </div>
            {e.memory?.summary
                ? <Field label="Memory">{e.memory.summary}</Field> : null}
            {e.originalThesis ? (
                <Field label="Original thesis (immutable)">
                    {e.originalThesis.rationale ?? UNKNOWN}
                </Field>
            ) : null}
        </Block>
    ),
    THESIS_FORMED: (e) => (
        <Block event={e} title="INITIAL THESIS">
            <Field label="Thesis">{e.thesis ?? UNKNOWN}</Field>
            <Field label="Setup">{e.setup ?? UNKNOWN}</Field>
            <Field label="Supporting"><Bullets items={e.supportingEvidence} /></Field>
            <Field label="Contradicting"><Bullets items={e.contradictingEvidence} /></Field>
            <Field label="Would invalidate"><Bullets items={e.invalidationConditions} /></Field>
            <Field label="Known uncertainty"><Bullets items={e.uncertainty} /></Field>
        </Block>
    ),
    THESIS_CHALLENGED: (e) => (
        <Block event={e} title="CHALLENGING THE THESIS" tone="ck-challenge">
            <Field label="Verdict">{titleCase(e.verdict)}</Field>
            <Field label="Strongest objection">{e.strongestObjection ?? UNKNOWN}</Field>
            <Field label="Counter-thesis">{e.counterThesis ?? UNKNOWN}</Field>
            {e.downgraded ? <Field label="Effect">confidence downgraded</Field> : null}
        </Block>
    ),
    ALTERNATIVES: (e) => (
        <Block event={e} title="ALTERNATIVE EXPLANATIONS">
            <Bullets items={e.alternatives} />
        </Block>
    ),
    WHAT_WOULD_CHANGE_MY_MIND: (e) => (
        <Block event={e} title="WHAT WOULD CHANGE MY MIND?">
            <Bullets items={e.conditions} />
        </Block>
    ),
    SYNTHESIS: (e) => (
        <Block event={e} title="DETERMINISTIC SYNTHESIS" tone="ck-synthesis">
            <div className="ck-grid">
                <Field label="R:R">{ratio(e.riskReward?.ratio)}</Field>
                <Field label="Edge">{e.edge?.verdict ?? UNKNOWN}</Field>
                <Field label="Cost hurdle">{e.costHurdleBps} bps</Field>
                <Field label="Expected value">
                    {e.expectedValue?.verdict ?? ratio(e.expectedValue?.value)}
                </Field>
                <Field label="Opportunity cost">
                    {e.opportunityCost?.verdict ?? UNKNOWN}
                </Field>
                <Field label="Thesis age">{e.thesisAge?.label ?? UNKNOWN}</Field>
            </div>
            <Field label="Deterministic checks"><Bullets items={e.reasons} /></Field>
        </Block>
    ),
    DECISION: (e) => (
        <Block event={e} title="DECISION" tone={`ck-decision ck-act-${e.action}`}>
            <div className="ck-decision-line">
                <span className="ck-action">{e.action ?? UNKNOWN}</span>
                <span className="ck-conf">confidence {e.confidence ?? UNKNOWN}</span>
                {e.quantity ? <span>{e.quantity} sh</span> : null}
                {e.fallback ? <span className="ck-bad">SAFE FALLBACK</span> : null}
            </div>
            <Field label="Confidence basis"><Bullets items={e.confidenceBasis} /></Field>
            {e.whatChanged ? <Field label="What changed">{e.whatChanged}</Field> : null}
        </Block>
    ),
    REVALIDATION: (e) => (
        <Block event={e} title="FRESH-WORLD REVALIDATION"
               tone={e.verdict === "REJECT" ? "ck-reject" : ""}>
            <Field label="Verdict">{e.verdict ?? UNKNOWN}</Field>
            {e.reason ? <Field label="Reason">{e.reason}</Field> : null}
            <div className="ck-inline">
                <span>decision price {rupees(e.decisionPricePaise)}</span>
                <span>world price {rupees(e.worldPricePaise)}</span>
                <span>data age {e.priceAgeMs ?? UNKNOWN} ms</span>
            </div>
        </Block>
    ),
    RISK_DECISION: (e) => (
        <Block event={e} title="RISK GATE"
               tone={e.decision === "ALLOW" ? "ck-allow" : "ck-reject"}>
            <Field label="Verdict">{e.decision ?? UNKNOWN}</Field>
            <Field label="Reason">{e.reason ?? e.code ?? UNKNOWN}</Field>
        </Block>
    ),
    ORDER_STATE_CHANGED: (e) => (
        <Block event={e} title="ORDER" tone="ck-order">
            <div className="ck-inline">
                <span className="ck-action">{e.side ?? UNKNOWN}</span>
                <span>{e.quantity ?? UNKNOWN} sh</span>
                <span>{rupees(e.pricePaise)}</span>
                <span className="ck-state">{e.state ?? UNKNOWN}</span>
                {e.duplicate ? <span className="ck-muted">idempotent repeat</span> : null}
            </div>
        </Block>
    ),
    FILL: (e) => (
        <Block event={e} title="FILL" tone="ck-fill">
            <div className="ck-inline">
                <span>{e.filledQuantity ?? UNKNOWN} of {e.quantity ?? UNKNOWN}</span>
                <span>{rupees(e.pricePaise)}</span>
                <span className="ck-state">{e.state ?? UNKNOWN}</span>
                {e.pnlPaise !== null && e.pnlPaise !== undefined
                    ? <span>P&L {rupees(e.pnlPaise)}</span> : null}
            </div>
        </Block>
    ),
    PROTECTIVE_EVENT: (e) => (
        <Block event={e} title="PROTECTIVE ACTION" tone="ck-protective">
            <Field label="Crossed">{titleCase(e.crossing)} at {rupees(e.pricePaise)}</Field>
            <Field label="Level">{rupees(e.levelPaise)}</Field>
            <Field label="Why">{e.because ?? UNKNOWN}</Field>
            <Field label="Model consulted">no — the thesis pre-committed to this</Field>
        </Block>
    ),
    REASSESSMENT: (e) => (
        <Block event={e} title="REASSESSMENT" tone="ck-reassess">
            <Field label="Action">{e.action ?? UNKNOWN}</Field>
            <Field label="Thesis still valid">
                {e.thesisStillValid === null || e.thesisStillValid === undefined
                    ? UNKNOWN : e.thesisStillValid ? "yes" : "no"}
            </Field>
            <Field label="What changed">{e.whatChanged ?? UNKNOWN}</Field>
        </Block>
    ),
    STALE_DATA: (e) => (
        <Block event={e} title="FEED WENT QUIET" tone="ck-reject">
            <Field label="Symbols">{(e.symbols ?? []).join(", ") || UNKNOWN}</Field>
            <Field label="Armed positions affected">{e.armed ?? 0}</Field>
            <Field label="Action">none — the system does not trade on absent data</Field>
        </Block>
    ),
    RECOVERY: (e) => (
        <Block event={e} title="RUNTIME READY" tone="ck-quiet">
            <div className="ck-inline">
                <span>session {e.session ?? UNKNOWN}</span>
                <span>{e.armedPositions ?? 0} of {e.positions ?? 0} positions armed</span>
                <span>fast plane {e.fastPlane ?? "off"}</span>
            </div>
        </Block>
    ),
    ERROR: (e) => (
        <Block event={e} title="ERROR" tone="ck-reject">
            <Field label="Detail">{e.message ?? e.reason ?? UNKNOWN}</Field>
        </Block>
    ),
    REASONING_FINISHED: (e) => (
        <Block event={e} title="RETURNING TO OBSERVATION" tone="ck-quiet">
            <div className="ck-inline">
                <span>{e.action ?? UNKNOWN}</span>
                <span>{e.executed ? "executed" : "no order"}</span>
            </div>
        </Block>
    ),
};

export const ReasoningStream = ({ events, showObservations }) => {
    const visible = events.filter((e) => {
        if (!RENDERERS[e.kind]) return false;
        if (!showObservations && e.kind === "MARKET_OBSERVATION") return false;
        return true;
    });

    if (!visible.length) {
        return (
            <div className="ck-empty">
                <p>No reasoning yet this session.</p>
                <p className="ck-muted">
                    The stream fills when the market does something the system
                    judges material. A quiet screen is a quiet market, not a
                    disconnected one.
                </p>
            </div>
        );
    }

    return (
        <div className="ck-stream">
            {visible.map((e) => (
                <div key={e.seq}>{RENDERERS[e.kind](e)}</div>
            ))}
        </div>
    );
};

export default ReasoningStream;
