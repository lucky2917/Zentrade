export const formatVolume = (vol) => {
    if (vol == null || vol === 0) return "—";
    if (vol >= 10000000) return (vol / 10000000).toFixed(2) + " Cr";
    if (vol >= 100000) return (vol / 100000).toFixed(2) + " L";
    if (vol >= 1000) return (vol / 1000).toFixed(1) + " K";
    return vol.toLocaleString("en-IN");
};

export const formatMarketCap = (cap) => {
    if (cap == null) return "—";
    if (cap >= 10000000000000) return "₹" + (cap / 10000000000000).toFixed(2) + " L Cr";
    if (cap >= 100000000000) return "₹" + (cap / 100000000000).toFixed(2) + " K Cr";
    if (cap >= 10000000) return "₹" + (cap / 10000000).toFixed(2) + " Cr";
    return "₹" + cap.toLocaleString("en-IN");
};
