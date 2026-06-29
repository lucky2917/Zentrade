import { ArrowLeft, TrendingUp, TrendingDown, Star } from "lucide-react";
import { formatRupees as formatINR } from "../../utils/format.js";

const StockHeader = ({ symbol, companyName, currentPrice, currentData, change, changePercent, isPositive, inWatchlist, onToggleWatchlist, onBack }) => (
    <>
        <button className="btn-back" onClick={onBack}>
            <ArrowLeft size={16} /> Back to Markets
        </button>

        <div className="stock-detail-header">
            <div className="stock-info">
                <div className="stock-name-row flex items-center gap-2">
                    <h1>{symbol}</h1>
                    <button
                        className="btn-watchlist-toggle"
                        onClick={onToggleWatchlist}
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
    </>
);

export default StockHeader;
