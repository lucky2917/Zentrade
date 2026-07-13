import { useMarket } from "../context/MarketContext.jsx";
import { Circle, Clock } from "lucide-react";
import { easeInOut, motion } from "framer-motion";

const MarketStatusBanner = () => {
    const { isMarketOpen, connected } = useMarket();

    if (!connected) return null;

    return (
        <motion.div 
            className={`market-banner ${isMarketOpen ? "open" : "closed"}`}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            transition={{ duration: 0.3, ease: easeInOut }}
        >
            <div className="banner-content">
                {isMarketOpen ? (
                    <>
                        <Circle size={12} fill="currentColor" className="banner-icon pulse" />
                        <span className="font-semibold">Market Open</span>
                        <span className="banner-subtext">— Quotes are live. Happy trading!</span>
                    </>
                ) : (
                    <>
                        <Clock size={14} className="banner-icon" />
                        <span className="font-semibold">Market Closed</span>
                        <span className="banner-subtext">— Opens at 09:15 AM IST (Mon-Fri)</span>
                    </>
                )}
            </div>
        </motion.div>
    );
};

export default MarketStatusBanner;
