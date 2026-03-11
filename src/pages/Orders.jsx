import { useState, useEffect } from "react";
import api from "../services/api.js";

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

    return (
        <div className="orders-page">
            <h1>Order History</h1>

            {orders.length === 0 ? (
                <div className="empty-state">
                    <h3>No Orders Yet</h3>
                    <p>Your trade history will appear here.</p>
                </div>
            ) : (
                <div className="orders-table-container">
                    <table className="orders-table">
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
                        <tbody>
                            {orders.map((o) => (
                                <tr key={o.id} className={`order-row ${o.type.toLowerCase()}`}>
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
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
};

export default Orders;
