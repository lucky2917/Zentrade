import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import api from "../services/api.js";

const Portfolio = () => {
    const [portfolio, setPortfolio] = useState(null);
    const [loading, setLoading] = useState(true);
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

    return (
        <div className="portfolio-page">
            <h1>Portfolio</h1>

            <div className="portfolio-summary">
                <div className="summary-card">
                    <span className="summary-label">Available Balance</span>
                    <span className="summary-value">{formatCurrency(portfolio.balancePaise)}</span>
                </div>
                <div className="summary-card">
                    <span className="summary-label">Invested Value</span>
                    <span className="summary-value">{formatCurrency(portfolio.totalInvestedPaise)}</span>
                </div>
                <div className="summary-card">
                    <span className="summary-label">Current Value</span>
                    <span className="summary-value">{formatCurrency(portfolio.totalCurrentPaise)}</span>
                </div>
                <div className={`summary-card ${isPnlPositive ? "pnl-positive" : "pnl-negative"}`}>
                    <span className="summary-label">Total P&L</span>
                    <span className="summary-value">
                        {isPnlPositive ? "+" : ""}{formatCurrency(totalPnl)}
                    </span>
                </div>
            </div>

            {portfolio.holdings.length === 0 ? (
                <div className="empty-state">
                    <h3>No Holdings</h3>
                    <p>Start trading to build your portfolio!</p>
                    <button className="btn-primary" onClick={() => navigate("/")}>
                        Browse Markets
                    </button>
                </div>
            ) : (
                <div className="holdings-table-container">
                    <table className="holdings-table">
                        <thead>
                            <tr>
                                <th>Symbol</th>
                                <th>Qty</th>
                                <th>Avg Price</th>
                                <th>Current Price</th>
                                <th>Invested</th>
                                <th>Current Value</th>
                                <th>P&L</th>
                                <th>Action</th>
                            </tr>
                        </thead>
                        <tbody>
                            {portfolio.holdings.map((h) => {
                                const pnl = h.pnlPaise;
                                const isPosH = pnl >= 0;
                                return (
                                    <tr key={h.symbol}>
                                        <td className="stock-symbol">{h.symbol}</td>
                                        <td>{h.quantity}</td>
                                        <td>{formatCurrency(h.avgPricePaise)}</td>
                                        <td>{formatCurrency(h.currentPricePaise)}</td>
                                        <td>{formatCurrency(h.investedPaise)}</td>
                                        <td>{formatCurrency(h.currentValuePaise)}</td>
                                        <td className={isPosH ? "positive" : "negative"}>
                                            {isPosH ? "+" : ""}{formatCurrency(pnl)}
                                        </td>
                                        <td>
                                            <button
                                                className="btn-trade"
                                                onClick={() => navigate(`/stock/${h.symbol}`)}
                                            >
                                                Trade
                                            </button>
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
};

export default Portfolio;
