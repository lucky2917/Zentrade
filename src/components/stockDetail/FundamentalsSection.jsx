import { motion } from "framer-motion";
import { Activity } from "lucide-react";
import { formatRupees as formatINR } from "../../utils/format.js";
import { formatMarketCap } from "../../utils/stockDetailFormat.js";
import { staggerContainer, scaleUpItem } from "../../utils/motionVariants.js";

const FundamentalsSection = ({ fundamentals }) => {
    if (!fundamentals) return null;

    const fundItems = [
        { label: "Market Cap", value: formatMarketCap(fundamentals.marketCap) },
        { label: "P/E Ratio", value: fundamentals.peRatio != null ? fundamentals.peRatio.toFixed(2) : "—" },
        { label: "P/B Ratio", value: fundamentals.pbRatio != null ? fundamentals.pbRatio.toFixed(2) : "—" },
        { label: "EPS", value: fundamentals.eps != null ? formatINR(fundamentals.eps) : "—" },
        { label: "Book Value", value: fundamentals.bookValue != null ? formatINR(fundamentals.bookValue) : "—" },
        { label: "Div Yield", value: fundamentals.dividendYield != null ? fundamentals.dividendYield.toFixed(2) + "%" : "—" },
        { label: "52W High", value: formatINR(fundamentals.fiftyTwoWeekHigh) },
        { label: "52W Low", value: formatINR(fundamentals.fiftyTwoWeekLow) },
    ];

    return (
        <div className="fundamentals-section">
            <h3><Activity size={16} className="mr-2" /> Fundamentals</h3>
            <motion.div className="fund-grid" variants={staggerContainer} initial="hidden" animate="show">
                {fundItems.map((item) => (
                    <motion.div variants={scaleUpItem} key={item.label} className="fund-item">
                        <span className="fund-label">{item.label}</span>
                        <span className="fund-value">{item.value}</span>
                    </motion.div>
                ))}
            </motion.div>
        </div>
    );
};

export default FundamentalsSection;
