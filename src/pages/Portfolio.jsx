import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import api from "../services/api.js";
import { motion } from "framer-motion";
import { Briefcase, TrendingUp, TrendingDown, ExternalLink, Activity, FolderOpen } from "lucide-react";

const Portfolio = () => {
    const [portfolio, setPortfolio] = useState(null);
    const [loading, setLoading] = useState(true);
    const [activeTab, setActiveTab] = useState("INTRADAY");
    const navigate = useNavigate();

    const fetchPortfolio = async () => {
        try {
            const res = await api.get("/portfolio");
            setPortfolio(res.data);
        } catch (err) {
            console.error("Portfolio fetch failed");
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchPortfolio();
        const interval = setInterval(fetchPortfolio, 5000);
        return () => clearInterval(interval);
    }, []);

    const formatCurrency = (paise) => {
        return new Intl.NumberFormat("en-IN", {
            style: "currency",
            currency: "INR",
            maximumFractionDigits: 2,
        }).format(paise / 100);
    };

    if (loading) {
        return <div className="loading-screen">Loading portfolio...</div>;
    }

    if (!portfolio) {
        return <div className="loading-screen">Failed to load portfolio</div>;
    }

    const totalPnl = portfolio.totalPnlPaise;
    const isPnlPositive = totalPnl >= 0;

    const containerVariants = {
        hidden: { opacity: 0 },
        show: {
            opacity: 1,
            transition: { staggerChildren: 0.05 }
        }
    };

    const itemVariants = {
        hidden: { opacity: 0, scale: 0.95, y: 10 },
        show: { opacity: 1, scale: 1, y: 0, transition: { type: "spring", stiffness: 300, damping: 24 } }
    };

    const activeHoldings = activeTab === "INTRADAY"
        ? portfolio.intradayHoldings
        : portfolio.deliveryHoldings;

    const intradayCount = portfolio.intradayHoldings?.length || 0;
    const deliveryCount = portfolio.deliveryHoldings?.length || 0;

    const renderHoldingsTable = (holdings, isIntraday) => {
        if (!holdings || holdings.length === 0) {
            return (
                <motion.div
                    initial={{ opacity: 0, scale: 0.9 }}
                    animate={{ opacity: 1, scale: 1 }}
                    className="empty-state glass-panel"
                >
                    <FolderOpen size={48} className="empty-icon text-muted mb-4" style={{ color: 'var(--text-muted)' }} />
                    <h3>No {isIntraday ? "Intraday" : "Delivery"} Holdings</h3>
                    <p>{isIntraday ? "Your leveraged positions will show here." : "Start investing for long-term holdings!"}</p>
                    <button className="btn-primary mt-4" onClick={() => navigate("/")}>
                        <Activity size={18} className="inline mr-2" /> Browse Markets
                    </button>
                </motion.div>
            );
        }

        return (
            <div className="holdings-table-container glass-panel">
                <table className="holdings-table stock-table">
                    <thead>
                        <tr>
                            <th>Symbol</th>
                            <th>Qty</th>
                            <th>Avg Price</th>
                            <th>Current Price</th>
                            <th>{isIntraday ? "Margin Used" : "Invested"}</th>
                            <th>Current Value</th>
                            <th>P&L</th>
                            <th>Action</th>
                        </tr>
                    </thead>
                    <motion.tbody variants={containerVariants} initial="hidden" animate="show">
                        {holdings.map((h) => {
                            const pnl = h.pnlPaise;
                            const isPosH = pnl >= 0;
                            return (
                                <motion.tr variants={itemVariants} key={h.symbol + h.orderMode} className="stock-row" onClick={() => navigate(`/stock/${h.symbol}`)}>
                                    <td className="stock-symbol">
                                        {h.symbol}
                                        <span className={`mode-badge ${isIntraday ? "badge-mis" : "badge-cnc"}`}>
                                            {isIntraday ? "MIS" : "CNC"}
                                        </span>
                                    </td>
                                    <td>{h.quantity}</td>
                                    <td>{formatCurrency(h.avgPricePaise)}</td>
                                    <td>{formatCurrency(h.currentPricePaise)}</td>
                                    <td>{formatCurrency(isIntraday ? h.marginUsedPaise : h.investedPaise)}</td>
                                    <td>{formatCurrency(h.currentValuePaise)}</td>
                                    <td className={isPosH ? "positive" : "negative"}>
                                        {isPosH ? "+" : ""}{formatCurrency(pnl)}
                                    </td>
                                    <td>
                                        <button
                                            className="btn-trade"
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                navigate(`/stock/${h.symbol}`);
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
        );
    };

    return (
        <motion.div
            className="portfolio-page main-content"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, ease: "easeOut" }}
        >
            <div className="dashboard-header">
                <h1><Briefcase size={28} className="mr-3 inline text-accent" style={{ color: 'var(--accent)' }} /> Portfolio</h1>
            </div>

            <motion.div className="portfolio-summary" variants={containerVariants} initial="hidden" animate="show">
                <motion.div variants={itemVariants} className="summary-card glass-panel">
                    <span className="summary-label">Available Balance</span>
                    <span className="summary-value">{formatCurrency(portfolio.balancePaise)}</span>
                </motion.div>
                <motion.div variants={itemVariants} className="summary-card glass-panel">
                    <span className="summary-label">Invested Value</span>
                    <span className="summary-value">{formatCurrency(portfolio.totalInvestedPaise)}</span>
                </motion.div>
                <motion.div variants={itemVariants} className="summary-card glass-panel">
                    <span className="summary-label">Current Value</span>
                    <span className="summary-value">{formatCurrency(portfolio.totalCurrentPaise)}</span>
                </motion.div>
                <motion.div variants={itemVariants} className={`summary-card glass-panel ${isPnlPositive ? "pnl-positive" : "pnl-negative"}`}>
                    <span className="summary-label">Total P&L</span>
                    <span className="summary-value flex items-center gap-1">
                        {isPnlPositive ? <TrendingUp size={20} /> : <TrendingDown size={20} />}
                        {isPnlPositive ? "+" : ""}{formatCurrency(totalPnl)}
                    </span>
                </motion.div>
            </motion.div>

            <div className="portfolio-tabs">
                <button
                    className={`portfolio-tab ${activeTab === "INTRADAY" ? "active-tab" : ""}`}
                    onClick={() => setActiveTab("INTRADAY")}
                >
                    Intraday (MIS)
                    {intradayCount > 0 && <span className="tab-count">{intradayCount}</span>}
                </button>
                <button
                    className={`portfolio-tab ${activeTab === "DELIVERY" ? "active-tab" : ""}`}
                    onClick={() => setActiveTab("DELIVERY")}
                >
                    Delivery (CNC)
                    {deliveryCount > 0 && <span className="tab-count">{deliveryCount}</span>}
                </button>
            </div>

            {renderHoldingsTable(activeHoldings, activeTab === "INTRADAY")}
        </motion.div>
    );
};

export default Portfolio;

/*
 * portfolio page with tabbed view for intraday and delivery
 * holdings. intraday tab shows leveraged positions with the
 * margin used column — these get auto squared off at 15:25 IST.
 * delivery tab shows full-payment long-term holdings with the
 * invested amount column. each holding shows a MIS or CNC badge
 * next to the symbol. summary cards at the top still show the
 * combined balance, invested value, current value, and total pnl
 * across both modes. fetches from /api/portfolio every 5 seconds.
 */
