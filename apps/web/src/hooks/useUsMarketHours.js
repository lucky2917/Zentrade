import { useState, useEffect } from "react";

/** Mon-Fri 9:30-16:00 ET. Mirrors trader_loop.py's is_market_open exactly. */
export const useUsMarketHours = () => {
    const [state, setState] = useState({ open: false, label: "checking..." });

    useEffect(() => {
        const tick = () => {
            const nowEt = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
            const day = nowEt.getDay();
            const minutes = nowEt.getHours() * 60 + nowEt.getMinutes();
            const open = day >= 1 && day <= 5 && minutes >= 9 * 60 + 30 && minutes <= 16 * 60;
            const time = nowEt.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
            setState({ open, label: open ? `US market open · ${time} ET` : `US market closed · ${time} ET` });
        };
        tick();
        const interval = setInterval(tick, 30_000);
        return () => clearInterval(interval);
    }, []);

    return state;
};
