import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import api from "../services/api.js";
import { useAuth } from "../context/AuthContext.jsx";
import useGoogleAuth from "../hooks/useGoogleAuth.js";
import GoogleIcon from "../components/GoogleIcon.jsx";
import { useToast } from "../context/ToastContext.jsx";
import { formatRupees } from "../utils/format.js";
import { staggerContainer, fadeUpItem } from "../utils/motionVariants.js";
import { motion } from "framer-motion";
import { Star, TrendingUp, TrendingDown, ExternalLink, Trash2, Activity } from "lucide-react";
import { useMarket } from "../context/MarketContext.jsx";

const Watchlist = () => {
    const [watchlist, setWatchlist] = useState([]);
    const [loading, setLoading] = useState(true);
    const { user } = useAuth();
    const { addToast } = useToast();
    const navigate = useNavigate();
    const { prices } = useMarket();

    const handleGoogleAuth = useGoogleAuth();

    const fetchWatchlist = async () => {
        if (!user) {
            setLoading(false);
            return;
        }
        try {
            const res = await api.get("/watchlist");
            setWatchlist(res.data);
        } catch {
            addToast("Failed to load watchlist", "error");
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchWatchlist();
    }, [user]);

    const removeFromWatchlist = async (e, symbol) => {
        e.stopPropagation();
        try {
            await api.delete("/watchlist/remove", { data: { symbol } });
            setWatchlist(watchlist.filter(w => w.symbol !== symbol));
        } catch {
            addToast("Failed to remove from watchlist", "error");
        }
    };

    const formatPrice = formatRupees;

    if (!user) {
        return (
            <motion.div
                className="watchlist-page"
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
                        <GoogleIcon />
                        <span style={{ fontSize: "1rem" }}>Continue with Google</span>
                    </button>
                </div>
            </motion.div>
        );
    }

    if (loading) {
        return <div className="loading-screen">Loading watchlist...</div>;
    }

    const containerVariants = staggerContainer;
    const itemVariants = fadeUpItem;

    return (
        <motion.div
            className="watchlist-page"
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
