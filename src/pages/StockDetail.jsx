import { useState, useEffect, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useMarket } from "../context/MarketContext.jsx";
import { useToast } from "../context/ToastContext.jsx";
import { useAuth } from "../context/AuthContext.jsx";
import useGoogleAuth from "../hooks/useGoogleAuth.js";
import api from "../services/api.js";
import { formatRupees as formatINR } from "../utils/format.js";
import { motion } from "framer-motion";
import AISuggestion from "../components/AISuggestion.jsx";
import StockHeader from "../components/stockDetail/StockHeader.jsx";
import PriceChart from "../components/stockDetail/PriceChart.jsx";
import PerformanceSection from "../components/stockDetail/PerformanceSection.jsx";
import FundamentalsSection from "../components/stockDetail/FundamentalsSection.jsx";
import TradePanel from "../components/stockDetail/TradePanel.jsx";

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
    const [restPrice, setRestPrice] = useState(null);
    const [orderType, setOrderType] = useState("BUY");
    const [quantity, setQuantity] = useState("");
    const [tradeLoading, setTradeLoading] = useState(false);
    const [tradeMode, setTradeMode] = useState("INTRADAY");
    const { addToast } = useToast();
    const { user, refreshBalance } = useAuth();
    const [inWatchlist, setInWatchlist] = useState(false);

    const handleGoogleAuth = useGoogleAuth();

    const toggleWatchlist = async () => {
        if (!user) {
            handleGoogleAuth();
            return;
        }
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
            addToast(err.response?.data?.error || "Watchlist action failed", "error");
        }
    };

    const currentData = prices[symbol];
    const currentPrice = currentData?.price || restPrice?.price || 0;
    const changePercent = currentData?.changePercent ?? restPrice?.changePercent ?? 0;
    const change = currentData?.change ?? restPrice?.change ?? 0;
    const isPositive = changePercent >= 0;

    const fetchFullData = useCallback(async (range) => {
        setChartLoading(true);
        try {
            const res = await api.get(`/stocks/${symbol}/full?range=${range}`);
            const data = res.data;

            if (data.companyName) setCompanyName(data.companyName);
            if (data.performance) setPerformance(data.performance);
            if (data.fundamentals) setFundamentals(data.fundamentals);
            if (data.price != null) {
                setRestPrice({ price: data.price, change: data.change, changePercent: data.changePercent });
            }

            if (Array.isArray(data.chart) && data.chart.length > 0) {
                setChartData(data.chart);
            } else if (range === "1d") {
                // no intraday candles (e.g. pre-open) — switch to 5d and let the
                // effect below refetch for that range
                setSelectedRange("5d");
            } else {
                setChartData([]);
            }
            if (data.name) {
                setCompanyName(data.name);
            }
            if (user) {
                const wlRes = await api.get("/watchlist");
                setInWatchlist(wlRes.data.some((item) => item.symbol === symbol));
            }
        } catch {
            addToast("Failed to load stock data", "error");
        } finally {
            setChartLoading(false);
        }
    }, [symbol, user, addToast]);

    // Single fetch path: runs on mount, symbol change, and range change
    useEffect(() => {
        fetchFullData(selectedRange);
    }, [selectedRange, fetchFullData]);

    const handleRangeChange = (range) => {
        setSelectedRange(range);
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
            // BUY debits margin (or full cost), SELL credits proceeds/margin+pnl
            const totalPaise = orderType === "BUY"
                ? (res.data.marginRequiredPaise ?? res.data.stockCostPaise)
                : res.data.creditPaise;
            const execPrice = res.data.executionPricePaise / 100;
            const modeTag = tradeMode === "INTRADAY" ? "MIS" : "CNC";
            const leverageTag = tradeMode === "INTRADAY" ? " (5x)" : "";
            const flowTag = orderType === "BUY" ? "debited" : "credited";
            addToast(`${orderType} ${qty} ${symbol} @ ${formatINR(execPrice)} — ${formatINR(totalPaise / 100)} ${flowTag} [${modeTag}${leverageTag}]`, "success");
            setQuantity("");
            refreshBalance();
        } catch (err) {
            addToast(err.response?.data?.error || "Trade failed", "error");
        } finally {
            setTradeLoading(false);
        }
    };

    return (
        <motion.div
            className="stock-detail"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
        >
            <StockHeader
                symbol={symbol}
                companyName={companyName}
                currentPrice={currentPrice}
                currentData={currentData}
                change={change}
                changePercent={changePercent}
                isPositive={isPositive}
                inWatchlist={inWatchlist}
                onToggleWatchlist={toggleWatchlist}
                onBack={() => navigate("/")}
            />

            <div className="stock-detail-content">
                <div className="stock-detail-left">
                    <PriceChart
                        chartData={chartData}
                        chartLoading={chartLoading}
                        selectedRange={selectedRange}
                        onRangeChange={handleRangeChange}
                    />

                    <PerformanceSection performance={performance} currentPrice={currentPrice} />

                    <FundamentalsSection fundamentals={fundamentals} />

                    {user && (
                        <AISuggestion symbol={symbol} />
                    )}
                </div>

                <TradePanel
                    symbol={symbol}
                    isAuthenticated={!!user}
                    currentPrice={currentPrice}
                    orderType={orderType}
                    setOrderType={setOrderType}
                    tradeMode={tradeMode}
                    setTradeMode={setTradeMode}
                    quantity={quantity}
                    setQuantity={setQuantity}
                    tradeLoading={tradeLoading}
                    onTrade={handleTrade}
                    onGoogleAuth={handleGoogleAuth}
                />
            </div>
        </motion.div>
    );
};

export default StockDetail;
