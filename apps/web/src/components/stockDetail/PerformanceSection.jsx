import { motion } from "framer-motion";
import { Activity } from "lucide-react";
import { formatRupees as formatINR } from "../../utils/format.js";
import { formatVolume } from "../../utils/stockDetailFormat.js";
import { staggerContainer, scaleUpItem } from "../../utils/motionVariants.js";

const RangeBar = ({ low, high, current, title, fiftyTwoWeek }) => {
    const pct = Math.min(100, Math.max(0, ((current - low) / (high - low)) * 100));
    return (
        <motion.div variants={scaleUpItem} className="price-range-bar">
            <div className="range-bar-labels">
                <span>{formatINR(low)}</span>
                <span className="range-bar-title">{title}</span>
                <span>{formatINR(high)}</span>
            </div>
            <div className="range-bar-track">
                <div
                    className={`range-bar-fill ${fiftyTwoWeek ? "fifty-two" : ""}`}
                    style={{ width: `${pct}%` }}
                ></div>
                <div className="range-bar-marker" style={{ left: `${pct}%` }}></div>
            </div>
        </motion.div>
    );
};

const PerformanceSection = ({ performance, currentPrice }) => {
    if (!performance) return null;

    const perfItems = [
        { label: "Open", value: formatINR(performance.open) },
        { label: "Previous Close", value: formatINR(performance.previousClose) },
        { label: "Day High", value: formatINR(performance.dayHigh), positive: true },
        { label: "Day Low", value: formatINR(performance.dayLow), negative: true },
        { label: "52W High", value: formatINR(performance.fiftyTwoWeekHigh), positive: true },
        { label: "52W Low", value: formatINR(performance.fiftyTwoWeekLow), negative: true },
        { label: "Volume", value: formatVolume(performance.volume) },
    ];

    return (
        <div className="performance-section">
            <h3><Activity size={16} className="mr-2" /> Performance</h3>
            <motion.div className="perf-grid" variants={staggerContainer} initial="hidden" animate="show">
                {perfItems.map((item) => (
                    <motion.div variants={scaleUpItem} key={item.label} className="perf-item glass-panel">
                        <span className="perf-label">{item.label}</span>
                        <span className={`perf-value ${item.positive ? "positive" : ""} ${item.negative ? "negative" : ""}`}>
                            {item.value}
                        </span>
                    </motion.div>
                ))}
            </motion.div>

            {performance.dayLow > 0 && performance.dayHigh > 0 && currentPrice > 0 && (
                <RangeBar low={performance.dayLow} high={performance.dayHigh} current={currentPrice} title="Today's Range" />
            )}

            {performance.fiftyTwoWeekLow && performance.fiftyTwoWeekHigh && currentPrice > 0 && (
                <RangeBar
                    low={performance.fiftyTwoWeekLow}
                    high={performance.fiftyTwoWeekHigh}
                    current={currentPrice}
                    title="52 Week Range"
                    fiftyTwoWeek
                />
            )}
        </div>
    );
};

export default PerformanceSection;
