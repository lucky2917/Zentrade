import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
    Sparkles, TrendingUp, TrendingDown, Minus,
    RefreshCw, AlertTriangle, BarChart2, Newspaper, Shield,
    Target, ArrowDownRight, Quote, Activity, Layers,
} from "lucide-react";
import api from "../services/api.js";
import RiskManager from "./RiskManager.jsx";

const ACTION_CFG = {
    BUY:  { color: "#30d158", bg: "rgba(48,209,88,0.1)",   border: "rgba(48,209,88,0.35)",  Icon: TrendingUp  },
    SELL: { color: "#ff3b30", bg: "rgba(255,59,48,0.1)",   border: "rgba(255,59,48,0.35)",  Icon: TrendingDown },
    HOLD: { color: "#ff9f0a", bg: "rgba(255,159,10,0.1)",  border: "rgba(255,159,10,0.35)", Icon: Minus        },
};
const SIGNAL_COLOR = { BULLISH: "#30d158", BEARISH: "#ff3b30", NEUTRAL: "#8e8e93" };
const CONF_COLOR   = { HIGH: "#30d158", MEDIUM: "#ff9f0a", LOW: "#ff3b30" };
const RISK_COLOR   = { LOW: "#30d158", MEDIUM: "#ff9f0a", HIGH: "#ff3b30" };
const CONSENSUS_CFG = {
    unanimous: { label: "Unanimous · 3/3",   color: "#30d158" },
    majority:  { label: "Majority · 2/3",    color: "#30d158" },
    leaning:   { label: "Leaning · 2 vs 1",  color: "#ff9f0a" },
    split:     { label: "Split · tied",      color: "#ff3b30" },
};
const MODE_CFG = {
    INTRADAY: { label: "MIS · Intraday · Square off by 3:15 PM", color: "#0a84ff" },
};

const fmt = (n) => n != null
    ? new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(n)
    : "—";
const pct = (n) => n != null ? (n > 0 ? "+" : "") + n.toFixed(2) + "%" : "—";
const sign = (n) => n > 0 ? "+" : "";

function AgentChip({ icon: Icon, label, signal, confidence, riskLevel }) {
    const color = SIGNAL_COLOR[signal] ?? RISK_COLOR[riskLevel] ?? "#94a3b8";
    return (
        <div style={{
            background: `${color}10`, border: `1px solid ${color}30`,
            borderRadius: 7, padding: "0.45rem 0.6rem",
        }}>
            <div style={{ fontSize: "0.65rem", color: "#8e8e93", display: "flex", alignItems: "center", gap: 3, marginBottom: 3 }}>
                <Icon size={10} />{label}
            </div>
            <div style={{ fontSize: "0.75rem", fontWeight: 700, color }}>{signal ?? `Risk: ${riskLevel}`}</div>
            <div style={{ fontSize: "0.62rem", color: CONF_COLOR[confidence] ?? "#8e8e93", marginTop: 1 }}>{confidence}</div>
        </div>
    );
}

function PriceLine({ label, value, pctValue, color, icon: Icon }) {
    return (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "0.55rem 0", borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: "0.78rem", color: "#8e8e93" }}>
                {Icon && <Icon size={13} style={{ color }} />}{label}
            </div>
            <div style={{ textAlign: "right" }}>
                <span style={{ fontSize: "0.88rem", fontWeight: 700, color }}>{fmt(value)}</span>
                {pctValue != null && (
                    <span style={{ fontSize: "0.7rem", color, marginLeft: 5 }}>({pct(pctValue)})</span>
                )}
            </div>
        </div>
    );
}

function IntradaySetup({ intraday }) {
    if (!intraday) return null;
    const { gapPct, orStatus, intradayVwap, priceAboveVwap, rsi15m, emaSignal } = intraday;

    const gapColor   = gapPct == null ? "#8e8e93" : gapPct > 0 ? "#30d158" : gapPct < 0 ? "#ff3b30" : "#8e8e93";
    const orColor    = orStatus?.includes("bullish") ? "#30d158" : orStatus?.includes("bearish") ? "#ff3b30" : "#ff9f0a";
    const vwapColor  = priceAboveVwap == null ? "#8e8e93" : priceAboveVwap ? "#30d158" : "#ff3b30";
    const emaColor   = emaSignal === "BULLISH" ? "#30d158" : emaSignal === "BEARISH" ? "#ff3b30" : "#8e8e93";
    const rsiColor   = rsi15m == null ? "#8e8e93" : rsi15m > 60 ? "#30d158" : rsi15m < 40 ? "#ff3b30" : "#ff9f0a";

    return (
        <div style={{
            background: "rgba(255,255,255,0.02)",
            border: "1px solid rgba(255,255,255,0.07)",
            borderRadius: 8, padding: "0.55rem 0.8rem",
            marginBottom: "0.75rem",
            display: "grid", gridTemplateColumns: "1fr 1fr 1fr",
            gap: "0.4rem 0.6rem",
        }}>
            <IntradayCell label="Gap at open"
                value={gapPct != null ? `${gapPct > 0 ? "+" : ""}${gapPct}%` : "N/A"}
                color={gapColor} />
            <IntradayCell label="Opening Range"
                value={orStatus?.replace(" — ", " ") ?? "N/A"}
                color={orColor} />
            <IntradayCell label="Intraday VWAP"
                value={intradayVwap ? `₹${intradayVwap} · ${priceAboveVwap ? "above" : "below"}` : "N/A"}
                color={vwapColor} />
            <IntradayCell label="15-min RSI"
                value={rsi15m != null ? String(rsi15m) : "N/A"}
                color={rsiColor} />
            <IntradayCell label="15-min EMA"
                value={emaSignal ?? "N/A"}
                color={emaColor} />
        </div>
    );
}

function IntradayCell({ label, value, color }) {
    return (
        <div>
            <div style={{ fontSize: "0.6rem", color: "#475569", marginBottom: 2 }}>{label}</div>
            <div style={{ fontSize: "0.72rem", fontWeight: 700, color, lineHeight: 1.3 }}>{value}</div>
        </div>
    );
}

// Macro / sector status bar shown at the top of the result
function MacroBadge({ macro }) {
    if (!macro || macro.niftyChange == null) return null;
    const niftyUp   = macro.niftyChange >= 0;
    const sectorUp  = macro.sectorChange != null ? macro.sectorChange >= 0 : null;
    const nColor    = niftyUp ? "#10b981" : "#ef4444";
    const sColor    = sectorUp === null ? "#64748b" : sectorUp ? "#10b981" : "#ef4444";

    return (
        <div style={{
            display: "flex", gap: 6, marginBottom: "0.75rem", flexWrap: "wrap",
        }}>
            <Badge color={nColor}>
                <Layers size={9} />
                Nifty {sign(macro.niftyChange)}{macro.niftyChange?.toFixed(2)}%
                {macro.niftyAboveOpen != null && (
                    <span style={{ opacity: 0.7, fontSize: "0.6rem" }}>
                        &nbsp;· {macro.niftyAboveOpen ? "▲ day open" : "▼ day open"}
                    </span>
                )}
            </Badge>
            {macro.sectorChange != null && (
                <Badge color={sColor}>
                    <Activity size={9} />
                    {macro.sector} {sign(macro.sectorChange)}{macro.sectorChange?.toFixed(2)}%
                </Badge>
            )}
            {macro.score !== 0 && (
                <Badge color={macro.score === 1 ? "#10b981" : "#ef4444"}>
                    {macro.score === 1 ? "Macro tailwind" : "Macro headwind"}
                </Badge>
            )}
        </div>
    );
}

function Badge({ color, children }) {
    return (
        <span style={{
            display: "inline-flex", alignItems: "center", gap: 4,
            fontSize: "0.68rem", fontWeight: 600, color,
            background: `${color}12`, border: `1px solid ${color}30`,
            borderRadius: 5, padding: "2px 7px",
        }}>
            {children}
        </span>
    );
}

const AISuggestion = ({ symbol, stockName }) => {
    const [loading, setLoading] = useState(false);
    const [result, setResult]   = useState(null);
    const [error, setError]     = useState(null);

    const fetchAnalysis = async () => {
        setLoading(true);
        setError(null);
        try {
            const res = await api.get(`/ai/analyse/${symbol}`);
            setResult(res.data);
        } catch (err) {
            setError(err.response?.data?.error || "Analysis failed. Please try again.");
        } finally {
            setLoading(false);
        }
    };

    const cfg = result ? ACTION_CFG[result.action] : null;
    const rrRatio = result?.targetPct && result?.stopLossPct
        ? (result.targetPct / result.stopLossPct).toFixed(1)
        : null;

    return (
        <div style={{
            background: "var(--card-bg, rgba(255,255,255,0.03))",
            border: "1px solid var(--border, rgba(255,255,255,0.08))",
            borderRadius: 12, padding: "1.25rem", marginTop: "1rem",
        }}>
            {/* Header */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "1rem" }}>
                <h3 style={{ margin: 0, fontSize: "0.95rem", fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}>
                    <Sparkles size={15} style={{ color: "#a78bfa" }} />
                    Zentrade AI
                    <span style={{ fontSize: "0.62rem", color: "#64748b", fontWeight: 400 }}>top-down ensemble</span>
                </h3>
                {result && !loading && (
                    <button onClick={fetchAnalysis} title="Refresh" style={{ background: "none", border: "none", cursor: "pointer", color: "#64748b", padding: 4, display: "flex" }}>
                        <RefreshCw size={13} />
                    </button>
                )}
            </div>

            {/* Idle */}
            {!result && !loading && !error && (
                <div style={{ textAlign: "center" }}>
                    <p style={{ color: "#64748b", fontSize: "0.8rem", margin: "0 0 0.6rem", lineHeight: 1.5 }}>
                        Macro → Sector → Stock analysis. Three independent agents check the top-down picture, then a synthesizer makes a specific call with entry, target, and stop-loss.
                    </p>
                    <button onClick={fetchAnalysis} style={{
                        background: "linear-gradient(135deg, rgba(167,139,250,0.2), rgba(139,92,246,0.3))",
                        border: "1px solid rgba(167,139,250,0.4)", color: "#c4b5fd",
                        borderRadius: 8, padding: "0.55rem 1.2rem", fontSize: "0.85rem",
                        fontWeight: 600, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6,
                    }}>
                        <Sparkles size={14} /> Analyse {symbol}
                    </button>
                </div>
            )}

            {/* Loading */}
            {loading && (
                <div style={{ textAlign: "center", padding: "1.2rem 0" }}>
                    <div style={{ display: "flex", justifyContent: "center", gap: 6, marginBottom: "0.6rem" }}>
                        {[0, 1, 2].map((i) => (
                            <motion.span key={i}
                                style={{ width: 8, height: 8, borderRadius: "50%", background: "#a78bfa", display: "block" }}
                                animate={{ opacity: [0.3, 1, 0.3], scale: [0.8, 1.1, 0.8] }}
                                transition={{ duration: 1.2, repeat: Infinity, delay: i * 0.2 }}
                            />
                        ))}
                    </div>
                    <p style={{ color: "#64748b", fontSize: "0.8rem", margin: 0 }}>
                        Checking Nifty · {result?.macro?.sector ?? "sector"} · stock signals...
                    </p>
                </div>
            )}

            {/* Error */}
            {error && !loading && (
                <div style={{ color: "#ef4444", fontSize: "0.82rem" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
                        <AlertTriangle size={14} />{error}
                    </div>
                    <button onClick={fetchAnalysis} style={{
                        background: "none", border: "1px solid rgba(239,68,68,0.4)",
                        color: "#ef4444", borderRadius: 6, padding: "3px 10px", fontSize: "0.78rem", cursor: "pointer",
                    }}>Retry</button>
                </div>
            )}

            {/* Result */}
            <AnimatePresence>
                {result && !loading && cfg && (
                    <motion.div
                        initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0 }} transition={{ duration: 0.3 }}
                    >
                        {/* Macro / sector context */}
                        <MacroBadge macro={result.macro} />

                        {/* Intraday setup — OR, VWAP, gap, 15-min signals */}
                        <IntradaySetup intraday={result.intraday} />

                        {/* Agent chips */}
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "0.45rem", marginBottom: "0.8rem" }}>
                            <AgentChip icon={BarChart2} label="Technical"
                                signal={result.agents.technical.signal}
                                confidence={result.agents.technical.confidence} />
                            <AgentChip icon={Newspaper} label="Sentiment"
                                signal={result.agents.sentiment.signal}
                                confidence={result.agents.sentiment.confidence} />
                            <AgentChip icon={Shield} label="Risk"
                                signal={result.agents.risk.bias}
                                riskLevel={result.agents.risk.riskLevel}
                                confidence={result.agents.risk.confidence} />
                        </div>

                        {/* VWAP status */}
                        {result.vwap20 != null && (
                            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: "0.65rem" }}>
                                <span style={{ fontSize: "0.7rem", color: "#64748b" }}>20-day VWAP</span>
                                <span style={{
                                    fontSize: "0.7rem", fontWeight: 700,
                                    color: result.aboveVWAP ? "#10b981" : "#ef4444",
                                    background: result.aboveVWAP ? "rgba(16,185,129,0.1)" : "rgba(239,68,68,0.1)",
                                    border: `1px solid ${result.aboveVWAP ? "rgba(16,185,129,0.3)" : "rgba(239,68,68,0.3)"}`,
                                    borderRadius: 5, padding: "2px 8px",
                                }}>
                                    {fmt(result.vwap20)} · {result.aboveVWAP ? "Price above — bullish structure" : "Price below — bearish structure"}
                                </span>
                            </div>
                        )}

                        {/* Consensus */}
                        {result.consensus && (() => {
                            const cc = CONSENSUS_CFG[result.consensus] ?? CONSENSUS_CFG.split;
                            return (
                                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: "0.85rem" }}>
                                    <span style={{ fontSize: "0.7rem", color: "#64748b" }}>Consensus</span>
                                    <span style={{
                                        fontSize: "0.7rem", fontWeight: 700, color: cc.color,
                                        background: `${cc.color}15`, border: `1px solid ${cc.color}35`,
                                        borderRadius: 5, padding: "2px 8px",
                                    }}>{cc.label}</span>
                                </div>
                            );
                        })()}

                        <hr style={{ borderColor: "var(--border, rgba(255,255,255,0.08))", margin: "0 0 0.85rem" }} />

                        {/* Action + mode + confidence */}
                        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: "1rem" }}>
                            <div style={{
                                display: "inline-flex", alignItems: "center", gap: 7,
                                background: cfg.bg, border: `1px solid ${cfg.border}`, color: cfg.color,
                                borderRadius: 8, padding: "0.45rem 1rem", fontWeight: 800, fontSize: "1.05rem",
                            }}>
                                <cfg.Icon size={18} />{result.action}
                            </div>
                            {MODE_CFG[result.mode] && (
                                <span style={{
                                    fontSize: "0.75rem", fontWeight: 600, color: MODE_CFG[result.mode].color,
                                    background: `${MODE_CFG[result.mode].color}15`,
                                    border: `1px solid ${MODE_CFG[result.mode].color}35`,
                                    borderRadius: 6, padding: "3px 9px",
                                }}>{MODE_CFG[result.mode].label}</span>
                            )}
                            <span style={{ marginLeft: "auto", fontSize: "0.75rem", fontWeight: 600, color: CONF_COLOR[result.confidence] }}>
                                {result.confidence} confidence
                            </span>
                        </div>

                        {/* Price levels */}
                        {result.action !== "HOLD" && result.entry && (
                            <div style={{
                                background: "rgba(255,255,255,0.025)",
                                border: "1px solid rgba(255,255,255,0.07)",
                                borderRadius: 9, padding: "0.1rem 0.9rem", marginBottom: "0.85rem",
                            }}>
                                <PriceLine label="Entry"     value={result.entry}    color="#94a3b8" icon={ArrowDownRight} />
                                <PriceLine label="Target"    value={result.target}   pctValue={result.targetPct}                color="#10b981" icon={Target} />
                                <PriceLine label="Stop-loss" value={result.stopLoss} pctValue={result.stopLossPct != null ? -result.stopLossPct : null} color="#ef4444" icon={AlertTriangle} />
                                {rrRatio && (
                                    <div style={{ display: "flex", justifyContent: "flex-end", padding: "0.4rem 0 0.1rem", fontSize: "0.72rem", color: "#64748b" }}>
                                        Risk : Reward &nbsp;
                                        <strong style={{ color: Number(rrRatio) >= 2 ? "#10b981" : Number(rrRatio) >= 1 ? "#f59e0b" : "#ef4444" }}>
                                            1 : {rrRatio}
                                        </strong>
                                    </div>
                                )}
                            </div>
                        )}

                        {/* Position sizer */}
                        {result.action !== "HOLD" && result.entry && result.stopLoss && (
                            <RiskManager
                                entry={result.entry}
                                stopLoss={result.stopLoss}
                                action={result.action}
                            />
                        )}

                        {/* Trader's note */}
                        {result.traderNote && (
                            <div style={{
                                background: "rgba(167,139,250,0.07)",
                                border: "1px solid rgba(167,139,250,0.2)",
                                borderRadius: 9, padding: "0.75rem 0.9rem", marginTop: "0.85rem", marginBottom: "0.9rem",
                            }}>
                                <div style={{ display: "flex", gap: 7 }}>
                                    <Quote size={14} style={{ color: "#a78bfa", flexShrink: 0, marginTop: 2 }} />
                                    <p style={{ margin: 0, fontSize: "0.81rem", color: "#c4b5fd", lineHeight: 1.55, fontStyle: "italic" }}>
                                        {result.traderNote}
                                    </p>
                                </div>
                            </div>
                        )}

                        {/* Reasoning bullets */}
                        {result.reasoning?.length > 0 && (
                            <ul style={{ margin: "0 0 0.85rem", paddingLeft: "1.1rem", display: "flex", flexDirection: "column", gap: "0.35rem" }}>
                                {result.reasoning.map((r, i) => (
                                    <li key={i} style={{ fontSize: "0.79rem", color: "#94a3b8", lineHeight: 1.45 }}>{r}</li>
                                ))}
                            </ul>
                        )}

                        {/* Footer */}
                        <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.68rem", color: "#64748b" }}>
                            <span>Groq ensemble · {result.cached ? "cached" : "live"}</span>
                            {result.cachedAt && (
                                <span>{new Date(result.cachedAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}</span>
                            )}
                        </div>
                        <p style={{ margin: "0.4rem 0 0", fontSize: "0.67rem", color: "#475569", fontStyle: "italic" }}>
                            Paper trading assistance only — not financial advice.
                        </p>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
};

export default AISuggestion;
