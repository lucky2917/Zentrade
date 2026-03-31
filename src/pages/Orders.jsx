import { useState, useEffect } from "react";
import api from "../services/api.js";
import { motion } from "framer-motion";
import { ListOrdered, FileText } from "lucide-react";

const Orders = () => {
    const [orders, setOrders] = useState([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const fetchOrders = async () => {
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
            className="orders-page main-content"
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

/*
 * order history page. lists all the buy and sell trades youve
 * made in a table with symbol, type, quantity, price, total
 * and timestamp. fetches from /api/orders. if you havent made
 * any trades yet it shows a nice animated empty state. accessible
 * from the orders link in the navbar.
 */
