import { useState, useEffect, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { ArrowLeft, TrendingUp, TrendingDown, RefreshCw } from "lucide-react";
import { motion } from "framer-motion";
import api from "../services/api.js";
import { useToast } from "../context/ToastContext.jsx";
import PriceChart from "../components/stockDetail/PriceChart.jsx";
import { staggerContainer, fadeUpItem } from "../utils/motionVariants.js";

const formatUsd = (value) =>
    value == null ? "—" : `$${Number(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const formatMarketCap = (value) => {
    if (value == null) return "—";
    if (value >= 1e12) return `$${(value / 1e12).toFixed(2)}T`;
    if (value >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
    return `$${(value / 1e6).toFixed(0)}M`;
};

const UsStockDetail = () => {
    const { symbol } = useParams();
    const navigate = useNavigate();

    const [selectedRange, setSelectedRange] = useState("1d");
    const [chartData, setChartData] = useState([]);
    const [chartLoading, setChartLoading] = useState(true);
    const [stock, setStock] = useState(null);
    const [error, setError] = useState(null);
    const [prediction, setPrediction] = useState(null);
    const [predicting, setPredicting] = useState(false);
    const { addToast } = useToast();

    const fetchData = useCallback(async (range) => {
        setChartLoading(true);
        try {
            const res = await api.get(`/us-market/stock/${symbol}/full?range=${range}`);
            setStock(res.data);
            setChartData(res.data.chart || []);
            setError(null);
        } catch (err) {
            setError(err.response?.data?.error || "Failed to load stock data");
        } finally {
            setChartLoading(false);
        }
    }, [symbol]);

    useEffect(() => {
        fetchData(selectedRange);
    }, [fetchData, selectedRange]);

    useEffect(() => {
        setPrediction(null);
    }, [symbol]);

    const fetchPrediction = async () => {
        setPredicting(true);
        try {
            const res = await api.get(`/us-market/predict/${symbol}`);
            setPrediction(res.data);
        } catch (err) {
            addToast(err.response?.data?.error || `Couldn't get a prediction for ${symbol}`, "error");
        } finally {
            setPredicting(false);
        }
    };

    const isPositive = (stock?.changePercent ?? 0) >= 0;
    const decisionClass = prediction?.decision?.toLowerCase() || "";

    return (
        <motion.div className="us-markets-page" initial="hidden" animate="show" variants={staggerContainer}>
            <button className="btn-back" onClick={() => navigate("/us-markets")}>
                <ArrowLeft size={16} /> Back to US Markets
            </button>

            {error ? (
                <div className="glass-panel us-offline-panel" style={{ padding: "1.2rem", marginTop: "1rem" }}>
                    <p>{error}</p>
                </div>
            ) : (
                <>
                    <motion.div variants={fadeUpItem} className="stock-detail-header" style={{ marginTop: "1rem", display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "1rem" }}>
                        <div className="stock-info">
                            <div className="stock-name-row flex items-center gap-2">
                                <h1>{symbol}</h1>
                                {stock?.companyName && <span className="company-name">{stock.companyName}</span>}
                            </div>
                            <div className="stock-price-large">{stock ? formatUsd(stock.price) : "Loading..."}</div>
                            {stock && (
                                <div className={`stock-change-large ${isPositive ? "positive" : "negative"}`}>
                                    {isPositive ? <TrendingUp size={18} /> : <TrendingDown size={18} />}
                                    {isPositive ? "+" : ""}{formatUsd(stock.change)} ({isPositive ? "+" : ""}{stock.changePercent?.toFixed(2)}%)
                                </div>
                            )}
                        </div>
                        <button className="btn-secondary" disabled={predicting} onClick={fetchPrediction}>
                            {predicting ? <RefreshCw size={14} style={{ animation: "spin 0.75s linear infinite" }} /> : `Predict ${symbol}`}
                        </button>
                    </motion.div>

                    <motion.div variants={fadeUpItem} className="glass-panel" style={{ padding: "1.5rem", marginTop: "1rem" }}>
                        <h2>Prediction</h2>
                        <p className="text-muted" style={{ fontSize: "0.85rem" }}>
                            Generated on demand by AI, reading live price, momentum, and headlines — nothing here submits a trade.
                        </p>
                        {prediction ? (
                            <div style={{ marginTop: "0.8rem" }}>
                                <div className="us-decision-row">
                                    <span className={`us-decision-pill ${decisionClass}`}>{prediction.decision}</span>
                                    <div className="us-confidence-track">
                                        <div className={`us-confidence-fill ${decisionClass}`} style={{ width: `${prediction.confidence ?? 0}%` }} />
                                    </div>
                                    <span className="us-confidence-label">{prediction.confidence}%</span>
                                </div>
                                <p className="us-predict-reason">{prediction.reason}</p>
                                {prediction.headlines?.length > 0 && (
                                    <ul className="us-predict-headlines">
                                        {prediction.headlines.slice(0, 3).map((h) => (
                                            <li key={h}>{h}</li>
                                        ))}
                                    </ul>
                                )}
                                {prediction.checked_at && (
                                    <p className="us-predict-timestamp">
                                        Checked {new Date(prediction.checked_at).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                                    </p>
                                )}
                            </div>
                        ) : (
                            <p className="us-predict-empty">Click Predict {symbol} above for a live read.</p>
                        )}
                    </motion.div>

                    <motion.div variants={fadeUpItem} className="glass-panel" style={{ padding: "1.5rem", marginTop: "1rem" }}>
                        <PriceChart
                            chartData={chartData}
                            chartLoading={chartLoading}
                            selectedRange={selectedRange}
                            onRangeChange={setSelectedRange}
                            timeOffsetSeconds={0}
                        />
                    </motion.div>

                    {stock && (
                        <motion.div variants={fadeUpItem} className="glass-panel" style={{ padding: "1.5rem", marginTop: "1.5rem" }}>
                            <h2>Stats</h2>
                            <table className="stock-table">
                                <tbody>
                                    <tr><td>Day Range</td><td>{formatUsd(stock.dayLow)} – {formatUsd(stock.dayHigh)}</td></tr>
                                    <tr><td>52-Week Range</td><td>{formatUsd(stock.fiftyTwoWeekLow)} – {formatUsd(stock.fiftyTwoWeekHigh)}</td></tr>
                                    <tr><td>Market Cap</td><td>{formatMarketCap(stock.marketCap)}</td></tr>
                                    <tr><td>Market State</td><td>{stock.marketState}</td></tr>
                                </tbody>
                            </table>
                        </motion.div>
                    )}
                </>
            )}
        </motion.div>
    );
};

export default UsStockDetail;
