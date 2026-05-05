function computeEMA(prices, period) {
    if (prices.length < period) return null;
    const k = 2 / (period + 1);
    let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < prices.length; i++) {
        ema = prices[i] * k + ema * (1 - k);
    }
    return Math.round(ema * 100) / 100;
}

export function computeRSI(closes, period = 14) {
    if (closes.length < period + 1) return null;
    let gains = 0, losses = 0;
    for (let i = 1; i <= period; i++) {
        const diff = closes[i] - closes[i - 1];
        if (diff > 0) gains += diff; else losses -= diff;
    }
    let avgGain = gains / period;
    let avgLoss = losses / period;
    for (let i = period + 1; i < closes.length; i++) {
        const diff = closes[i] - closes[i - 1];
        avgGain = (avgGain * (period - 1) + Math.max(0, diff)) / period;
        avgLoss = (avgLoss * (period - 1) + Math.max(0, -diff)) / period;
    }
    if (avgLoss === 0) return 100;
    return Math.round((100 - 100 / (1 + avgGain / avgLoss)) * 100) / 100;
}

export function computeSMA(closes, period) {
    if (closes.length < period) return null;
    const slice = closes.slice(-period);
    return Math.round((slice.reduce((a, b) => a + b, 0) / period) * 100) / 100;
}

export function computeMACD(closes) {
    if (closes.length < 35) return null;
    const ema12 = computeEMA(closes, 12);
    const ema26 = computeEMA(closes, 26);
    if (!ema12 || !ema26) return null;
    const macdLine = Math.round((ema12 - ema26) * 100) / 100;
    return {
        macdLine,
        signal: macdLine > 0 ? "BULLISH" : "BEARISH",
    };
}

export function computeMomentum(closes) {
    const len = closes.length;
    if (len < 21) return null;
    const current = closes[len - 1];
    const ago5  = closes[len - 6]  ?? closes[0];
    const ago20 = closes[len - 21] ?? closes[0];
    return {
        fiveDay:   Math.round(((current - ago5)  / ago5)  * 10000) / 100,
        twentyDay: Math.round(((current - ago20) / ago20) * 10000) / 100,
    };
}

export function computeVolumeTrend(volumes) {
    if (volumes.length < 20) return "Insufficient data";
    const recent5 = volumes.slice(-5).reduce((a, b) => a + b, 0) / 5;
    const avg20   = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
    const ratio = recent5 / avg20;
    if (ratio > 1.5) return "Very high (150%+ of 20-day avg)";
    if (ratio > 1.2) return "High (120%+ of 20-day avg)";
    if (ratio > 0.8) return "Normal";
    return "Low (below 20-day avg)";
}

// 20-day VWAP proxy using daily typical price (high+low+close)/3 × volume.
// Resets conceptually each day but this rolling version works as a swing support/resistance level.
export function computeVWAP(candles, period = 20) {
    const recent = candles.slice(-period).filter(
        (c) => c.high != null && c.low != null && c.close != null && c.volume > 0
    );
    if (recent.length < 5) return null;
    let sumPV = 0, sumV = 0;
    for (const c of recent) {
        const tp = (c.high + c.low + c.close) / 3;
        sumPV += tp * c.volume;
        sumV += c.volume;
    }
    return sumV > 0 ? Math.round((sumPV / sumV) * 100) / 100 : null;
}

export function computeIndicators(candles) {
    const closes  = candles.map((c) => c.close).filter((v) => v != null);
    const volumes = candles.map((c) => c.volume).filter((v) => v != null);

    const yearHigh = Math.round(Math.max(...closes) * 100) / 100;
    const yearLow  = Math.round(Math.min(...closes) * 100) / 100;
    const current  = closes[closes.length - 1];
    const positionIn52W = yearHigh !== yearLow
        ? Math.round(((current - yearLow) / (yearHigh - yearLow)) * 100)
        : 50;

    const vwap20 = computeVWAP(candles, 20);

    return {
        rsi14:         computeRSI(closes),
        sma20:         computeSMA(closes, 20),
        sma50:         computeSMA(closes, 50),
        macd:          computeMACD(closes),
        momentum:      computeMomentum(closes),
        volumeTrend:   computeVolumeTrend(volumes),
        yearHigh,
        yearLow,
        positionIn52W,
        vwap20,
        aboveVWAP: vwap20 != null ? current > vwap20 : null,
    };
}

// ─── Intraday context from 15-min candles ─────────────────────────────────────
// Each candle must have: { ts (unix seconds), open, high, low, close, volume }
export function computeIntradayContext(candles15m) {
    if (!candles15m || candles15m.length < 5) return null;

    // IST = UTC+5:30. NSE session: 9:15 AM – 3:30 PM IST
    const nowSec = Date.now() / 1000;
    const IST    = 5.5 * 3600;
    const todayMidnightUtc = Math.floor((nowSec + IST) / 86400) * 86400 - IST;
    const sessionStart = todayMidnightUtc + 9.25 * 3600;  // 9:15 AM IST in UTC seconds
    const sessionEnd   = todayMidnightUtc + 15.5 * 3600;  // 3:30 PM IST

    const todayC = candles15m.filter((c) => c.ts >= sessionStart && c.ts <= sessionEnd);
    const prevC  = candles15m.filter((c) => c.ts < sessionStart);

    // Gap: today's open vs previous session's close
    const prevClose = prevC.length > 0 ? prevC[prevC.length - 1].close : null;
    const todayOpen = todayC.length > 0 ? todayC[0].open : null;
    const gapPct = prevClose && todayOpen
        ? Math.round(((todayOpen - prevClose) / prevClose) * 10000) / 100
        : null;

    if (todayC.length === 0) return { gapPct, noSessionData: true };

    // Opening Range — first 2 candles (9:15–9:44 AM)
    const orSlice = todayC.slice(0, 2);
    const highs   = orSlice.map((c) => c.high).filter((v) => v != null);
    const lows    = orSlice.map((c) => c.low).filter((v) => v != null);
    const orHigh  = highs.length > 0 ? Math.round(Math.max(...highs) * 100) / 100 : null;
    const orLow   = lows.length  > 0 ? Math.round(Math.min(...lows)  * 100) / 100 : null;

    const currentClose = todayC[todayC.length - 1].close;
    const orStatus = orHigh && orLow && currentClose
        ? (currentClose > orHigh ? "above OR — bullish breakout"
         : currentClose < orLow  ? "below OR — bearish breakdown"
         : "inside OR — no breakout yet")
        : "forming";

    // Intraday VWAP — resets at 9:15 AM, uses only today's candles
    let sumPV = 0, sumV = 0;
    for (const c of todayC) {
        if (c.high != null && c.low != null && c.close != null && (c.volume ?? 0) > 0) {
            sumPV += ((c.high + c.low + c.close) / 3) * c.volume;
            sumV  += c.volume;
        }
    }
    const intradayVwap = sumV > 0 ? Math.round((sumPV / sumV) * 100) / 100 : null;

    // RSI + EMA on all available 15-min closes (full history needed for accuracy)
    const closes = candles15m.map((c) => c.close).filter((v) => v != null);
    const rsi15m = computeRSI(closes, 14);
    const ema9   = closes.length >= 9  ? Math.round(computeEMA(closes, 9)  * 100) / 100 : null;
    const ema21  = closes.length >= 21 ? Math.round(computeEMA(closes, 21) * 100) / 100 : null;

    return {
        gapPct,
        orHigh,
        orLow,
        orStatus,
        intradayVwap,
        priceAboveVwap: intradayVwap && currentClose ? currentClose > intradayVwap : null,
        rsi15m,
        ema9,
        ema21,
        emaSignal: ema9 && ema21 ? (ema9 > ema21 ? "BULLISH" : "BEARISH") : null,
        candlesCount: todayC.length,
    };
}
