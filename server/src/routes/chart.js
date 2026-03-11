import { Router } from "express";

const router = Router();

router.get("/:symbol", async (req, res) => {
    try {
        const { symbol } = req.params;
        const yahooSymbol = `${symbol.toUpperCase()}.NS`;

        const now = Math.floor(Date.now() / 1000);
        const startOfDay = now - (now % 86400) - 19800;

        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${yahooSymbol}?period1=${startOfDay}&period2=${now}&interval=1m`;

        const response = await fetch(url, {
            headers: {
                "User-Agent": "Mozilla/5.0",
            },
        });

        const data = await response.json();
        const result = data.chart.result[0];
        const timestamps = result.timestamp || [];
        const ohlcv = result.indicators.quote[0];

        const candles = timestamps.map((t, i) => ({
            time: t,
            open: ohlcv.open[i],
            high: ohlcv.high[i],
            low: ohlcv.low[i],
            close: ohlcv.close[i],
            volume: ohlcv.volume[i],
        })).filter((c) => c.open !== null);

        res.json(candles);
    } catch (err) {
        res.status(500).json({ error: "Failed to fetch chart data" });
    }
});

export default router;
