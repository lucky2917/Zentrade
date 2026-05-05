import { useMarket } from "../context/MarketContext.jsx";
import { TrendingUp, TrendingDown } from "lucide-react";

const INDEX_ORDER = [
    { key: "NIFTY50", label: "NIFTY 50" },
    { key: "SENSEX", label: "SENSEX" },
    { key: "BANKNIFTY", label: "BANK NIFTY" },
];

const formatPrice = (val) => {
    if (val == null) return "—";
    return new Intl.NumberFormat("en-IN", {
        maximumFractionDigits: 2,
        minimumFractionDigits: 2,
    }).format(val);
};

const IndexTicker = () => {
    const { indices } = useMarket();

    if (!indices || Object.keys(indices).length === 0) return null;

    return (
        <div className="index-ticker">
            {INDEX_ORDER.map(({ key, label }) => {
                const data = indices[key];
                if (!data) return null;

                const isPositive = (data.changePercent || 0) >= 0;

                return (
                    <div key={key} className="ticker-item">
                        <span className="ticker-label">{label}</span>
                        <span className="ticker-price">{formatPrice(data.price)}</span>
                        <span className={`ticker-change ${isPositive ? "positive" : "negative"}`}>
                            {isPositive ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
                            {isPositive ? "+" : ""}{formatPrice(data.change)} ({isPositive ? "+" : ""}{data.changePercent?.toFixed(2)}%)
                        </span>
                    </div>
                );
            })}
        </div>
    );
};

export default IndexTicker;
