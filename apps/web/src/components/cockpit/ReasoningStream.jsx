import { clockTime, ratio, rupees, signedRupees, text, titleCase, severityClass,
         tierClass, UNKNOWN } from "./format.js";

// The main panel: the senior trader's reasoning, in the order it happened.
//
// Every block below renders a structured artifact the system already produces
// and already journals. None of it is hidden chain-of-thought — that is not
// exposed by the pipeline and is not available to render even if it were
// wanted. What is shown is the thesis, the evidence with its tiers, the
// challenge, the alternatives, the arithmetic and the decision.

// What phase of the trader's life a block belongs to.
//
// The stream is one timeline covering seven different kinds of moment, and
// without this an ORDER and an OBSERVATION are the same grey paragraph. The
// chip is the fastest read on the screen: where in the cycle are we.
const STAGE = {
    OBSERVE: { label: "OBSERVING", cls: "ck-stage-observe" },
    THINK: { label: "THINKING", cls: "ck-stage-think" },
    DECIDE: { label: "DECISION", cls: "ck-stage-decide" },
    RISK: { label: "RISK", cls: "ck-stage-risk" },
    ORDER: { label: "ORDER", cls: "ck-stage-order" },
    FILL: { label: "FILLED", cls: "ck-stage-fill" },
    POSITION: { label: "POSITION", cls: "ck-stage-position" },
    PROTECT: { label: "PROTECT", cls: "ck-stage-protect" },
    SYSTEM: { label: "SYSTEM", cls: "ck-stage-system" },
};

const Block = ({ event, children, title, tone = "", stage = STAGE.SYSTEM }) => (
    <article className={`ck-block ${tone}`}>
        <div className="ck-block-head">
            <time className="ck-time">{clockTime(event.at)}</time>
            <span className={`ck-stage ${stage.cls}`}>{stage.label}</span>
            <span className="ck-block-title">{title}</span>
            {event.symbol ? <span className="ck-symbol">{event.symbol}</span> : null}
        </div>
        <div className="ck-block-body">{children}</div>
    </article>
);

// Every value that reaches the DOM goes through `text` first. These payloads
// come from model responses, and a shape that drifts by one level throws in
// React rather than printing badly.
const Field = ({ label, children, value }) => (
    <div className="ck-field">
        <span className="ck-field-label">{label}</span>
        <div className="ck-field-value">
            {value === undefined ? children : text(value)}
        </div>
    </div>
);

const Bullets = ({ items, empty = "none stated" }) => {
    const lines = (Array.isArray(items) ? items : items ? [items] : [])
        .map((t) => text(t, "")).filter(Boolean);
    return lines.length
        ? <ul className="ck-bullets">{lines.map((t, i) => <li key={i}>{t}</li>)}</ul>
        : <span className="ck-muted">{empty}</span>;
};

const RENDERERS = {
    MARKET_OBSERVATION: (e) => (
        <Block event={e} title="MARKET OBSERVATION" tone="ck-quiet" stage={STAGE.OBSERVE}>
            <div className="ck-inline">
                <span>{e.observed ?? 0} symbols observed</span>
                <span>{e.positions ?? 0} held</span>
                <span>{e.eventsRaised ?? 0} events</span>
                <span>queue {e.queueDepth ?? 0}</span>
                {e.market?.breadth ? <span>breadth {text(e.market.breadth)}</span> : null}
            </div>
        </Block>
    ),
    MARKET_EVENT: (e) => (
        <Block event={e}
               title={e.source === "FAST_PLANE" ? "FAST PLANE · MATERIAL CHANGE"
                                                : "MARKET CHANGE"}
               tone={`${severityClass(e.severity)}${e.source === "FAST_PLANE" ? " ck-plane" : ""}`}
               stage={STAGE.OBSERVE}>
            <Field label="What">{titleCase(e.type)} · {text(e.severity)}</Field>
            <Field label="Detail" value={e.reason} />
            {e.source === "FAST_PLANE" ? (
                <Field label="Detected by">
                    Go fast plane ({e.detector ?? "go_marketdata_v1"}) — deterministic,
                    on the tick, no model consulted
                </Field>
            ) : null}
        </Block>
    ),
    NEWS_EVENT: (e) => (
        <Block event={e} title="NEWS" tone={severityClass(e.severity)} stage={STAGE.OBSERVE}>
            <Field label="Detail" value={e.reason} />
        </Block>
    ),
    MATERIALITY: (e) => (
        <Block event={e} title="MATERIALITY CHECK"
               tone={e.material ? "ck-material" : "ck-quiet"} stage={STAGE.OBSERVE}>
            <Field label="Verdict" value={e.verdict} />
            <Field label="Why" value={e.because} />
        </Block>
    ),
    REASONING_STARTED: (e) => (
        <Block event={e} title="SENIOR TRADER AWAKENED" tone="ck-awaken" stage={STAGE.THINK}>
            <Field label="Trigger">{titleCase(e.trigger)}</Field>
            <Field label="Because" value={e.because} />
            <Field label="Route" value={e.route} />
        </Block>
    ),
    WHAT_I_KNOW: (e) => (
        <Block event={e} title="THE FACTS" stage={STAGE.THINK}>
            <div className="ck-evidence">
                {e.evidence?.length ? e.evidence.map((ev, i) => (
                    <div key={i} className={`ck-ev ${tierClass(ev.tier)}`}>
                        <span className="ck-ev-tier">{text(ev.tier, "?")}</span>
                        <span className="ck-ev-text">{text(ev.statement)}</span>
                        {ev.value !== null && ev.value !== undefined
                            ? <span className="ck-ev-value">{String(ev.value)}</span> : null}
                    </div>
                )) : <span className="ck-muted">no deterministic evidence available</span>}
            </div>
            <div className="ck-inline">
                <span>regime {text(e.regime)}</span>
                <span>phase {text(e.sessionPhase)}</span>
                <span>breadth {text(e.breadth)}</span>
                {e.dataStale ? <span className="ck-bad">DATA STALE</span> : null}
            </div>
            {e.memory?.summary
                ? <Field label="Memory" value={e.memory.summary} /> : null}
            {e.originalThesis ? (
                <Field label="Original thesis (immutable)"
                       value={e.originalThesis.rationale} />
            ) : null}
        </Block>
    ),
    THESIS_FORMED: (e) => (
        <Block event={e} title="THE THESIS" stage={STAGE.THINK}>
            <Field label="Thesis" value={e.thesis} />
            <Field label="Setup" value={e.setup} />
            <Field label="Supporting"><Bullets items={e.supportingEvidence} /></Field>
            <Field label="Contradicting"><Bullets items={e.contradictingEvidence} /></Field>
            <Field label="Would invalidate"><Bullets items={e.invalidationConditions} /></Field>
            <Field label="Known uncertainty"><Bullets items={e.uncertainty} /></Field>
        </Block>
    ),
    THESIS_CHALLENGED: (e) => (
        <Block event={e} title="THE CHALLENGE" tone="ck-challenge" stage={STAGE.THINK}>
            <Field label="Verdict">{titleCase(e.verdict)}</Field>
            <Field label="Strongest objection" value={e.strongestObjection} />
            <Field label="Counter-thesis" value={e.counterThesis} />
            {e.downgraded ? <Field label="Effect">confidence downgraded</Field> : null}
        </Block>
    ),
    ALTERNATIVES: (e) => (
        <Block event={e} title="ALTERNATIVE EXPLANATIONS" stage={STAGE.THINK}>
            <Bullets items={e.alternatives} />
        </Block>
    ),
    WHAT_WOULD_CHANGE_MY_MIND: (e) => (
        <Block event={e} title="WHAT WOULD CHANGE MY MIND?" stage={STAGE.THINK}>
            <Bullets items={e.conditions} />
        </Block>
    ),
    SYNTHESIS: (e) => (
        <Block event={e} title="THE SYNTHESIS" tone="ck-synthesis" stage={STAGE.THINK}>
            <div className="ck-grid">
                <Field label="R:R">{ratio(e.riskReward?.ratio)}</Field>
                <Field label="Edge" value={e.edge?.verdict} />
                <Field label="Cost hurdle">{text(e.costHurdleBps)} bps</Field>
                <Field label="Expected value">
                    {e.expectedValue?.verdict
                        ? text(e.expectedValue.verdict) : ratio(e.expectedValue?.value)}
                </Field>
                <Field label="Opportunity cost" value={e.opportunityCost?.verdict} />
                <Field label="Thesis age" value={e.thesisAge?.label} />
            </div>
            <Field label="Deterministic checks"><Bullets items={e.reasons} /></Field>
        </Block>
    ),
    DECISION: (e) => (
        <Block event={e} title="FINAL ACTION" tone={`ck-decision ck-act-${e.action}`}
               stage={STAGE.DECIDE}>
            <div className="ck-decision-line">
                <span className="ck-action">{text(e.action)}</span>
                <span className="ck-conf">confidence {text(e.confidence)}</span>
                {e.quantity ? <span>{text(e.quantity)} sh</span> : null}
                {e.fallback ? <span className="ck-bad">SAFE FALLBACK</span> : null}
            </div>
            <Field label="Confidence basis"><Bullets items={e.confidenceBasis} /></Field>
            {e.whatChanged ? <Field label="What changed" value={e.whatChanged} /> : null}
        </Block>
    ),
    REVALIDATION: (e) => (
        <Block event={e} title="FRESH-WORLD REVALIDATION"
               tone={e.verdict === "REJECT" ? "ck-reject" : ""} stage={STAGE.RISK}>
            <Field label="Verdict" value={e.verdict} />
            {e.reason ? <Field label="Reason" value={e.reason} /> : null}
            <div className="ck-inline">
                <span>decision price {rupees(e.decisionPricePaise)}</span>
                <span>world price {rupees(e.worldPricePaise)}</span>
                <span>data age {text(e.priceAgeMs)} ms</span>
            </div>
        </Block>
    ),
    RISK_DECISION: (e) => (
        <Block event={e} title="RISK GATE"
               tone={e.decision === "ALLOW" ? "ck-allow" : "ck-reject"} stage={STAGE.RISK}>
            <Field label="Verdict" value={e.decision} />
            <Field label="Reason" value={e.reason ?? e.code} />
        </Block>
    ),
    ORDER_STATE_CHANGED: (e) => (
        <Block event={e} title={e.duplicate ? "ORDER · ALREADY PLACED" : "ORDER PLACED"}
               tone="ck-order" stage={STAGE.ORDER}>
            <div className="ck-inline">
                <span className={`ck-action ck-act-${e.side}`}>{text(e.side)}</span>
                <span>{text(e.quantity)} sh</span>
                <span>@ {rupees(e.pricePaise)}</span>
                <span className="ck-state">{text(e.state)}</span>
            </div>
            {e.duplicate ? (
                <Field label="Note">
                    the engine already held this exact intent; nothing was sent twice
                </Field>
            ) : null}
        </Block>
    ),
    FILL: (e) => (
        <Block event={e}
               title={e.state === "PARTIALLY_FILLED" ? "PARTIALLY FILLED" : "FILLED"}
               tone="ck-fill" stage={STAGE.FILL}>
            <div className="ck-inline">
                <span className="ck-fill-qty">
                    {text(e.filledQuantity)} of {text(e.quantity)} sh
                </span>
                <span>@ {rupees(e.pricePaise)}</span>
                {e.pnlPaise !== null && e.pnlPaise !== undefined ? (
                    <span className={Number(e.pnlPaise) >= 0 ? "ck-up" : "ck-down"}>
                        realised {signedRupees(e.pnlPaise)}
                    </span>
                ) : null}
            </div>
        </Block>
    ),
    POSITION_CHANGED: (e) => (
        <Block event={e} title="POSITION" tone="ck-position" stage={STAGE.POSITION}>
            <div className="ck-inline">
                <span>{text(e.quantity)} sh</span>
                <span>entry {rupees(e.entryPricePaise)}</span>
                <span>now {rupees(e.currentPricePaise)}</span>
                {e.unrealisedPnlPaise !== null && e.unrealisedPnlPaise !== undefined ? (
                    <span className={Number(e.unrealisedPnlPaise) >= 0 ? "ck-up" : "ck-down"}>
                        {signedRupees(e.unrealisedPnlPaise)}
                    </span>
                ) : null}
            </div>
            {e.change ? <Field label="Change" value={e.change} /> : null}
        </Block>
    ),
    // A protective action that FAILED must not read like one that worked.
    PROTECTIVE_EVENT: (e) => (
        <Block event={e}
               title={e.failed ? "PROTECTIVE EXIT FAILED" : "PROTECTIVE EXIT"}
               tone={e.failed ? "ck-reject" : "ck-protective"} stage={STAGE.PROTECT}>
            <Field label="Crossed">
                {titleCase(e.crossing)} at {rupees(e.pricePaise)}
            </Field>
            {e.levelPaise ? <Field label="Level">{rupees(e.levelPaise)}</Field> : null}
            <Field label={e.failed ? "What happened" : "Why"} value={e.because} />
            <Field label="Model consulted">no — the thesis pre-committed to this</Field>
            {e.failed ? (
                <Field label="Now">
                    the level stays armed; the next tick tries again
                </Field>
            ) : null}
        </Block>
    ),
    PROTECTION: (e) => (
        <Block event={e}
               title={e.state === "UNPROTECTED"
                   ? "POSITIONS WITH NO PROTECTION" : "PROTECTION CHANGED HANDS"}
               tone={e.state === "UNPROTECTED" ? "ck-reject" : "ck-protective"}
               stage={STAGE.PROTECT}>
            {e.state === "UNPROTECTED" ? (
                <>
                    <Field label="Uncovered">{(e.symbols ?? []).join(", ") || UNKNOWN}</Field>
                    <Bullets items={(e.positions ?? []).map(
                        (p) => `${text(p.symbol)} — ${text(p.reason)}`)} />
                </>
            ) : (
                <>
                    <Field label="Now protected by">
                        {e.protectedBy === "go_fast_plane"
                            ? "the Go fast plane" : "the local reflex lane"}
                    </Field>
                    {e.reopenedLevels
                        ? <Field label="Levels re-opened">{text(e.reopenedLevels)}</Field>
                        : null}
                </>
            )}
            <Field label="Why" value={e.because} />
        </Block>
    ),
    REASSESSMENT: (e) => (
        <Block event={e} title="REASSESSED" tone="ck-reassess" stage={STAGE.POSITION}>
            <Field label="Action">
                <span className={`ck-action ck-act-${e.action}`}>{text(e.action)}</span>
            </Field>
            <Field label="Thesis still valid">
                {e.thesisStillValid === null || e.thesisStillValid === undefined
                    ? UNKNOWN : e.thesisStillValid ? "yes" : "no"}
            </Field>
            <Field label="What changed" value={e.whatChanged} />
        </Block>
    ),
    STALE_DATA: (e) => (
        <Block event={e} title="FEED WENT QUIET" tone="ck-reject" stage={STAGE.OBSERVE}>
            <Field label="Symbols">{(e.symbols ?? []).join(", ") || UNKNOWN}</Field>
            <Field label="Armed positions affected">{text(e.armed ?? 0)}</Field>
            <Field label="Action">none — the system does not trade on absent data</Field>
        </Block>
    ),
    HALT: (e) => (
        <Block event={e}
               title={e.state === "HALTED" ? "HALTED BY THE OPERATOR" : "RESUMED BY THE OPERATOR"}
               tone={e.state === "HALTED" ? "ck-reject" : "ck-allow"} stage={STAGE.SYSTEM}>
            <Field label="Reason" value={e.because} />
            <Field label="Session" value={e.session} />
        </Block>
    ),
    SESSION: (e) => (
        <Block event={e} title="SESSION" tone="ck-quiet" stage={STAGE.SYSTEM}>
            <Field label="State" value={e.state ?? e.session} />
            {e.because ? <Field label="Why" value={e.because} /> : null}
        </Block>
    ),
    RECOVERY: (e) => (
        <Block event={e} title="TRADER READY" tone="ck-quiet" stage={STAGE.SYSTEM}>
            <div className="ck-inline">
                <span>session {text(e.session)}</span>
                <span>{text(e.armedPositions ?? 0)} of {text(e.positions ?? 0)} positions armed</span>
                <span>fast plane {text(e.fastPlane ?? "off")}</span>
                {e.adoptedOrders
                    ? <span>{text(e.adoptedOrders)} resting order(s) resumed</span> : null}
            </div>
            {e.unprotectedPositions?.length ? (
                <Field label="Not protected">
                    {e.unprotectedPositions.map((p) => text(p.symbol)).join(", ")}
                </Field>
            ) : null}
        </Block>
    ),
    ERROR: (e) => (
        <Block event={e} title="ERROR" tone="ck-reject" stage={STAGE.SYSTEM}>
            <Field label="Detail" value={e.message ?? e.reason} />
        </Block>
    ),
    REASONING_FINISHED: (e) => (
        <Block event={e} title="BACK TO OBSERVING" tone="ck-quiet" stage={STAGE.OBSERVE}>
            <div className="ck-inline">
                <span>{text(e.action)}</span>
                <span>{e.executed ? "order placed" : "no order"}</span>
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
