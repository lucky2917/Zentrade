import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import api from "../services/api.js";
import { useAuth } from "../context/AuthContext.jsx";
import { useGoogleLogin } from "@react-oauth/google";
import { useToast } from "../context/ToastContext.jsx";
import { motion } from "framer-motion";
import { Star, TrendingUp, TrendingDown, ExternalLink, Trash2, Activity } from "lucide-react";
import { useMarket } from "../context/MarketContext.jsx";

const Watchlist = () => {
    const [watchlist, setWatchlist] = useState([]);
    const [loading, setLoading] = useState(true);
    const { token, googleLogin } = useAuth();
    const { addToast } = useToast();
    const navigate = useNavigate();
    const { prices } = useMarket();

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

    const fetchWatchlist = async () => {
        if (!token) {
            setLoading(false);
            return;
        }
        try {
            const res = await api.get("/watchlist");
            setWatchlist(res.data);
        } catch (err) {
            console.error("Watchlist fetch failed");
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchWatchlist();
    }, []);

    const removeFromWatchlist = async (e, symbol) => {
        e.stopPropagation();
        try {
            await api.delete("/watchlist/remove", { data: { symbol } });
            setWatchlist(watchlist.filter(w => w.symbol !== symbol));
        } catch (err) {
            console.error("Failed to remove from watchlist");
        }
    };

    const formatPrice = (val) => {
        if (val == null) return "—";
        return new Intl.NumberFormat("en-IN", {
            style: "currency",
            currency: "INR",
            maximumFractionDigits: 2,
        }).format(val);
    };

    if (!token) {
        return (
            <motion.div
                className="watchlist-page main-content"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.4, ease: "easeOut" }}
            >
                <div className="dashboard-header">
                    <h1><Star size={28} className="mr-3 inline text-accent" style={{ color: 'var(--yellow)' }} /> Watchlist</h1>
                </div>
                <div className="empty-state glass-panel" style={{ marginTop: "2rem" }}>
                    <Star size={48} className="empty-icon text-muted mb-4" style={{ color: 'var(--text-muted)' }} />
                    <h2 style={{ marginBottom: "1rem" }}>Login Required</h2>
                    <p style={{ color: 'var(--text-muted)', marginBottom: "1.5rem" }}>You must be logged in to manage your watchlist.</p>
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
        return <div className="loading-screen">Loading watchlist...</div>;
    }

    const containerVariants = {
        hidden: { opacity: 0 },
        show: {
            opacity: 1,
            transition: { staggerChildren: 0.05 }
        }
    };

    const itemVariants = {
        hidden: { opacity: 0, y: 10 },
        show: { opacity: 1, y: 0, transition: { type: "spring", stiffness: 300, damping: 24 } }
    };

    return (
        <motion.div
            className="watchlist-page main-content"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, ease: "easeOut" }}
        >
            <div className="dashboard-header">
                <h1><Star size={28} className="mr-3 inline text-accent" style={{ color: 'var(--yellow)' }} /> Watchlist</h1>
            </div>

            {watchlist.length === 0 ? (
                <motion.div
                    initial={{ opacity: 0, scale: 0.9 }}
                    animate={{ opacity: 1, scale: 1 }}
                    className="empty-state glass-panel"
                >
                    <Star size={48} className="empty-icon text-muted mb-4" style={{ color: 'var(--text-muted)' }} />
                    <h3>Your Watchlist is Empty</h3>
                    <p>Keep track of stocks you're interested in.</p>
                    <button className="btn-primary mt-4" onClick={() => navigate("/")}>
                        <Activity size={18} className="inline mr-2" /> Browse Markets
                    </button>
                </motion.div>
            ) : (
                <div className="watchlist-table-container glass-panel">
                    <table className="watchlist-table stock-table">
                        <thead>
                            <tr>
                                <th>Symbol</th>
                                <th>Name</th>
                                <th>LTP</th>
                                <th>Change</th>
                                <th>Action</th>
                            </tr>
                        </thead>
                        <motion.tbody variants={containerVariants} initial="hidden" animate="show">
                            {watchlist.map((item) => {
                                const liveData = prices[item.symbol];
                                const currentPrice = liveData?.price || item.price;
                                const currentChange = liveData?.change || item.change || 0;
                                const currentChangePercent = liveData?.changePercent || item.changePercent || 0;
                                const isPositive = currentChangePercent >= 0;

                                return (
                                    <motion.tr variants={itemVariants} key={item.symbol} className="stock-row" onClick={() => navigate(`/stock/${item.symbol}`)}>
                                        <td className="stock-symbol">{item.symbol}</td>
                                        <td className="stock-name">{item.name}</td>
                                        <td className="stock-price">{formatPrice(currentPrice)}</td>
                                        <td className={`stock-change ${isPositive ? "positive" : "negative"}`}>
                                            <span className="flex items-center gap-1">
                                                {isPositive ? <TrendingUp size={14} /> : <TrendingDown size={14} />}
                                                {isPositive ? "+" : ""}{currentChangePercent.toFixed(2)}%
                                            </span>
                                        </td>
                                        <td>
                                            <div className="action-buttons flex gap-2">
                                                <button
                                                    className="btn-trade"
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        navigate(`/stock/${item.symbol}`);
                                                    }}
                                                >
                                                    <ExternalLink size={14} /> 
                                                </button>
                                                <button
                                                    className="btn-remove"
                                                    style={{ background: 'transparent', border: 'none', color: 'var(--red)', cursor: 'pointer', padding: '4px' }}
                                                    onClick={(e) => removeFromWatchlist(e, item.symbol)}
                                                    title="Remove from Watchlist"
                                                >
                                                    <Trash2 size={16} />
                                                </button>
                                            </div>
                                        </td>
                                    </motion.tr>
                                );
                            })}
                        </motion.tbody>
                    </table>
                </div>
            )}
        </motion.div>
    );
};

export default Watchlist;

/*
 * the watchlist page. pulls the user's saved stocks from the 
 * backend and combines it with the live websocket prices so the
 * numbers tick in real time. you can remove stocks from here 
 * directly or jump to their detail page to trade them.
 */
