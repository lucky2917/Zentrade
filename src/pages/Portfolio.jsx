import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import api from "../services/api.js";
import { useAuth } from "../context/AuthContext.jsx";
import { useGoogleLogin } from "@react-oauth/google";
import { useToast } from "../context/ToastContext.jsx";
import { useMarket } from "../context/MarketContext.jsx";
import { motion } from "framer-motion";
import { Briefcase, TrendingUp, TrendingDown, ExternalLink, Activity, FolderOpen, PieChart, Star, AlertTriangle } from "lucide-react";

const Portfolio = () => {
    const [portfolio, setPortfolio] = useState(null);
    const [loading, setLoading] = useState(true);
    const [activeTab, setActiveTab] = useState("INTRADAY");
    const [sortConfig, setSortConfig] = useState({ key: 'pnlPaise', direction: 'desc' });
    const { token, googleLogin } = useAuth();
    const { addToast } = useToast();
    const { prices } = useMarket();
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

    // Advanced Portfolio Processing
    const enrichHoldings = (holdings) => {
        if (!holdings) return [];
        return holdings.map(h => {
            const liveObj = prices[h.symbol];
            const currentPricePaise = liveObj ? Math.round(liveObj.price * 100) : h.currentPricePaise;
            const liveChangePaise = liveObj ? Math.round(liveObj.change * 100) : 0;
            
            const currentValuePaise = currentPricePaise * h.quantity;
            const investedPaise = h.investedPaise;
            const pnlPaise = currentValuePaise - investedPaise;
            const pnlPercent = investedPaise > 0 ? (pnlPaise / investedPaise) * 100 : 0;
            const dayPnlPaise = liveChangePaise * h.quantity;
            
            return {
                ...h,
                currentPricePaise,
                currentValuePaise,
                pnlPaise,
                pnlPercent,
                dayPnlPaise
            };
        });
    };

    const intradayHoldings = enrichHoldings(portfolio?.intradayHoldings);
    const deliveryHoldings = enrichHoldings(portfolio?.deliveryHoldings);
    const allHoldings = [...intradayHoldings, ...deliveryHoldings];

    const liveTotalCurrent = allHoldings.reduce((acc, h) => acc + h.currentValuePaise, 0);
    const liveTotalInvested = allHoldings.reduce((acc, h) => acc + h.investedPaise, 0);
    const liveTotalPnl = liveTotalCurrent - liveTotalInvested;
    const liveDayPnl = allHoldings.reduce((acc, h) => acc + h.dayPnlPaise, 0);

    const isPnlPositive = liveTotalPnl >= 0;
    const isDayPnlPositive = liveDayPnl >= 0;

    // Advanced Sorting metrics
    const sortedByPercent = [...allHoldings].sort((a, b) => b.pnlPercent - a.pnlPercent);
    const bestPerformer = sortedByPercent.length > 0 && sortedByPercent[0].pnlPercent > 0 ? sortedByPercent[0] : null;
    const worstPerformer = sortedByPercent.length > 0 && sortedByPercent[sortedByPercent.length - 1].pnlPercent < 0 ? sortedByPercent[sortedByPercent.length - 1] : null;

    const activeHoldings = activeTab === "INTRADAY" ? intradayHoldings : deliveryHoldings;

    const requestSort = (key) => {
        let direction = 'desc';
        if (sortConfig.key === key && sortConfig.direction === 'desc') {
            direction = 'asc';
        }
        setSortConfig({ key, direction });
    };

    const sortedHoldings = [...activeHoldings].sort((a, b) => {
        if (a[sortConfig.key] < b[sortConfig.key]) {
            return sortConfig.direction === 'asc' ? -1 : 1;
        }
        if (a[sortConfig.key] > b[sortConfig.key]) {
            return sortConfig.direction === 'asc' ? 1 : -1;
        }
        return 0;
    });

    const getSortIndicator = (key) => {
        if (sortConfig.key !== key) return null;
        return <span className="sort-arrow">{sortConfig.direction === 'asc' ? '↑' : '↓'}</span>;
    };

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

    const intradayCount = intradayHoldings?.length || 0;
    const deliveryCount = deliveryHoldings?.length || 0;

    const renderAllocationBar = () => {
        if (allHoldings.length === 0) return null;
        
        const byValue = [...allHoldings].sort((a, b) => b.currentValuePaise - a.currentValuePaise);
        const colors = ['#3b82f6', '#10b981', '#8b5cf6', '#f59e0b', '#ec4899', '#64748b'];
        
        return (
            <motion.div variants={itemVariants} className="allocation-section glass-panel" style={{ marginTop: '1.5rem', marginBottom: '2rem', padding: '1.5rem' }}>
                <h3 style={{ fontSize: '1rem', marginBottom: '1.25rem', display: 'flex', alignItems: 'center' }}>
                    <PieChart size={18} className="mr-2" style={{ color: 'var(--accent)' }}/> Asset Allocation
                </h3>
                <div className="allocation-bar-wrapper" style={{ display: 'flex', height: '14px', borderRadius: '8px', overflow: 'hidden', marginBottom: '1.25rem', backgroundColor: 'var(--bg-secondary)' }}>
                    {byValue.map((h, i) => {
                        const width = (h.currentValuePaise / liveTotalCurrent) * 100;
                        return (
                            <div 
                                key={h.symbol}
                                title={`${h.symbol}: ${width.toFixed(1)}%`}
                                style={{ 
                                    width: `${width}%`, 
                                    backgroundColor: colors[i % colors.length],
                                    transition: 'width 0.5s ease',
                                    borderRight: i < byValue.length - 1 ? '2px solid var(--bg-card)' : 'none'
                                }}
                            />
                        );
                    })}
                </div>
                <div className="allocation-legend" style={{ display: 'flex', flexWrap: 'wrap', gap: '1.25rem', fontSize: '0.85rem' }}>
                    {byValue.slice(0, 5).map((h, i) => (
                        <div key={h.symbol} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                            <span style={{ width: '10px', height: '10px', borderRadius: '50%', backgroundColor: colors[i % colors.length] }} />
                            <span style={{ color: 'var(--text-muted)' }}>{h.symbol}</span>
                            <span style={{ fontWeight: '600' }}>{((h.currentValuePaise / liveTotalCurrent) * 100).toFixed(1)}%</span>
                        </div>
                    ))}
                    {byValue.length > 5 && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                            <span style={{ width: '10px', height: '10px', borderRadius: '50%', backgroundColor: colors[5] }} />
                            <span style={{ color: 'var(--text-muted)' }}>Others</span>
                        </div>
                    )}
                </div>
            </motion.div>
        );
    };

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
                <table className="holdings-table stock-table advanced-table">
                    <thead>
                        <tr>
                            <th onClick={() => requestSort('symbol')} className="sortable">Symbol {getSortIndicator('symbol')}</th>
                            <th onClick={() => requestSort('quantity')} className="sortable">Qty {getSortIndicator('quantity')}</th>
                            <th>Avg Price</th>
                            <th>Current Price</th>
                            <th onClick={() => requestSort(isIntraday ? 'marginUsedPaise' : 'investedPaise')} className="sortable">{isIntraday ? "Margin Used" : "Invested"} {getSortIndicator(isIntraday ? 'marginUsedPaise' : 'investedPaise')}</th>
                            <th onClick={() => requestSort('currentValuePaise')} className="sortable">Current Value {getSortIndicator('currentValuePaise')}</th>
                            <th onClick={() => requestSort('dayPnlPaise')} className="sortable">Day P&L {getSortIndicator('dayPnlPaise')}</th>
                            <th onClick={() => requestSort('pnlPaise')} className="sortable">Total P&L {getSortIndicator('pnlPaise')}</th>
                            <th>Action</th>
                        </tr>
                    </thead>
                    <motion.tbody variants={containerVariants} initial="hidden" animate="show">
                        {holdings.map((h) => {
                            const pnl = h.pnlPaise;
                            const isPosH = pnl >= 0;
                            const isDayPos = h.dayPnlPaise >= 0;
                            
                            // Visual horizontal pnl indicators
                            const pnlAbsPercent = Math.abs(h.pnlPercent);
                            const barWidth = Math.min(100, Math.max(2, pnlAbsPercent));

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
                                    <td className={isDayPos ? "positive" : "negative"}>
                                        {isDayPos ? "+" : ""}{formatCurrency(h.dayPnlPaise)}
                                    </td>
                                    <td className={isPosH ? "positive" : "negative"}>
                                        <div>{isPosH ? "+" : ""}{formatCurrency(pnl)}</div>
                                        <div style={{ fontSize: '0.75rem', opacity: 0.85, marginTop: '2px', display: 'flex', alignItems: 'center' }}>
                                            ({isPosH ? "+" : ""}{h.pnlPercent.toFixed(2)}%)
                                            <div style={{ flex: 1, height: '3px', background: 'var(--bg-secondary)', marginLeft: '6px', borderRadius: '2px', overflow: 'hidden' }}>
                                                <div style={{ width: `${barWidth}%`, height: '100%', background: isPosH ? 'var(--green)' : 'var(--red)', transition: 'width 0.3s ease' }} />
                                            </div>
                                        </div>
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
                <h1><Briefcase size={28} className="mr-3 inline text-accent" style={{ color: 'var(--accent)' }} /> Advanced Portfolio</h1>
            </div>

            <motion.div className="portfolio-summary advanced" variants={containerVariants} initial="hidden" animate="show" style={{ 
                display: 'grid', 
                gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', 
                gap: '1rem', 
                marginBottom: '1.5rem' 
            }}>
                <motion.div variants={itemVariants} className="summary-card glass-panel">
                    <span className="summary-label">Available Balance</span>
                    <span className="summary-value">{formatCurrency(portfolio.balancePaise)}</span>
                </motion.div>
                <motion.div variants={itemVariants} className="summary-card glass-panel">
                    <span className="summary-label">Current Value</span>
                    <span className="summary-value">{formatCurrency(liveTotalCurrent)}</span>
                </motion.div>
                <motion.div variants={itemVariants} className={`summary-card glass-panel ${isDayPnlPositive ? "pnl-positive" : "pnl-negative"}`}>
                    <span className="summary-label">1D Return (Live)</span>
                    <span className="summary-value flex items-center gap-1">
                        {isDayPnlPositive ? <TrendingUp size={20} /> : <TrendingDown size={20} />}
                        {isDayPnlPositive ? "+" : ""}{formatCurrency(liveDayPnl)}
                    </span>
                </motion.div>
                <motion.div variants={itemVariants} className={`summary-card glass-panel ${isPnlPositive ? "pnl-positive" : "pnl-negative"}`}>
                    <span className="summary-label">Total Return</span>
                    <span className="summary-value flex items-center gap-1">
                        {isPnlPositive ? <TrendingUp size={20} /> : <TrendingDown size={20} />}
                        {isPnlPositive ? "+" : ""}{formatCurrency(liveTotalPnl)}
                    </span>
                    {liveTotalInvested > 0 && <span style={{ fontSize: '0.8rem', marginTop: '0.2rem', opacity: 0.8 }}>({isPnlPositive ? "+" : ""}{((liveTotalPnl / liveTotalInvested) * 100).toFixed(2)}%)</span>}
                </motion.div>
                
                {bestPerformer && (
                    <motion.div variants={itemVariants} className="summary-card glass-panel pnl-positive" style={{ background: 'rgba(16, 185, 129, 0.05)', borderColor: 'rgba(16, 185, 129, 0.2)' }}>
                        <span className="summary-label flex items-center gap-1"><Star size={14}/> Top Gainer</span>
                        <span className="summary-value" style={{ fontSize: '1.25rem' }}>{bestPerformer.symbol}</span>
                        <span style={{ fontSize: '0.85rem', marginTop: '0.2rem' }}>+{bestPerformer.pnlPercent.toFixed(2)}%</span>
                    </motion.div>
                )}
                {worstPerformer && (
                    <motion.div variants={itemVariants} className="summary-card glass-panel pnl-negative" style={{ background: 'rgba(239, 68, 68, 0.05)', borderColor: 'rgba(239, 68, 68, 0.2)' }}>
                        <span className="summary-label flex items-center gap-1"><AlertTriangle size={14}/> Top Loser</span>
                        <span className="summary-value" style={{ fontSize: '1.25rem' }}>{worstPerformer.symbol}</span>
                        <span style={{ fontSize: '0.85rem', marginTop: '0.2rem' }}>{worstPerformer.pnlPercent.toFixed(2)}%</span>
                    </motion.div>
                )}
            </motion.div>

            {renderAllocationBar()}

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

            {renderHoldingsTable(sortedHoldings, activeTab === "INTRADAY")}
        </motion.div>
    );
};

export default Portfolio;

/*
 * advanced portfolio page with deep analytics.
 * connects to live MarketContext to compute 1D returns in real-time.
 * adds visual asset allocation bar, best/worst performance tracking,
 * and robust sortable columns for deep dive into portfolio data.
 * intraday/delivery tabs isolate margin and leveraged holdings.
 * ui upgraded with inline databars for profit/loss visualizing.
 */

