import { useState, useEffect, useCallback } from "react";
import { motion } from "framer-motion";
import { Activity, TrendingUp, TrendingDown, CheckCircle2, PauseCircle, AlertTriangle } from "lucide-react";
import api from "../services/api.js";
import { staggerContainer, fadeUpItem } from "../utils/motionVariants.js";
import { useUsMarketHours } from "../hooks/useUsMarketHours.js";

// Cycles land every 60s (trader_loop.py's LOOP_INTERVAL) -- poll faster
// than that so a new cycle shows up promptly, not once-a-minute-ish.
const ACTIVITY_POLL_INTERVAL_MS = 15_000;

const formatUsd = (value) =>
    value == null ? "—" : `$${Number(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const formatPct = (value) => (value == null ? "—" : `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`);

const formatTime = (iso) =>
    new Date(iso).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

const relativeTime = (iso, now) => {
    const seconds = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 1000));
    if (seconds < 5) return "just now";
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    return `${minutes}m ago`;
};

/** What actually happened to this ticker this cycle, distinct from what
 * the LLM merely suggested -- a BUY suggestion routinely gets held back
 * by the no-reversal rule or a cash cap, and that's exactly the gap this
 * page exists to make visible. */
const Verdict = ({ ticker }) => {
    if (ticker.error) {
        return (
            <div className="us-activity-verdict error">
                <AlertTriangle size={13} /> Failed — {ticker.error}
            </div>
        );
    }
    if (ticker.submitted) {
        return (
            <div className="us-activity-verdict submitted">
                <CheckCircle2 size={13} />
                Submitted {ticker.risk_action?.toUpperCase()} {ticker.quantity ? `x${ticker.quantity}` : ""} @ {formatUsd(ticker.current_price)}
            </div>
        );
    }
    if (ticker.risk_action === "hold" && ticker.llm_decision && ticker.llm_decision !== "HOLD") {
        return (
            <div className="us-activity-verdict blocked">
                <PauseCircle size={13} />
                Risk engine held it back — {ticker.risk_reason}
            </div>
        );
    }
    return (
        <div className="us-activity-verdict held">
            <PauseCircle size={13} /> {ticker.risk_reason || "No action"}
        </div>
    );
};

const TickerCard = ({ ticker }) => {
    const change = ticker.change_24h_pct;
    const isPositive = change != null && change >= 0;
    const decisionClass = (ticker.llm_decision || "").toLowerCase();
    const cardClass = ticker.error ? "us-activity-error" : ticker.submitted ? "us-activity-traded" : "";

    return (
        <div className={`us-activity-ticker ${cardClass}`}>
            <div className="us-activity-ticker-head">
                <span className="us-activity-symbol">{ticker.ticker}</span>
                <span className="us-activity-price">{formatUsd(ticker.current_price)}</span>
                {change != null && (
                    <span className={`us-activity-change ${isPositive ? "positive" : "negative"}`}>
                        {isPositive ? <TrendingUp size={11} /> : <TrendingDown size={11} />} {formatPct(change)} 24h
                    </span>
                )}
                {ticker.llm_decision && (
                    <span className={`us-decision-pill us-decision-pill-end ${decisionClass}`}>
                        {ticker.llm_decision}
                    </span>
                )}
            </div>

            {ticker.llm_confidence != null && (
                <div className="us-decision-row us-decision-row-tight">
                    <div className="us-confidence-track">
                        <div className={`us-confidence-fill ${decisionClass}`} style={{ width: `${ticker.llm_confidence}%` }} />
                    </div>
                    <span className="us-confidence-label">{ticker.llm_confidence}%</span>
                </div>
            )}

            {(ticker.rsi_14 != null || ticker.macd_bullish != null || ticker.price_vs_sma20_pct != null) && (
                <div className="us-activity-indicators">
                    {ticker.rsi_14 != null && (
                        <span className={`us-activity-indicator ${ticker.rsi_14 >= 70 ? "warn" : ticker.rsi_14 <= 30 ? "warn" : ""}`}>
                            RSI {ticker.rsi_14}
                        </span>
                    )}
                    {ticker.macd_bullish != null && (
                        <span className={`us-activity-indicator ${ticker.macd_bullish ? "bull" : "bear"}`}>
                            MACD {ticker.macd_bullish ? "bullish" : "bearish"}
                        </span>
                    )}
                    {ticker.price_vs_sma20_pct != null && (
                        <span className="us-activity-indicator">SMA20 {formatPct(ticker.price_vs_sma20_pct)}</span>
                    )}
                    {ticker.bb_position_pct != null && (
                        <span className="us-activity-indicator">BB {ticker.bb_position_pct.toFixed(0)}%</span>
                    )}
                </div>
            )}

            {ticker.llm_reason && (
                <div className="us-activity-thought">
                    <div className="us-activity-thought-label">Model's reasoning</div>
                    <div className="us-activity-thought-text">{ticker.llm_reason}</div>
                </div>
            )}

            <Verdict ticker={ticker} />
        </div>
    );
};

const CycleCard = ({ cycle, now }) => {
    const positions = cycle.portfolio_after?.positions || [];
    // Only sums positions that have actually been priced -- a position
    // still waiting on its first background refresh has pnl: null, and
    // treating that as 0 would understate a real gain/loss just because
    // one more position hasn't reported in yet.
    const pricedPositions = positions.filter((p) => p.pnl != null);
    const holdingsValue = cycle.portfolio_after?.holdings_value;
    const totalAccountValue = cycle.portfolio_after?.total_account_value;
    const totalPnl = cycle.portfolio_after?.total_pnl;

    return (
        <motion.div variants={fadeUpItem} className="glass-panel us-activity-cycle">
            <div className="us-activity-cycle-head">
                <div>
                    <span className="us-activity-time">{formatTime(cycle.timestamp)}</span>
                    <span className="us-activity-relative">{relativeTime(cycle.timestamp, now)}</span>
                </div>
                <span className="us-activity-cash">
                    Cash: <strong>{formatUsd(cycle.cash_before)}</strong>
                </span>
            </div>

            <div className="us-activity-tickers">
                {cycle.tickers.map((t) => (
                    <TickerCard key={t.ticker} ticker={t} />
                ))}
            </div>

            <div className="us-activity-portfolio">
                <span className="us-activity-portfolio-stat">
                    Portfolio as of this minute — Cash: <strong>{formatUsd(cycle.portfolio_after?.cash)}</strong>
                </span>
                <span className="us-activity-portfolio-stat">
                    Open positions: <strong>{positions.length}</strong>
                    {pricedPositions.length < positions.length && (
                        <span className="text-muted"> ({positions.length - pricedPositions.length} awaiting first price)</span>
                    )}
                </span>
                <span className="us-activity-portfolio-stat">
                    Holdings value: <strong>{formatUsd(holdingsValue)}</strong>
                </span>
                <span className="us-activity-portfolio-stat">
                    Total money (cash + holdings): <strong className="us-total-value">{formatUsd(totalAccountValue)}</strong>
                </span>
                <span className="us-activity-portfolio-stat">
                    Total P&amp;L:{" "}
                    <strong className={totalPnl > 0 ? "positive" : totalPnl < 0 ? "negative" : ""}>
                        {formatUsd(totalPnl)}
                    </strong>
                </span>
            </div>
        </motion.div>
    );
};

const UsAgentActivity = () => {
    const [cycles, setCycles] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [now, setNow] = useState(() => Date.now());
    const marketHours = useUsMarketHours();

    const fetchActivity = useCallback(async () => {
        try {
            const res = await api.get("/us-market/activity?limit=20");
            setCycles(res.data.cycles || []);
            setError(null);
        } catch (err) {
            setError(err.response?.data?.error || "US agent is not reachable");
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchActivity();
        const interval = setInterval(fetchActivity, ACTIVITY_POLL_INTERVAL_MS);
        return () => clearInterval(interval);
    }, [fetchActivity]);

    useEffect(() => {
        const tick = setInterval(() => setNow(Date.now()), 5_000);
        return () => clearInterval(tick);
    }, []);

    return (
        <motion.div className="us-markets-page" initial="hidden" animate="show" variants={staggerContainer}>
            <div className="us-page-header">
                <div>
                    <h1>Agent Activity</h1>
                    <p className="text-muted">
                        Every autonomous cycle, minute by minute. What the model saw, what it decided, and what the risk engine actually let through.
                    </p>
                </div>
                <span className={`us-hours ${marketHours.open ? "open" : "closed"}`}>
                    <span className="us-hours-dot" />
                    {marketHours.label}
                </span>
            </div>

            {error ? (
                <motion.div variants={fadeUpItem} className="glass-panel us-offline-panel">
                    <div className="us-offline-head">
                        <AlertTriangle size={18} />
                        US agent isn't running
                    </div>
                    <p className="text-muted us-offline-detail">
                        Start it with <code>./us_agent/run_us.sh</code>, then refresh this page.
                    </p>
                </motion.div>
            ) : loading ? (
                <motion.div variants={fadeUpItem} className="glass-panel us-panel">
                    <p className="text-muted">Loading...</p>
                </motion.div>
            ) : cycles.length === 0 ? (
                <motion.div variants={fadeUpItem} className="glass-panel us-empty-state">
                    <Activity size={28} className="us-activity-empty-icon" />
                    <p className="text-muted">
                        No cycles yet. Start the autonomous loop with <code>./us_agent/run_decision_loop.sh</code> and its first
                        decision will show up here within a minute.
                    </p>
                </motion.div>
            ) : (
                <div className="us-activity-timeline">
                    {cycles.map((cycle) => (
                        <CycleCard key={cycle.timestamp} cycle={cycle} now={now} />
                    ))}
                </div>
            )}
        </motion.div>
    );
};

export default UsAgentActivity;
