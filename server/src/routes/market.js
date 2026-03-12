import { Router } from "express";
import { isMarketOpen } from "../utils/marketHours.js";

const router = Router();

router.get("/status", async (req, res) => {
    const now = new Date();
    const istOffset = 5.5 * 60 * 60 * 1000;
    const ist = new Date(now.getTime() + istOffset + now.getTimezoneOffset() * 60 * 1000);

    const hours = ist.getHours();
    const minutes = ist.getMinutes();
    const day = ist.getDay();
    const isWeekday = day >= 1 && day <= 5;

    const marketOpen = isMarketOpen();

    let nextEvent = null;
    if (marketOpen) {
        nextEvent = { type: "close", time: "15:30" };
    } else if (isWeekday && (hours < 9 || (hours === 9 && minutes < 15))) {
        nextEvent = { type: "open", time: "09:15" };
    } else {
        nextEvent = { type: "open", time: "09:15 (next trading day)" };
    }

    res.json({
        marketOpen,
        currentTime: `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`,
        nextEvent,
        timezone: "IST",
        tradingHours: { open: "09:15", close: "15:30" },
    });
});

export default router;
