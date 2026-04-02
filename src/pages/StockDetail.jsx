import { useState, useEffect, useRef } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { createChart, CandlestickSeries, HistogramSeries } from "lightweight-charts";
import { useMarket } from "../context/MarketContext.jsx";
import { useToast } from "../context/ToastContext.jsx";
import { useAuth } from "../context/AuthContext.jsx";
import api from "../services/api.js";
import { motion, AnimatePresence } from "framer-motion";
import { ArrowLeft, TrendingUp, TrendingDown, Activity, BarChart2, Star } from "lucide-react";

const RANGES = [
    { key: "1d", label: "1D" },
    { key: "5d", label: "5D" },
    { key: "1mo", label: "1M" },
    { key: "3mo", label: "3M" },
    { key: "1y", label: "1Y" },
    { key: "5y", label: "5Y" },
];

const formatINR = (value) => {
    if (value == null) return "—";
    return new Intl.NumberFormat("en-IN", {
        style: "currency",
        currency: "INR",
        maximumFractionDigits: 2,
    }).format(value);
};

const formatVolume = (vol) => {
    if (vol == null || vol === 0) return "—";
    if (vol >= 10000000) return (vol / 10000000).toFixed(2) + " Cr";
    if (vol >= 100000) return (vol / 100000).toFixed(2) + " L";
    if (vol >= 1000) return (vol / 1000).toFixed(1) + " K";
    return vol.toLocaleString("en-IN");
};

const formatMarketCap = (cap) => {
    if (cap == null) return "—";
    if (cap >= 10000000000000) return "₹" + (cap / 10000000000000).toFixed(2) + " L Cr";
    if (cap >= 100000000000) return "₹" + (cap / 100000000000).toFixed(2) + " K Cr";
    if (cap >= 10000000) return "₹" + (cap / 10000000).toFixed(2) + " Cr";
    return "₹" + cap.toLocaleString("en-IN");
};

const ChartComponent = ({ chartData, selectedRange }) => {
    const wrapperRef = useRef(null);
    const chartInstanceRef = useRef(null);
    const timerRef = useRef(null);

    useEffect(() => {
        if (!wrapperRef.current || chartData.length === 0) return;

        const wrapper = wrapperRef.current;

        if (chartInstanceRef.current) {
            try {
                window.removeEventListener("resize", chartInstanceRef.current._rh);
                chartInstanceRef.current.remove();
            } catch { }
            chartInstanceRef.current = null;
        }

        const chartHost = document.createElement("div");
        chartHost.style.width = "100%";
        chartHost.style.height = "420px";
        wrapper.innerHTML = "";
        wrapper.appendChild(chartHost);

        timerRef.current = setTimeout(() => {
            if (!wrapper.isConnected) return;

            const w = chartHost.offsetWidth || wrapper.offsetWidth || 600;

            const chart = createChart(chartHost, {
                width: w,
                height: 420,
                layout: {
                    background: { color: "transparent" },
                    textColor: "#64748b",
                },
                grid: {
                    vertLines: { color: "var(--border)" },
                    horzLines: { color: "var(--border)" },
                },
                timeScale: {
                    timeVisible: selectedRange === "1d" || selectedRange === "5d",
                    secondsVisible: false,
                },
            });

            const cs = chart.addSeries(CandlestickSeries, {
                upColor: "#10b981",
                downColor: "#ef4444",
                borderDownColor: "#ef4444",
                borderUpColor: "#10b981",
                wickDownColor: "#ef4444",
                wickUpColor: "#10b981",
            });

            const vs = chart.addSeries(HistogramSeries, {
                priceFormat: { type: "volume" },
                priceScaleId: "vol",
            });

            chart.priceScale("vol").applyOptions({
                scaleMargins: { top: 0.85, bottom: 0 },
            });

            const candles = chartData
                .filter((c) => c.open != null && c.close != null && c.high != null && c.low != null)
                .map((c) => ({ time: c.time, open: +c.open, high: +c.high, low: +c.low, close: +c.close }));

            const vols = chartData
                .filter((c) => c.close != null && c.open != null)
                .map((c) => ({
                    time: c.time,
                    value: +(c.volume || 0),
                    color: c.close >= c.open ? "rgba(16,185,129,0.3)" : "rgba(239,68,68,0.3)",
                }));

            cs.setData(candles);
            vs.setData(vols);
            chart.timeScale().fitContent();

            const rh = () => {
                if (chartInstanceRef.current && chartHost.offsetWidth > 0) {
                    chartInstanceRef.current.applyOptions({ width: chartHost.offsetWidth });
                }
            };
            window.addEventListener("resize", rh);
            chart._rh = rh;
            chartInstanceRef.current = chart;
        }, 150);

        return () => {
            clearTimeout(timerRef.current);
            if (chartInstanceRef.current) {
                try {
                    window.removeEventListener("resize", chartInstanceRef.current._rh);
                    chartInstanceRef.current.remove();
                } catch { }
                chartInstanceRef.current = null;
            }
        };
    }, [chartData, selectedRange]);

    return <div ref={wrapperRef} style={{ width: "100%", minHeight: "420px" }}></div>;
};

const StockDetail = () => {
    const { symbol } = useParams();
    const navigate = useNavigate();
    const { prices } = useMarket();

    const [selectedRange, setSelectedRange] = useState("1d");
    const [chartData, setChartData] = useState([]);
    const [chartLoading, setChartLoading] = useState(true);
    const [performance, setPerformance] = useState(null);
    const [fundamentals, setFundamentals] = useState(null);
    const [companyName, setCompanyName] = useState("");
    const [orderType, setOrderType] = useState("BUY");
    const [quantity, setQuantity] = useState("");
    const [tradeLoading, setTradeLoading] = useState(false);
    const [tradeMode, setTradeMode] = useState("INTRADAY");
    const { addToast } = useToast();
    const { refreshBalance } = useAuth();
    const [inWatchlist, setInWatchlist] = useState(false);

    const toggleWatchlist = async () => {
        try {
            if (inWatchlist) {
                await api.delete("/watchlist/remove", { data: { symbol } });
                setInWatchlist(false);
                addToast("Removed from watchlist", "info");
            } else {
                await api.post("/watchlist/add", { symbol });
                setInWatchlist(true);
                addToast("Added to watchlist", "success");
            }
        } catch (err) {
            console.error("Watchlist action failed");
        }
    };

    const currentData = prices[symbol];
    const currentPrice = currentData?.price || 0;
    const changePercent = currentData?.changePercent || 0;
    const change = currentData?.change || 0;
    const isPositive = changePercent >= 0;

    const fetchFullData = async (range) => {
        setChartLoading(true);
        try {
            const res = await api.get(`/stocks/${symbol}/full?range=${range}`);
            const data = res.data;

            if (data.companyName) setCompanyName(data.companyName);
            if (data.performance) setPerformance(data.performance);
            if (data.fundamentals) setFundamentals(data.fundamentals);

            if (Array.isArray(data.chart) && data.chart.length > 0) {
                setChartData(data.chart);
            } else if (range === "1d") {
                const fallback = await api.get(`/stocks/${symbol}/full?range=5d`);
                if (Array.isArray(fallback.data.chart) && fallback.data.chart.length > 0) {
                    setChartData(fallback.data.chart);
                    setSelectedRange("5d");
                } else {
                    setChartData([]);
                }
            } else {
                setChartData([]);
            }
        } catch {
            setChartData([]);
        } finally {
            setChartLoading(false);
        }
    };

    useEffect(() => {
        fetchFullData(selectedRange);
        api.get("/watchlist").then(res => {
            if (res.data.some(w => w.symbol === symbol)) {
                setInWatchlist(true);
            }
        }).catch(() => {});
    }, [symbol]);

    const handleRangeChange = (range) => {
        setSelectedRange(range);
        fetchFullData(range);
    };

    const handleTrade = async () => {
        const qty = parseInt(quantity);
        if (!qty || qty <= 0) {
            addToast("Enter a valid quantity", "error");
            return;
        }

        setTradeLoading(true);

        try {
            const endpoint = orderType === "BUY" ? "/trade/buy" : "/trade/sell";
            const res = await api.post(endpoint, { symbol, quantity: qty, mode: tradeMode });
            const total = (res.data.totalCostPaise || res.data.totalValuePaise) / 100;
            const execPrice = (res.data.executionPricePaise) / 100;
            const modeTag = tradeMode === "INTRADAY" ? "MIS" : "CNC";
            const leverageTag = tradeMode === "INTRADAY" ? " (5x)" : "";
            addToast(`${orderType} ${qty} ${symbol} @ ${formatINR(execPrice)} = ${formatINR(total)} [${modeTag}${leverageTag}]`, "success");
            setQuantity("");
            refreshBalance();
        } catch (err) {
            addToast(err.response?.data?.error || "Trade failed", "error");
        } finally {
            setTradeLoading(false);
        }
    };

    const qty = parseInt(quantity) || 0;
    const estimatedCost = currentPrice * qty;
    const isIntraday = tradeMode === "INTRADAY";
    const marginRequired = isIntraday ? estimatedCost / 5 : estimatedCost;

    const perfItems = performance ? [
        { label: "Open", value: formatINR(performance.open) },
        { label: "Previous Close", value: formatINR(performance.previousClose) },
        { label: "Day High", value: formatINR(performance.dayHigh), positive: true },
        { label: "Day Low", value: formatINR(performance.dayLow), negative: true },
        { label: "52W High", value: formatINR(performance.fiftyTwoWeekHigh), positive: true },
        { label: "52W Low", value: formatINR(performance.fiftyTwoWeekLow), negative: true },
        { label: "Volume", value: formatVolume(performance.volume) },
    ] : [];

    const fundItems = fundamentals ? [
        { label: "Market Cap", value: formatMarketCap(fundamentals.marketCap) },
        { label: "P/E Ratio", value: fundamentals.peRatio != null ? fundamentals.peRatio.toFixed(2) : "—" },
        { label: "P/B Ratio", value: fundamentals.pbRatio != null ? fundamentals.pbRatio.toFixed(2) : "—" },
        { label: "EPS", value: fundamentals.eps != null ? formatINR(fundamentals.eps) : "—" },
        { label: "Book Value", value: fundamentals.bookValue != null ? formatINR(fundamentals.bookValue) : "—" },
        { label: "Div Yield", value: fundamentals.dividendYield != null ? fundamentals.dividendYield.toFixed(2) + "%" : "—" },
        { label: "52W High", value: formatINR(fundamentals.fiftyTwoWeekHigh) },
        { label: "52W Low", value: formatINR(fundamentals.fiftyTwoWeekLow) },
    ] : [];

    const containerVariants = {
        hidden: { opacity: 0 },
        show: {
            opacity: 1,
            transition: { staggerChildren: 0.05 }
        }
    };

    const itemVariants = {
        hidden: { opacity: 0, scale: 0.95 },
        show: { opacity: 1, scale: 1, transition: { type: "spring", stiffness: 300, damping: 24 } }
    };

    return (
        <motion.div
            className="stock-detail"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, ease: "easeOut" }}
        >
            <button className="btn-back" onClick={() => navigate("/")}>
                <ArrowLeft size={16} /> Back to Markets
            </button>

            <div className="stock-detail-header">
                <div className="stock-info">
                    <div className="stock-name-row flex items-center gap-2">
                        <h1>{symbol}</h1>
                        <button 
                            className="btn-watchlist-toggle"
                            onClick={toggleWatchlist}
                            style={{ background: 'transparent', border: 'none', cursor: 'pointer', display: 'flex' }}
                            title={inWatchlist ? "Remove from Watchlist" : "Add to Watchlist"}
                        >
                            <Star 
                                size={22} 
                                style={{ color: inWatchlist ? 'var(--yellow)' : 'var(--text-muted)' }} 
                                fill={inWatchlist ? 'var(--yellow)' : 'none'} 
                            />
                        </button>
                        {companyName && <span className="company-name">{companyName}</span>}
                    </div>
                    <div className="stock-price-large">
                        {currentPrice > 0 ? formatINR(currentPrice) : "Loading..."}
                    </div>
                    {currentData && (
                        <div className={`stock-change-large ${isPositive ? "positive" : "negative"}`}>
                            {isPositive ? <TrendingUp size={18} className="mr-2" /> : <TrendingDown size={18} className="mr-2" />}
                            {isPositive ? "+" : ""}{formatINR(Math.abs(change))} ({isPositive ? "+" : ""}{changePercent.toFixed(2)}%)
                        </div>
                    )}
                </div>
            </div>

            <div className="stock-detail-content">
                <div className="stock-detail-left">
                    <div className="chart-section">
                        <div className="chart-header">
                            <h3><BarChart2 size={16} className="mr-2" /> Price Chart</h3>
                            <div className="range-selector">
                                {RANGES.map((r) => (
                                    <button
                                        key={r.key}
                                        className={`range-btn ${selectedRange === r.key ? "active" : ""}`}
                                        onClick={() => handleRangeChange(r.key)}
                                    >
                                        {r.label}
                                    </button>
                                ))}
                            </div>
                        </div>
                        {chartLoading ? (
                            <div className="chart-loading">Loading chart...</div>
                        ) : chartData.length === 0 ? (
                            <div className="chart-loading">No chart data available</div>
                        ) : (
                            <ChartComponent chartData={chartData} selectedRange={selectedRange} />
                        )}
                    </div>

                    {perfItems.length > 0 && (
                        <div className="performance-section">
                            <h3><Activity size={16} className="mr-2" /> Performance</h3>
                            <motion.div className="perf-grid" variants={containerVariants} initial="hidden" animate="show">
                                {perfItems.map((item) => (
                                    <motion.div variants={itemVariants} key={item.label} className="perf-item glass-panel">
                                        <span className="perf-label">{item.label}</span>
                                        <span className={`perf-value ${item.positive ? "positive" : ""} ${item.negative ? "negative" : ""}`}>
                                            {item.value}
                                        </span>
                                    </motion.div>
                                ))}
                            </motion.div>

                            {performance.dayLow > 0 && performance.dayHigh > 0 && currentPrice > 0 && (
                                <motion.div variants={itemVariants} className="price-range-bar">
                                    <div className="range-bar-labels">
                                        <span>{formatINR(performance.dayLow)}</span>
                                        <span className="range-bar-title">Today's Range</span>
                                        <span>{formatINR(performance.dayHigh)}</span>
                                    </div>
                                    <div className="range-bar-track">
                                        <div
                                            className="range-bar-fill"
                                            style={{
                                                width: `${Math.min(100, Math.max(0, ((currentPrice - performance.dayLow) / (performance.dayHigh - performance.dayLow)) * 100))}%`,
                                            }}
                                        ></div>
                                        <div
                                            className="range-bar-marker"
                                            style={{
                                                left: `${Math.min(100, Math.max(0, ((currentPrice - performance.dayLow) / (performance.dayHigh - performance.dayLow)) * 100))}%`,
                                            }}
                                        ></div>
                                    </div>
                                </motion.div>
                            )}

                            {performance.fiftyTwoWeekLow && performance.fiftyTwoWeekHigh && currentPrice > 0 && (
                                <motion.div variants={itemVariants} className="price-range-bar">
                                    <div className="range-bar-labels">
                                        <span>{formatINR(performance.fiftyTwoWeekLow)}</span>
                                        <span className="range-bar-title">52 Week Range</span>
                                        <span>{formatINR(performance.fiftyTwoWeekHigh)}</span>
                                    </div>
                                    <div className="range-bar-track">
                                        <div
                                            className="range-bar-fill fifty-two"
                                            style={{
                                                width: `${Math.min(100, Math.max(0, ((currentPrice - performance.fiftyTwoWeekLow) / (performance.fiftyTwoWeekHigh - performance.fiftyTwoWeekLow)) * 100))}%`,
                                            }}
                                        ></div>
                                        <div
                                            className="range-bar-marker"
                                            style={{
                                                left: `${Math.min(100, Math.max(0, ((currentPrice - performance.fiftyTwoWeekLow) / (performance.fiftyTwoWeekHigh - performance.fiftyTwoWeekLow)) * 100))}%`,
                                            }}
                                        ></div>
                                    </div>
                                </motion.div>
                            )}
                        </div>
                    )}

                    {fundItems.length > 0 && (
                        <div className="fundamentals-section">
                            <h3><Activity size={16} className="mr-2" /> Fundamentals</h3>
                            <motion.div className="fund-grid" variants={containerVariants} initial="hidden" animate="show">
                                {fundItems.map((item) => (
                                    <motion.div variants={itemVariants} key={item.label} className="fund-item">
                                        <span className="fund-label">{item.label}</span>
                                        <span className="fund-value">{item.value}</span>
                                    </motion.div>
                                ))}
                            </motion.div>
                        </div>
                    )}
                </div>

                <div className="trade-section">
                    <h3>Place Order</h3>
                    <div className="trade-form">
                        <div className="trade-mode-toggle">
                            <button
                                className={`mode-btn ${tradeMode === "INTRADAY" ? "active-intraday" : ""}`}
                                onClick={() => setTradeMode("INTRADAY")}
                            >
                                MIS (Intraday)
                            </button>
                            <button
                                className={`mode-btn ${tradeMode === "DELIVERY" ? "active-delivery" : ""}`}
                                onClick={() => setTradeMode("DELIVERY")}
                            >
                                CNC (Delivery)
                            </button>
                        </div>

                        {isIntraday && (
                            <div className="leverage-badge">
                                <span>5× Leverage</span> — Only 20% margin required
                            </div>
                        )}

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
                                max="10000"
                            />
                        </div>

                        <div className="trade-summary">
                            <div className="summary-row">
                                <span>Market Price</span>
                                <span>{currentPrice > 0 ? formatINR(currentPrice) : "—"}</span>
                            </div>
                            <div className="summary-row">
                                <span>Spread (0.1%)</span>
                                <span>{qty > 0 ? (orderType === "BUY" ? "+" : "-") + formatINR(currentPrice * 0.001 * qty) : "—"}</span>
                            </div>
                            <div className="summary-row">
                                <span>Brokerage</span>
                                <span>{qty > 0 ? "₹20.00" : "—"}</span>
                            </div>
                            <div className="summary-row">
                                <span>Quantity</span>
                                <span>{qty}</span>
                            </div>
                            {isIntraday && qty > 0 && (
                                <div className="summary-row leverage-row">
                                    <span>Leverage</span>
                                    <span>5×</span>
                                </div>
                            )}
                            <div className="summary-row total">
                                <span>{isIntraday ? "Margin Required" : (orderType === "BUY" ? "Estimated Cost" : "Estimated Value")}</span>
                                <span>{qty > 0 ? formatINR(marginRequired * (orderType === "BUY" ? 1.001 : 0.999) + (orderType === "BUY" ? 20 : -20)) : "—"}</span>
                            </div>
                        </div>

                        <button
                            className={`btn-execute ${orderType === "BUY" ? "btn-buy" : "btn-sell"}`}
                            onClick={handleTrade}
                            disabled={tradeLoading || !quantity || qty <= 0}
                        >
                            {tradeLoading ? "Processing..." : `${orderType} ${symbol}`}
                        </button>
                    </div>
                </div>
            </div>
        </motion.div>
    );
};

export default StockDetail;

/*
 * the individual stock page. shows a candlestick chart using
 * lightweight-charts with range buttons (1D to 5Y), performance
 * stats like open/close/high/low, fundamentals grid, and the
 * buy/sell trade panel on the right. the trade panel has an
 * intraday/delivery toggle — intraday (MIS) gives 5x leverage
 * and shows margin required instead of full cost. delivery (CNC)
 * deducts the full amount. the mode gets sent to the backend
 * in the trade request body.
 */
