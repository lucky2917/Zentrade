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
            <div className="us-page-header">
                <div>
                    <h1>US Markets</h1>
                    <p className="text-muted">Self-hosted paper trading, separate from your Indian portfolio.</p>
                </div>
                <div className="us-page-actions">
                    <button className="btn-secondary" onClick={() => navigate("/us-activity")}>
                        <History size={14} /> Agent Activity
                    </button>
                    <span className={`us-hours ${marketHours.open ? "open" : "closed"}`}>
                        <span className="us-hours-dot" />
                        {marketHours.label}
                    </span>
                </div>
            </div>

            {!agentOffline && positions && (
                <motion.div variants={fadeUpItem} className="us-stat-strip">
                    <div className="us-stat-card">
                        <span className="us-stat-label">Cash</span>
                        <span className="us-stat-value">{formatUsd(positions.cash)}</span>
                    </div>
                    <div className="us-stat-card">
                        <span className="us-stat-label">Holdings</span>
                        <span className="us-stat-value">{formatUsd(positions.holdings_value)}</span>
                    </div>
                    <div className="us-stat-card">
                        <span className="us-stat-label">Total Value</span>
                        <span className="us-stat-value">{formatUsd(positions.total_account_value)}</span>
                    </div>
                    <div className="us-stat-card">
                        <span className="us-stat-label">Total P&amp;L</span>
                        <span className={`us-stat-value ${positions.total_pnl > 0 ? "positive" : positions.total_pnl < 0 ? "negative" : ""}`}>
                            {formatUsd(positions.total_pnl)}
                        </span>
                    </div>
                </motion.div>
            )}

            <motion.div variants={fadeUpItem} className="glass-panel us-panel">
                <h2 className="us-panel-title">Live Market</h2>
                {stocksError ? (
                    <p className="text-muted">{stocksError}</p>
                ) : stocksLoading ? (
                    <p className="text-muted">Loading...</p>
                ) : (
                    <div className="stock-table-container">
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
                                            <td>
                                                {s.changePercent != null ? (
                                                    <span className={`us-change-pill ${isPositive ? "positive" : "negative"}`}>
                                                        {formatPct(s.changePercent)}
                                                    </span>
                                                ) : (
                                                    <span className="text-muted">—</span>
                                                )}
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                )}
            </motion.div>

            {agentOffline && (
                <motion.div variants={fadeUpItem} className="glass-panel us-offline-panel">
                    <div className="us-offline-head">
                        <AlertTriangle size={18} />
                        US agent isn't running
                    </div>
                    <p className="text-muted us-offline-detail">
                        Start it with <code>./us_agent/run_us.sh</code>, then refresh this page.
                    </p>
                </motion.div>
            )}

            {!agentOffline && (
                <motion.div variants={fadeUpItem} className="glass-panel us-panel">
                    <h2 className="us-panel-title">Paper Positions</h2>
                    {loadingPositions ? (
                        <p className="text-muted">Loading...</p>
                    ) : positions?.positions?.length ? (
                        <div className="stock-table-container">
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
                                            <td className="stock-symbol">{pos.symbol}</td>
                                            <td className="stock-name">{pos.side}</td>
                                            <td className="stock-price">{pos.quantity}</td>
                                            <td className="stock-price">{formatUsd(pos.entry_price)}</td>
                                            <td className="stock-price">{formatUsd(pos.current_price)}</td>
                                            <td>
                                                {pos.pnl == null ? (
                                                    <span className="text-muted">—</span>
                                                ) : (
                                                    <span className={`us-change-pill ${pos.pnl > 0 ? "positive" : pos.pnl < 0 ? "negative" : ""}`}>
                                                        {formatUsd(pos.pnl)}
                                                    </span>
                                                )}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    ) : (
                        <div className="us-empty-state">No open positions yet. A prediction becomes a position once you act on it.</div>
                    )}
                </motion.div>
            )}
        </motion.div>
    );
};

export default UsMarkets;
