import { useState, useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useMarket } from "../context/MarketContext.jsx";
import { useToast } from "../context/ToastContext.jsx";
import api from "../services/api.js";
import { formatRupees } from "../utils/format.js";
import { staggerContainer, fadeUpItem } from "../utils/motionVariants.js";

import { motion } from "framer-motion";
import { Search, ArrowUpDown, ArrowUp, ArrowDown, ExternalLink, TrendingUp, TrendingDown, Activity, Zap } from "lucide-react";

const formatVolume = (vol) => {
    if (vol == null || vol === 0) return "—";
    if (vol >= 10000000) return (vol / 10000000).toFixed(2) + " Cr";
    if (vol >= 100000) return (vol / 100000).toFixed(2) + " L";
    if (vol >= 1000) return (vol / 1000).toFixed(1) + " K";
    return vol.toLocaleString("en-IN");
};

const Dashboard = () => {
    const { prices } = useMarket();
    const navigate = useNavigate();
    const [search, setSearch] = useState("");
    const [sortBy, setSortBy] = useState("symbol");
    const [sortDir, setSortDir] = useState("asc");
    const [stockList, setStockList] = useState([]);
    const { addToast } = useToast();

    useEffect(() => {
        api.get("/stocks")
            .then((res) => setStockList(res.data.map((s) => ({
                symbol: s.symbol,
                name: s.name,
                price: s.price,
                change: s.change,
                changePercent: s.changePercent,
                volume: s.volume,
            }))))
            .catch(() => addToast("Failed to load stock list", "error"));
    }, [addToast]);

    const formatPrice = (price) => (price ? formatRupees(price) : "—");

    const filteredStocks = useMemo(() => {
        let result = stockList.filter(
            (s) =>
                s.symbol.toLowerCase().includes(search.toLowerCase()) ||
                s.name.toLowerCase().includes(search.toLowerCase())
        );

        result.sort((a, b) => {
            if (sortBy === "symbol") {
                return sortDir === "asc"
                    ? a.symbol.localeCompare(b.symbol)
                    : b.symbol.localeCompare(a.symbol);
            }
            if (sortBy === "price") {
                const priceA = prices[a.symbol]?.price || a.price || 0;
                const priceB = prices[b.symbol]?.price || b.price || 0;
                return sortDir === "asc" ? priceA - priceB : priceB - priceA;
            }
            if (sortBy === "change") {
                // sort on the same value the column displays (% change)
                const changeA = prices[a.symbol]?.changePercent ?? a.changePercent ?? 0;
                const changeB = prices[b.symbol]?.changePercent ?? b.changePercent ?? 0;
                return sortDir === "asc" ? changeA - changeB : changeB - changeA;
            }
            return 0;
        });

        return result;
    }, [search, sortBy, sortDir, prices, stockList]);

    const movers = useMemo(() => {
        if (!prices) return { gainers: [], losers: [], active: [] };

        const stocksWithData = stockList.map(s => {
            const p = prices[s.symbol];
            return {
                ...s,
                price: p?.price || s.price || 0,
                change: p?.change || s.change || 0,
                changePercent: p?.changePercent ?? s.changePercent ?? p?.change ?? 0,
                volume: p?.volume || s.volume || 0
            };
        }).filter(s => s.price > 0 && s.change !== 0);

        const sorted = [...stocksWithData].sort((a, b) => b.changePercent - a.changePercent);
        const sortedByVolume = [...stocksWithData].sort((a, b) => b.volume - a.volume);
        
        return {
            gainers: sorted.filter(s => s.changePercent > 0).slice(0, 4),
            losers: sorted.filter(s => s.changePercent < 0).reverse().slice(0, 4),
            active: sortedByVolume.slice(0, 4),
        };
    }, [prices, stockList]);

    const handleSort = (col) => {
        if (sortBy === col) {
            setSortDir(sortDir === "asc" ? "desc" : "asc");
        } else {
            setSortBy(col);
            setSortDir("asc");
        }
    };

    const getSortIcon = (col) => {
        if (sortBy !== col) return <ArrowUpDown size={14} className="sort-icon inactive" />;
        return sortDir === "asc" ? <ArrowUp size={14} className="sort-icon active" /> : <ArrowDown size={14} className="sort-icon active" />;
    };

    const containerVariants = staggerContainer;
    const itemVariants = fadeUpItem;

    return (
        <motion.div
            className="dashboard"
            initial={{ opacity: 0, y: 15 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, ease: "easeOut" }}
        >
            <div className="dashboard-header">
                <h1>Markets</h1>
                <div className="search-bar">
                    <Search size={16} className="search-icon" />
                    <input
                        type="text"
                        placeholder="Search stocks..."
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                    />
                </div>
            </div>

            {(movers.gainers.length > 0 || movers.losers.length > 0 || movers.active.length > 0) && (
                <div className="movers-section">
                    <h2 className="section-title"><Activity className="text-accent" style={{ color: "var(--accent)" }}/> Market Movers</h2>
                    
                    <div className="movers-grid">
                        {movers.gainers.length > 0 && (
                            <motion.div className="movers-list glass-panel" variants={containerVariants} initial="hidden" animate="show">
                                <h3 style={{ color: "var(--green)" }}><TrendingUp size={20} /> Top Gainers</h3>
                                <div className="movers-cards">
                                    {movers.gainers.map((s) => (
                                        <motion.div variants={itemVariants} key={s.symbol} className="mover-card" onClick={() => navigate(`/stock/${s.symbol}`)}>
                                            <div className="mover-info">
                                                <span className="mover-symbol">{s.symbol}</span>
                                                <span className="mover-price">{formatPrice(s.price)}</span>
                                            </div>
                                            <div className="mover-change positive">
                                                <span className="mover-change-percent">+{s.changePercent.toFixed(2)}%</span>
                                                <span className="mover-change-abs">+{formatPrice(s.change)}</span>
                                            </div>
                                        </motion.div>
                                    ))}
                                </div>
                            </motion.div>
                        )}
                        
                        {movers.losers.length > 0 && (
                            <motion.div className="movers-list glass-panel" variants={containerVariants} initial="hidden" animate="show">
                                <h3 style={{ color: "var(--red)" }}><TrendingDown size={20} /> Top Losers</h3>
                                <div className="movers-cards">
                                    {movers.losers.map((s) => (
                                        <motion.div variants={itemVariants} key={s.symbol} className="mover-card" onClick={() => navigate(`/stock/${s.symbol}`)}>
                                            <div className="mover-info">
                                                <span className="mover-symbol">{s.symbol}</span>
                                                <span className="mover-price">{formatPrice(s.price)}</span>
                                            </div>
                                            <div className="mover-change negative">
                                                <span className="mover-change-percent">{s.changePercent.toFixed(2)}%</span>
                                                <span className="mover-change-abs">{formatPrice(Math.abs(s.change))}</span>
                                            </div>
                                        </motion.div>
                                    ))}
                                </div>
                            </motion.div>
                        )}

                        {movers.active.length > 0 && (
                            <motion.div className="movers-list glass-panel" variants={containerVariants} initial="hidden" animate="show">
                                <h3 style={{ color: "var(--yellow)" }}><Zap size={20} /> Most Active</h3>
                                <div className="movers-cards">
                                    {movers.active.map((s) => (
                                        <motion.div variants={itemVariants} key={s.symbol} className="mover-card" onClick={() => navigate(`/stock/${s.symbol}`)}>
                                            <div className="mover-info">
                                                <span className="mover-symbol">{s.symbol}</span>
                                                <span className="mover-price">{formatPrice(s.price)}</span>
                                            </div>
                                            <div className="mover-change" style={{ color: "var(--text-primary)" }}>
                                                <span className="mover-change-percent">{formatVolume(s.volume)}</span>
                                                <span className="mover-change-abs">Vol</span>
                                            </div>
                                        </motion.div>
                                    ))}
                                </div>
                            </motion.div>
                        )}
                    </div>
                </div>
            )}

            <div className="stock-table-container">
                <table className="stock-table">
                    <thead>
                        <tr>
                            <th onClick={() => handleSort("symbol")} className="sortable">
                                <span className="th-content">Symbol {getSortIcon("symbol")}</span>
                            </th>
                            <th>Company</th>
                            <th onClick={() => handleSort("price")} className="sortable">
                                <span className="th-content">Price {getSortIcon("price")}</span>
                            </th>
                            <th onClick={() => handleSort("change")} className="sortable">
                                <span className="th-content">Change {getSortIcon("change")}</span>
                            </th>
                            <th>Action</th>
                        </tr>
                    </thead>
                    <motion.tbody
                        variants={containerVariants}
                        initial="hidden"
                        animate="show"
                    >
                        {filteredStocks.map((stock) => {
                            const live = prices[stock.symbol];
                            const price = live?.price || stock.price || null;
                            const changePercent = live?.changePercent ?? stock.changePercent ?? 0;
                            const data = price != null ? { price } : null;
                            const isPositive = changePercent >= 0;

                            return (
                                <motion.tr
                                    variants={itemVariants}
                                    key={stock.symbol}
                                    className="stock-row"
                                    onClick={() => navigate(`/stock/${stock.symbol}`)}
                                >
                                    <td className="stock-symbol">{stock.symbol}</td>
                                    <td className="stock-name">{stock.name}</td>
                                    <td className="stock-price">
                                        {data ? formatPrice(data.price) : "—"}
                                    </td>
                                    <td className={`stock-change ${isPositive ? "positive" : "negative"}`}>
                                        {data ? `${isPositive ? "+" : ""}${changePercent.toFixed(2)}%` : "—"}
                                    </td>
                                    <td>
                                        <button
                                            className="btn-trade"
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                navigate(`/stock/${stock.symbol}`);
                                            }}
                                        >
                                            <ExternalLink size={14} /> Trade
                                        </button>
                                    </td>
                                </motion.tr>
                            );
                        })}
                    </motion.tbody>
                </table>
            </div>
        </motion.div>
    );
};

export default Dashboard;
