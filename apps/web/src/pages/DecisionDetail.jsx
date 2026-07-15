import { useState, useEffect, useCallback } from "react";
import { useParams, Link } from "react-router-dom";
import { motion } from "framer-motion";
import { ArrowLeft, Brain, FileSearch, Receipt, ShieldQuestion } from "lucide-react";
import api from "../services/api.js";
import { formatPaise } from "../utils/format.js";

/**
 * XAI Decision Viewer (M10). Constitutional rules:
 *  - everything shown comes verbatim from immutable journal records
 *  - nothing is recomputed, summarized or invented (formatting only)
 *  - all LLM/news text renders through React escaping — never raw HTML
 */

const ACTION_CLASS = { BUY: "positive", SELL: "negative", HOLD: "" };

const minor = (v) => (v === null || v === undefined ? "—" : formatPaise(v));

const StatusPill = ({ value }) => (
    <span className={`xai-pill xai-status-${value ?? "none"}`}>{value ?? "—"}</span>
);

const RefPill = ({ refId, known }) => {
    const jump = () => {
        const el = document.getElementById(`evidence-${refId}`);
        if (!el) return;
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.classList.remove("xai-flash");
        void el.offsetWidth; // restart the animation
        el.classList.add("xai-flash");
    };
    return (
        <button className={`xai-pill xai-ref ${known ? "" : "xai-ref-unknown"}`} onClick={jump} title={known ? "Show evidence" : "Ref not present in bundle"}>
            {refId}
        </button>
    );
};

const KeyPointList = ({ points, evidenceRefs }) => {
    if (!Array.isArray(points) || points.length === 0) {
        return <p className="xai-muted">No claims recorded.</p>;
    }
    return (
        <ul className="xai-claims">
            {points.map((kp, i) => {
                const point = typeof kp === "string" ? kp : kp?.point;
                const refs = Array.isArray(kp?.refs) ? kp.refs : [];
                return (
                    <li key={i}>
                        <span>{point || <span className="xai-muted">(empty claim)</span>}</span>
                        <span className="xai-ref-row">
                            {refs.map((r) => (
                                <RefPill key={r} refId={r} known={evidenceRefs.has(r)} />
                            ))}
                        </span>
                    </li>
                );
            })}
        </ul>
    );
};

const AgentRunCard = ({ run, evidenceRefs }) => {
    const output = run.output ?? {};
    const claims = Array.isArray(output.keyPoints) ? output.keyPoints : Array.isArray(output.reasoning) ? output.reasoning : [];
    const stance = output.signal ?? output.sentiment ?? output.bias ?? output.action ?? null;
    return (
        <div className="glass-panel xai-run">
            <div className="xai-run-head">
                <strong>{run.agentName}</strong>
                <StatusPill value={run.status} />
                {run.citationReport && <span className={`xai-pill xai-cite-${run.citationReport.status}`}>citations: {run.citationReport.status}</span>}
            </div>
            <div className="xai-run-meta">
                <span>{run.modelId}</span>
                <span>{run.agentVersion}</span>
                <span>{run.latencyMs}ms</span>
                {run.promptTokens !== null && <span>{run.promptTokens}→{run.completionTokens} tok</span>}
                {run.costUsd !== null && <span>${run.costUsd}</span>}
            </div>
            {stance && <div className="xai-stance">{stance}{output.confidence ? ` · ${output.confidence}` : ""}{output.riskLevel ? ` · risk ${output.riskLevel}` : ""}</div>}
            {output.error ? <p className="xai-error-text">{output.error}</p> : <KeyPointList points={claims} evidenceRefs={evidenceRefs} />}
            <div className="xai-hash" title="canonical input hash">input {run.inputHash?.slice(0, 16)}…</div>
        </div>
    );
};

const EvidenceCard = ({ item }) => (
    <div id={`evidence-${item.ref}`} className="glass-panel xai-evidence">
        <div className="xai-evidence-head">
            <span className="xai-pill xai-ref-static">{item.ref}</span>
            <span className="xai-kind">{item.kind}</span>
        </div>
        <pre className="xai-content">{JSON.stringify(item.content, null, 2)}</pre>
        <div className="xai-source">{item.sourceRef}</div>
    </div>
);

const DecisionDetail = () => {
    const { id } = useParams();
    const [data, setData] = useState(null);
    const [error, setError] = useState(null);

    const fetchChain = useCallback(async () => {
        try {
            const res = await api.get(`/decisions/${id}`);
            setData(res.data);
        } catch (err) {
            setError(err.response?.status === 404 ? "Decision not found" : err.response?.status === 401 ? "Login required to view decisions" : "Failed to load decision");
        }
    }, [id]);

    useEffect(() => { fetchChain(); }, [fetchChain]);

    if (error) return <div className="empty-state glass-panel" style={{ marginTop: "2rem" }}><h2>{error}</h2></div>;
    if (!data) return <div className="loading-screen">Loading decision…</div>;

    const { decision, rationale, request, agentRuns, evidence, myOrders } = data;
    const evidenceRefs = new Set(evidence.map((e) => e.ref));

    const byKind = evidence.reduce((acc, e) => {
        (acc[e.kind] ??= []).push(e);
        return acc;
    }, {});

    return (
        <motion.div className="xai-page" initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}>
            <Link to="/decisions" className="btn-back"><ArrowLeft size={16} /> All decisions</Link>

            <div className="xai-header glass-panel">
                <div>
                    <h1>{decision.instrument.symbol} <span className={`xai-action ${ACTION_CLASS[decision.action] ?? ""}`}>{decision.action}</span></h1>
                    <p className="hero-subtitle">
                        {decision.mode} · confidence {decision.confidence} · {new Date(decision.createdAt).toLocaleString("en-IN")} · pipeline {decision.synthesizerVersion}
                    </p>
                </div>
                <div className="xai-levels">
                    <div><span className="xai-label">Entry</span><span>{minor(decision.entryMinor)}</span></div>
                    <div><span className="xai-label">Target</span><span className="positive">{minor(decision.targetMinor)}</span></div>
                    <div><span className="xai-label">Stop</span><span className="negative">{minor(decision.stopMinor)}</span></div>
                </div>
            </div>

            {rationale && (
                <section className="glass-panel xai-section">
                    <h3><Brain size={15} /> Synthesis rationale</h3>
                    {rationale.traderNote && <p className="xai-note">{rationale.traderNote}</p>}
                    <ul className="xai-claims">{(rationale.reasoning ?? []).map((r, i) => <li key={i}><span>{r}</span></li>)}</ul>
                    <div className="xai-run-meta">
                        {rationale.consensus && <span>consensus: {rationale.consensus}</span>}
                        {rationale.macroScore !== null && rationale.macroScore !== undefined && <span>macro score: {rationale.macroScore}</span>}
                        <span>trigger: {request.requestedBy}</span>
                        <span>regime: {request.regime?.taxonomy}:{request.regime?.label}</span>
                    </div>
                </section>
            )}

            <section className="xai-section">
                <h3 className="xai-section-title"><ShieldQuestion size={15} /> Agent runs ({agentRuns.length})</h3>
                <div className="xai-run-grid">
                    {agentRuns.map((run) => <AgentRunCard key={run.runId} run={run} evidenceRefs={evidenceRefs} />)}
                </div>
            </section>

            <section className="xai-section">
                <h3 className="xai-section-title"><FileSearch size={15} /> Evidence ({evidence.length})</h3>
                {Object.entries(byKind).map(([kind, items]) => (
                    <div key={kind} className="xai-kind-group">
                        <h4>{kind}</h4>
                        <div className="xai-evidence-grid">{items.map((e) => <EvidenceCard key={e.evidenceId} item={e} />)}</div>
                    </div>
                ))}
                {evidence.length === 0 && <p className="xai-muted">No evidence rows (pre-M8 decision).</p>}
            </section>

            {myOrders.length > 0 && (
                <section className="glass-panel xai-section">
                    <h3><Receipt size={15} /> My linked trades</h3>
                    <ul className="xai-claims">
                        {myOrders.map((o) => (
                            <li key={o.orderId}>
                                <span>{o.side} {o.quantity} @ {minor(o.priceMinor)} ({o.mode}) — {new Date(o.createdAt).toLocaleString("en-IN")}{o.pnlMinor !== null ? ` · PnL ${minor(o.pnlMinor)}` : ""}</span>
                            </li>
                        ))}
                    </ul>
                </section>
            )}

            <div className="xai-footer">correlation {decision.correlationId} · request {data.request.requestId}</div>
        </motion.div>
    );
};

export default DecisionDetail;
