import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import api from "../services/api.js";
import { useAuth } from "../context/AuthContext.jsx";
import { useGoogleLogin } from "@react-oauth/google";
import { useToast } from "../context/ToastContext.jsx";
import { motion } from "framer-motion";
import { Briefcase, TrendingUp, TrendingDown, ExternalLink, Activity, FolderOpen } from "lucide-react";

const Portfolio = () => {
    const [portfolio, setPortfolio] = useState(null);
    const [loading, setLoading] = useState(true);
    const [activeTab, setActiveTab] = useState("INTRADAY");
    const { token, googleLogin } = useAuth();
    const { addToast } = useToast();
    const navigate = useNavigate();

    const handleGoogleAuth = useGoogleLogin({
        flow: "implicit",
        onSuccess: async (tokenResponse) => {
            try {
                await googleLogin(tokenResponse.access_token);
                addToast("Logged in successfully", "success");
            } catch (err) {
                addToast(err.response?.data?.error || "Login failed", "error");
            }
        },
        onError: () => {
            addToast("Login cancelled", "error");
        },
    });

    const fetchPortfolio = async () => {
        if (!token) {
            setLoading(false);
            return;
        }
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

    if (!token) {
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
                <div className="empty-state glass-panel" style={{ marginTop: "2rem" }}>
                    <Briefcase size={48} className="empty-icon text-muted mb-4" style={{ color: 'var(--text-muted)' }} />
                    <h2 style={{ marginBottom: "1rem" }}>Login Required</h2>
                    <p style={{ color: 'var(--text-muted)', marginBottom: "1.5rem" }}>You must be logged in to view and manage your portfolio.</p>
                    <button className="btn-login-google" style={{ margin: "0 auto", padding: "0.6rem 1.2rem" }} onClick={() => handleGoogleAuth()}>
                        <svg viewBox="0 0 24 24" width="18" height="18" style={{ marginRight: '8px' }}>
                            <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/>
                            <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                            <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                            <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                        </svg>
                        <span style={{ fontSize: "1rem" }}>Continue with Google</span>
                    </button>
                </div>
            </motion.div>
        );
    }

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
