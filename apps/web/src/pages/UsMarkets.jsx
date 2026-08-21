import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import api from "../services/api.js";
import { motion } from "framer-motion";
import { AlertTriangle, History } from "lucide-react";
import { staggerContainer, fadeUpItem } from "../utils/motionVariants.js";
import { useUsMarketHours } from "../hooks/useUsMarketHours.js";

// No push feed exists for free US data, so "live" is short-TTL polling --
// matches the server's own 15s quote cache, no point refreshing faster.
const STOCK_POLL_INTERVAL_MS = 15_000;

const formatUsd = (value) =>
    value == null ? "—" : `$${Number(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const formatPct = (value) => (value == null ? null : `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`);

const UsMarkets = () => {
    const navigate = useNavigate();
    const [stocks, setStocks] = useState([]);
    const [stocksLoading, setStocksLoading] = useState(true);
    const [stocksError, setStocksError] = useState(null);
    const [positions, setPositions] = useState(null);
    const [positionsError, setPositionsError] = useState(null);
    const [loadingPositions, setLoadingPositions] = useState(true);
    const marketHours = useUsMarketHours();

    const fetchStocks = useCallback(async () => {
        try {
            const res = await api.get("/us-market/stocks");
            setStocks(res.data);
            setStocksError(null);
        } catch (err) {
            setStocksError(err.response?.data?.error || "Failed to load US market data");
        } finally {
            setStocksLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchStocks();
        const interval = setInterval(fetchStocks, STOCK_POLL_INTERVAL_MS);
        return () => clearInterval(interval);
    }, [fetchStocks]);

    const fetchPositions = useCallback(async () => {
        setLoadingPositions(true);
        setPositionsError(null);
        try {
            const res = await api.get("/us-market/positions");
            setPositions(res.data);
        } catch (err) {
            setPositionsError(err.response?.data?.error || "US agent is not reachable");
        } finally {
            setLoadingPositions(false);
        }
    }, []);

    useEffect(() => {
        fetchPositions();
    }, [fetchPositions]);

    const agentOffline = Boolean(positionsError);

    return (
        <motion.div className="us-markets-page" initial="hidden" animate="show" variants={staggerContainer}>
            <div className="dashboard-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "0.8rem", marginTop: "0.5rem" }}>
                <div>
                    <h1>US Markets</h1>
                    <p className="text-muted">Self-hosted paper trading, separate from your Indian portfolio.</p>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: "0.7rem", flexWrap: "wrap" }}>
                    <button className="btn-secondary" onClick={() => navigate("/us-activity")}>
                        <History size={14} /> Agent Activity
                    </button>
                    <span className={`us-hours ${marketHours.open ? "open" : "closed"}`}>
                        <span className="us-hours-dot" />
                        {marketHours.label}
                    </span>
                </div>
            </div>

            <motion.div variants={fadeUpItem} className="glass-panel" style={{ padding: "1.5rem", marginTop: "1rem" }}>
                <h2>Live Market</h2>
                {stocksError ? (
                    <p className="text-muted">{stocksError}</p>
                ) : stocksLoading ? (
                    <p className="text-muted">Loading...</p>
                ) : (
                    <table className="stock-table">
                        <thead>
                            <tr>
                                <th>Symbol</th>
                                <th>Name</th>
                                <th>Price</th>
                                <th>Change</th>
                            </tr>
                        </thead>
                        <tbody>
                            {stocks.map((s) => {
                                const isPositive = (s.changePercent ?? 0) >= 0;
                                return (
                                    <tr key={s.symbol} className="stock-row" onClick={() => navigate(`/us-stock/${s.symbol}`)}>
                                        <td className="stock-symbol">{s.symbol}</td>
                                        <td className="stock-name">{s.name}</td>
                                        <td className="stock-price">{formatUsd(s.price)}</td>
                                        <td className={`stock-change ${isPositive ? "positive" : "negative"}`}>
                                            {s.changePercent != null ? formatPct(s.changePercent) : "—"}
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                )}
            </motion.div>

            {agentOffline && (
                <motion.div variants={fadeUpItem} className="glass-panel us-offline-panel" style={{ padding: "1.2rem", marginTop: "1rem" }}>
                    <div className="us-offline-head">
                        <AlertTriangle size={18} />
                        US agent isn't running
                    </div>
                    <p className="text-muted" style={{ marginTop: "0.4rem", fontSize: "0.85rem" }}>
                        Start it with <code>./us_agent/run_us.sh</code>, then refresh this page.
                    </p>
                </motion.div>
            )}

            {!agentOffline && (
                <motion.div variants={fadeUpItem} className="glass-panel" style={{ padding: "1.5rem", marginTop: "1rem" }}>
                    <h2>Paper Positions</h2>
                    {loadingPositions ? (
                        <p className="text-muted">Loading...</p>
                    ) : positions?.positions?.length ? (
                        <table className="stock-table">
                            <thead>
                                <tr>
                                    <th>Symbol</th>
                                    <th>Side</th>
                                    <th>Qty</th>
                                    <th>Entry</th>
                                    <th>Current</th>
                                    <th>P&amp;L</th>
                                </tr>
                            </thead>
                            <tbody>
                                {positions.positions.map((pos) => (
                                    <tr key={`${pos.symbol}-${pos.id}`}>
                                        <td>{pos.symbol}</td>
                                        <td>{pos.side}</td>
                                        <td>{pos.quantity}</td>
                                        <td>{formatUsd(pos.entry_price)}</td>
                                        <td>{formatUsd(pos.current_price)}</td>
                                        <td className={pos.pnl > 0 ? "positive" : pos.pnl < 0 ? "negative" : ""}>
                                            {pos.pnl == null ? "—" : formatUsd(pos.pnl)}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    ) : (
                        <p className="text-muted">No open positions yet — a prediction becomes a position once you act on it.</p>
                    )}
                    <p className="text-muted" style={{ marginTop: "1rem" }}>
                        Cash: <strong style={{ color: "var(--text-primary)" }}>{formatUsd(positions?.cash)}</strong>
                        {" · "}
                        Holdings: <strong style={{ color: "var(--text-primary)" }}>{formatUsd(positions?.holdings_value)}</strong>
                        {" · "}
                        Total: <strong style={{ color: "var(--text-primary)" }}>{formatUsd(positions?.total_account_value)}</strong>
                        {" · "}
                        Total P&amp;L:{" "}
                        <strong style={{ color: positions?.total_pnl > 0 ? "var(--green)" : positions?.total_pnl < 0 ? "var(--red)" : "var(--text-primary)" }}>
                            {formatUsd(positions?.total_pnl)}
                        </strong>
                    </p>
                </motion.div>
            )}
        </motion.div>
    );
};

export default UsMarkets;
