import GoogleIcon from "../GoogleIcon.jsx";
import { formatRupees as formatINR } from "../../utils/format.js";

const TradePanel = ({
    symbol,
    token,
    currentPrice,
    orderType,
    setOrderType,
    tradeMode,
    setTradeMode,
    quantity,
    setQuantity,
    tradeLoading,
    onTrade,
    onGoogleAuth,
}) => {
    const qty = parseInt(quantity) || 0;
    const estimatedCost = currentPrice * qty;
    const isIntraday = tradeMode === "INTRADAY";
    const spreadMultiplier = orderType === "BUY" ? 1.001 : 0.999;
    const brokerageSigned = orderType === "BUY" ? 20 : -20;
    const totalWithSpreadAndBrokerage = estimatedCost * spreadMultiplier + brokerageSigned;
    const marginRequired = isIntraday ? totalWithSpreadAndBrokerage / 5 : totalWithSpreadAndBrokerage;

    return (
        <div className="trade-section">
            <h3>Place Order</h3>
            {token ? (
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
                            <span>{qty > 0 ? formatINR(marginRequired) : "—"}</span>
                        </div>
                    </div>

                    <button
                        className={`btn-execute ${orderType === "BUY" ? "btn-buy" : "btn-sell"}`}
                        onClick={onTrade}
                        disabled={tradeLoading || !quantity || qty <= 0}
                    >
                        {tradeLoading ? "Processing..." : `${orderType} ${symbol}`}
                    </button>
                </div>
            ) : (
                <div className="trade-form auth-required-trade">
                    <p style={{ color: "var(--text-muted)", fontSize: "0.85rem", marginBottom: "1rem", textAlign: "center" }}>
                        You must be logged in to execute trades and manage orders.
                    </p>
                    <button className="btn-login-google" style={{ width: "100%", justifyContent: "center" }} onClick={() => onGoogleAuth()}>
                        <GoogleIcon size={16} style={{ marginRight: '6px' }} />
                        <span>Continue with Google</span>
                    </button>
                </div>
            )}
        </div>
    );
};

export default TradePanel;
