import { useState, useEffect, useRef, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { createChart } from "lightweight-charts";
import { useMarket } from "../context/MarketContext.jsx";
import api from "../services/api.js";

const ChartComponent = ({ chartData }) => {
    const chartContainerRef = useRef(null);
    const chartRef = useRef(null);

    useEffect(() => {
        if (!chartContainerRef.current || chartData.length === 0) return;

        try {
            const chart = createChart(chartContainerRef.current, {
                width: chartContainerRef.current.clientWidth,
                height: 400,
                layout: {
                    background: { color: "#0a0e17" },
                    textColor: "#a0aec0",
                },
                grid: {
                    vertLines: { color: "#1a2332" },
                    horzLines: { color: "#1a2332" },
                },
                crosshair: {
                    mode: 0,
                },
                timeScale: {
                    timeVisible: true,
                    secondsVisible: false,
                },
            });

            chartRef.current = chart;

            const series = chart.addCandlestickSeries({
                upColor: "#10b981",
                downColor: "#ef4444",
                borderDownColor: "#ef4444",
                borderUpColor: "#10b981",
                wickDownColor: "#ef4444",
                wickUpColor: "#10b981",
            });

            const validData = chartData
                .filter((c) => c.open != null && c.close != null && c.high != null && c.low != null)
                .map((c) => ({
                    time: c.time,
                    open: c.open,
                    high: c.high,
                    low: c.low,
                    close: c.close,
                }));

            if (validData.length > 0) {
                series.setData(validData);
                chart.timeScale().fitContent();
            }

            const handleResize = () => {
                if (chartRef.current && chartContainerRef.current) {
                    chartRef.current.applyOptions({ width: chartContainerRef.current.clientWidth });
                }
            };
            window.addEventListener("resize", handleResize);

            return () => {
                window.removeEventListener("resize", handleResize);
                if (chartRef.current) {
                    chartRef.current.remove();
                    chartRef.current = null;
                }
            };
        } catch (err) {
            return undefined;
        }
    }, [chartData]);

    return <div ref={chartContainerRef} className="chart-container"></div>;
};

const StockDetail = () => {
    const { symbol } = useParams();
    const navigate = useNavigate();
    const { prices } = useMarket();

    const [orderType, setOrderType] = useState("BUY");
    const [quantity, setQuantity] = useState("");
    const [loading, setLoading] = useState(false);
    const [message, setMessage] = useState(null);
    const [chartData, setChartData] = useState([]);
    const [chartLoading, setChartLoading] = useState(true);

    const currentData = prices[symbol];
    const currentPrice = currentData?.price || 0;
    const change = currentData?.change || 0;
    const isPositive = change >= 0;

    useEffect(() => {
        let cancelled = false;
        const fetchChart = async () => {
            setChartLoading(true);
            try {
                const res = await api.get(`/chart/${symbol}`);
                if (!cancelled && Array.isArray(res.data) && res.data.length > 0) {
                    setChartData(res.data);
                }
            } catch {
                if (!cancelled) setChartData([]);
            } finally {
                if (!cancelled) setChartLoading(false);
            }
        };
        fetchChart();
        return () => { cancelled = true; };
    }, [symbol]);

    const handleTrade = async () => {
        const qty = parseInt(quantity);
        if (!qty || qty <= 0) {
            setMessage({ type: "error", text: "Enter a valid quantity" });
            return;
        }

        setLoading(true);
        setMessage(null);

        try {
            const endpoint = orderType === "BUY" ? "/trade/buy" : "/trade/sell";
            const res = await api.post(endpoint, { symbol, quantity: qty });
            const total = (res.data.totalCostPaise || res.data.totalValuePaise) / 100;
            setMessage({
                type: "success",
                text: `${orderType} ${qty} ${symbol} @ ₹${currentPrice.toFixed(2)} = ₹${total.toFixed(2)}`,
            });
            setQuantity("");
        } catch (err) {
            setMessage({ type: "error", text: err.response?.data?.error || "Trade failed" });
        } finally {
            setLoading(false);
        }
    };

    const formatPrice = (price) => {
        return new Intl.NumberFormat("en-IN", {
            style: "currency",
            currency: "INR",
            maximumFractionDigits: 2,
        }).format(price);
    };

    const qty = parseInt(quantity) || 0;
    const estimatedCost = (currentPrice * qty).toFixed(2);

    return (
        <div className="stock-detail">
            <button className="btn-back" onClick={() => navigate("/")}>
                ← Back to Markets
            </button>

            <div className="stock-detail-header">
                <div className="stock-info">
                    <h1>{symbol}</h1>
                    <div className="stock-price-large">
                        {currentPrice > 0 ? formatPrice(currentPrice) : "Loading..."}
                    </div>
                    {currentData && (
                        <div className={`stock-change-large ${isPositive ? "positive" : "negative"}`}>
                            {isPositive ? "+" : ""}{change.toFixed(2)}%
                        </div>
                    )}
                </div>
            </div>

            <div className="stock-detail-content">
                <div className="chart-section">
                    <h3>Intraday Chart (1m)</h3>
                    {chartLoading ? (
                        <div className="chart-loading">Loading chart...</div>
                    ) : chartData.length === 0 ? (
                        <div className="chart-loading">No chart data available (market may be closed)</div>
                    ) : (
                        <ChartComponent chartData={chartData} />
                    )}
                </div>

                <div className="trade-section">
                    <h3>Place Order</h3>
                    <div className="trade-form">
                        <div className="order-type-toggle">
                            <button
                                className={`toggle-btn ${orderType === "BUY" ? "active-buy" : ""}`}
                                onClick={() => setOrderType("BUY")}
                            >
                                BUY
                            </button>
                            <button
                                className={`toggle-btn ${orderType === "SELL" ? "active-sell" : ""}`}
                                onClick={() => setOrderType("SELL")}
                            >
                                SELL
                            </button>
                        </div>

                        <div className="form-group">
                            <label>Quantity</label>
                            <input
                                type="number"
                                value={quantity}
                                onChange={(e) => setQuantity(e.target.value)}
                                placeholder="Enter quantity"
                                min="1"
                            />
                        </div>

                        <div className="trade-summary">
                            <div className="summary-row">
                                <span>Price</span>
                                <span>{currentPrice > 0 ? formatPrice(currentPrice) : "—"}</span>
                            </div>
                            <div className="summary-row">
                                <span>Quantity</span>
                                <span>{qty}</span>
                            </div>
                            <div className="summary-row total">
                                <span>Estimated {orderType === "BUY" ? "Cost" : "Value"}</span>
                                <span>₹{estimatedCost}</span>
                            </div>
                        </div>

                        {message && (
                            <div className={`trade-message ${message.type}`}>
                                {message.text}
                            </div>
                        )}

                        <button
                            className={`btn-execute ${orderType === "BUY" ? "btn-buy" : "btn-sell"}`}
                            onClick={handleTrade}
                            disabled={loading || !quantity || qty <= 0}
                        >
                            {loading ? "Processing..." : `${orderType} ${symbol}`}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default StockDetail;
