import { useState, useEffect } from "react";
import api from "../services/api.js";
import { useAuth } from "../context/AuthContext.jsx";
import { useGoogleLogin } from "@react-oauth/google";
import { useToast } from "../context/ToastContext.jsx";
import { motion } from "framer-motion";
import { ListOrdered, FileText } from "lucide-react";

const Orders = () => {
    const [orders, setOrders] = useState([]);
    const [loading, setLoading] = useState(true);
    const { token, googleLogin } = useAuth();
    const { addToast } = useToast();

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

    useEffect(() => {
        const fetchOrders = async () => {
            if (!token) {
                setLoading(false);
                return;
            }
            try {
                const res = await api.get("/orders");
                setOrders(res.data);
            } catch (err) {
                console.error("Orders fetch failed");
            } finally {
                setLoading(false);
            }
        };
        fetchOrders();
    }, []);

    const formatCurrency = (paise) => {
        return new Intl.NumberFormat("en-IN", {
            style: "currency",
            currency: "INR",
            maximumFractionDigits: 2,
        }).format(paise / 100);
    };

    const formatDate = (dateStr) => {
        return new Date(dateStr).toLocaleString("en-IN", {
            day: "2-digit",
            month: "short",
            year: "numeric",
            hour: "2-digit",
            minute: "2-digit",
        });
    };

    if (!token) {
        return (
            <motion.div
                className="orders-page"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.4, ease: "easeOut" }}
            >
                <div className="dashboard-header">
                    <h1><ListOrdered size={28} className="mr-3 inline text-accent" style={{ color: 'var(--accent)' }} /> Order History</h1>
                </div>
                <div className="empty-state glass-panel" style={{ marginTop: "2rem" }}>
                    <ListOrdered size={48} className="empty-icon text-muted mb-4" style={{ color: 'var(--text-muted)' }} />
                    <h2 style={{ marginBottom: "1rem" }}>Login Required</h2>
                    <p style={{ color: 'var(--text-muted)', marginBottom: "1.5rem" }}>You must be logged in to view your order history.</p>
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
        return <div className="loading-screen">Loading orders...</div>;
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
            className="orders-page"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, ease: "easeOut" }}
        >
            <div className="dashboard-header">
                <h1><ListOrdered size={28} className="mr-3 inline text-accent" style={{ color: 'var(--accent)' }} /> Order History</h1>
            </div>

            {orders.length === 0 ? (
                <motion.div
                    initial={{ opacity: 0, scale: 0.9 }}
                    animate={{ opacity: 1, scale: 1 }}
                    className="empty-state glass-panel"
                >
                    <FileText size={48} className="empty-icon text-muted mb-4" style={{ color: 'var(--text-muted)' }} />
                    <h3>No Orders Yet</h3>
                    <p>Your trade history will appear here.</p>
                </motion.div>
            ) : (
                <div className="orders-table-container glass-panel">
                    <table className="orders-table stock-table">
                        <thead>
                            <tr>
                                <th>Date</th>
                                <th>Symbol</th>
                                <th>Type</th>
                                <th>Mode</th>
                                <th>Qty</th>
                                <th>Price</th>
                                <th>Total</th>
                            </tr>
                        </thead>
                        <motion.tbody variants={containerVariants} initial="hidden" animate="show">
                            {orders.map((o) => (
                                <motion.tr variants={itemVariants} key={o.id} className={`order-row ${o.type.toLowerCase()}`}>
                                    <td>{formatDate(o.createdAt)}</td>
                                    <td className="stock-symbol">{o.symbol}</td>
                                    <td>
                                        <span className={`order-badge ${o.type === "BUY" ? "badge-buy" : "badge-sell"}`}>
                                            {o.type}
                                        </span>
                                    </td>
                                    <td>
                                        <span className={`order-badge ${o.orderMode === "INTRADAY" ? "badge-mis" : "badge-cnc"}`}>
                                            {o.orderMode === "INTRADAY" ? "MIS" : "CNC"}
                                        </span>
                                    </td>
                                    <td>{o.quantity}</td>
                                    <td>{formatCurrency(o.pricePaise)}</td>
                                    <td>{formatCurrency(o.totalValuePaise)}</td>
                                </motion.tr>
                            ))}
                        </motion.tbody>
                    </table>
                </div>
            )}
        </motion.div>
    );
};

export default Orders;
