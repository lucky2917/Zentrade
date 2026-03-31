import { useState, useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useMarket } from "../context/MarketContext.jsx";
import api from "../services/api.js";

const STOCK_LIST = [
    { symbol: "RELIANCE", name: "Reliance Industries" },
    { symbol: "TCS", name: "Tata Consultancy Services" },
    { symbol: "HDFCBANK", name: "HDFC Bank" },
    { symbol: "INFY", name: "Infosys" },
    { symbol: "ICICIBANK", name: "ICICI Bank" },
    { symbol: "HINDUNILVR", name: "Hindustan Unilever" },
    { symbol: "SBIN", name: "State Bank of India" },
    { symbol: "BHARTIARTL", name: "Bharti Airtel" },
    { symbol: "ITC", name: "ITC" },
    { symbol: "KOTAKBANK", name: "Kotak Mahindra Bank" },
    { symbol: "LT", name: "Larsen & Toubro" },
    { symbol: "HCLTECH", name: "HCL Technologies" },
    { symbol: "AXISBANK", name: "Axis Bank" },
    { symbol: "ASIANPAINT", name: "Asian Paints" },
    { symbol: "MARUTI", name: "Maruti Suzuki" },
    { symbol: "SUNPHARMA", name: "Sun Pharmaceutical" },
    { symbol: "TITAN", name: "Titan Company" },
    { symbol: "BAJFINANCE", name: "Bajaj Finance" },
    { symbol: "DMART", name: "Avenue Supermarts" },
    { symbol: "WIPRO", name: "Wipro" },
    { symbol: "ULTRACEMCO", name: "UltraTech Cement" },
    { symbol: "ONGC", name: "Oil & Natural Gas Corp" },
    { symbol: "NTPC", name: "NTPC" },
    { symbol: "TATAMOTORS", name: "Tata Motors" },
    { symbol: "TATASTEEL", name: "Tata Steel" },
    { symbol: "POWERGRID", name: "Power Grid Corp" },
    { symbol: "M&M", name: "Mahindra & Mahindra" },
    { symbol: "JSWSTEEL", name: "JSW Steel" },
    { symbol: "ADANIENT", name: "Adani Enterprises" },
    { symbol: "ADANIPORTS", name: "Adani Ports" },
    { symbol: "TECHM", name: "Tech Mahindra" },
    { symbol: "HDFCLIFE", name: "HDFC Life Insurance" },
    { symbol: "BAJAJFINSV", name: "Bajaj Finserv" },
    { symbol: "SBILIFE", name: "SBI Life Insurance" },
    { symbol: "GRASIM", name: "Grasim Industries" },
    { symbol: "DIVISLAB", name: "Divi's Laboratories" },
    { symbol: "DRREDDY", name: "Dr. Reddy's Labs" },
    { symbol: "CIPLA", name: "Cipla" },
    { symbol: "EICHERMOT", name: "Eicher Motors" },
    { symbol: "APOLLOHOSP", name: "Apollo Hospitals" },
    { symbol: "COALINDIA", name: "Coal India" },
    { symbol: "BPCL", name: "Bharat Petroleum" },
    { symbol: "BRITANNIA", name: "Britannia Industries" },
    { symbol: "NESTLEIND", name: "Nestle India" },
    { symbol: "TATACONSUM", name: "Tata Consumer Products" },
    { symbol: "HEROMOTOCO", name: "Hero MotoCorp" },
    { symbol: "INDUSINDBK", name: "IndusInd Bank" },
    { symbol: "HINDALCO", name: "Hindalco Industries" },
    { symbol: "UPL", name: "UPL" },
];

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

    const formatPrice = (price) => {
        if (!price) return "—";
        return new Intl.NumberFormat("en-IN", {
            style: "currency",
            currency: "INR",
            maximumFractionDigits: 2,
        }).format(price);
    };

    const filteredStocks = useMemo(() => {
        let result = STOCK_LIST.filter(
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
                const priceA = prices[a.symbol]?.price || 0;
                const priceB = prices[b.symbol]?.price || 0;
                return sortDir === "asc" ? priceA - priceB : priceB - priceA;
            }
            if (sortBy === "change") {
                const changeA = prices[a.symbol]?.change || 0;
                const changeB = prices[b.symbol]?.change || 0;
                return sortDir === "asc" ? changeA - changeB : changeB - changeA;
            }
            return 0;
        });

        return result;
    }, [search, sortBy, sortDir, prices]);

    const movers = useMemo(() => {
        if (!prices) return { gainers: [], losers: [], active: [] };
        
        const stocksWithData = STOCK_LIST.map(s => {
            const p = prices[s.symbol];
            return {
                ...s,
                price: p?.price || 0,
                change: p?.change || 0,
                changePercent: p?.changePercent ?? p?.change ?? 0,
                volume: p?.volume || 0
            };
        }).filter(s => s.price > 0 && s.change !== 0);

        const sorted = [...stocksWithData].sort((a, b) => b.changePercent - a.changePercent);
        const sortedByVolume = [...stocksWithData].sort((a, b) => b.volume - a.volume);
        
        return {
            gainers: sorted.filter(s => s.changePercent > 0).slice(0, 4),
            losers: sorted.filter(s => s.changePercent < 0).reverse().slice(0, 4),
            active: sortedByVolume.slice(0, 4),
        };
    }, [prices]);

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

    const containerVariants = {
        hidden: { opacity: 0 },
        show: {
            opacity: 1,
            transition: {
                staggerChildren: 0.05
            }
        }
    };

    const itemVariants = {
        hidden: { opacity: 0, y: 10 },
        show: { opacity: 1, y: 0, transition: { type: "spring", stiffness: 300, damping: 24 } }
    };

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
                            const data = prices[stock.symbol];
                            const change = data?.change || 0;
                            const isPositive = change >= 0;

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
                                        {data ? `${isPositive ? "+" : ""}${change.toFixed(2)}%` : "—"}
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

/*
 * main dashboard page. shows the market movers section at the top
 * with top gainers, losers, and most active by volume. below that
 * is the full stock table which you can search and sort. clicking
 * any row or card takes you to that stock's detail page. all the
 * price data comes from MarketContext which updates via websocket.
 */
