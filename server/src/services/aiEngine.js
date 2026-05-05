import { STOCK_MAP } from "../config/stocks.js";
import redis from "../config/redis.js";
import logger from "../utils/logger.js";
import { computeIndicators, computeIntradayContext } from "./technicalIndicators.js";
import { fetchStockNews } from "./newsService.js";
import { getMarketContext, describeMarketContext, macroSignal } from "./marketContext.js";

const CACHE_TTL = 1800;
const GROQ_URL  = "https://api.groq.com/openai/v1/chat/completions";

const MODELS = {
    technical:   "llama-3.3-70b-versatile",
    sentiment:   "llama-3.1-8b-instant",
    risk:        "llama-3.3-70b-versatile",
    synthesizer: "llama-3.3-70b-versatile",
};

// ─── Groq caller ─────────────────────────────────────────────────────────────

async function callGroq(model, prompt, temperature = 0.15, maxTokens = 400) {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) throw new Error("Add GROQ_API_KEY to server/.env");

    const res = await fetch(GROQ_URL, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
            model,
            messages: [{ role: "user", content: prompt }],
            temperature,
            max_tokens: maxTokens,
        }),
        signal: AbortSignal.timeout(20000),
    });

    if (!res.ok) {
        const err = await res.text();
        throw new Error(`Groq error ${res.status}: ${err.slice(0, 200)}`);
    }

    const data = await res.json();
    const text = data.choices?.[0]?.message?.content ?? "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error(`No JSON in response from ${model}: ${text.slice(0, 100)}`);
    return JSON.parse(jsonMatch[0]);
}

async function callGroqSafe(model, prompt, temperature, maxTokens) {
    try {
        return await callGroq(model, prompt, temperature, maxTokens);
    } catch (firstErr) {
        logger.error("AIEngine", `${model} failed: ${firstErr.message} — retrying`);
        return await callGroq(model, prompt, temperature, maxTokens);
    }
}

// ─── Data fetch ───────────────────────────────────────────────────────────────

async function fetchOHLCV(yahooSymbol) {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${yahooSymbol}?interval=1d&range=1y`;
    const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" },
        signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error("Yahoo Finance unavailable");

    const data = await res.json();
    const result = data.chart?.result?.[0];
    if (!result?.timestamp) return [];

    const q = result.indicators.quote[0];
    return result.timestamp
        .map((_, i) => ({
            open:   q.open[i],
            high:   q.high[i],
            low:    q.low[i],
            close:  q.close[i],
            volume: q.volume[i],
        }))
        .filter((c) => c.close != null);
}

async function fetchIntraday(yahooSymbol) {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${yahooSymbol}?interval=15m&range=5d`;
    try {
        const res = await fetch(url, {
            headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" },
            signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) return [];
        const data = await res.json();
        const result = data.chart?.result?.[0];
        if (!result?.timestamp) return [];
        const q = result.indicators.quote[0];
        return result.timestamp
            .map((ts, i) => ({
                ts,
                open:   q.open[i],
                high:   q.high[i],
                low:    q.low[i],
                close:  q.close[i],
                volume: q.volume[i],
            }))
            .filter((c) => c.close != null);
    } catch {
        return [];
    }
}

// ─── Consensus — NEUTRAL abstains, only directional votes count ───────────────

function computeConsensus(techSignal, sentimentSignal, riskBias) {
    let bullish = 0, bearish = 0, neutral = 0;
    for (const s of [techSignal, sentimentSignal, riskBias]) {
        if (s === "BULLISH") bullish++;
        else if (s === "BEARISH") bearish++;
        else neutral++;
    }
    if (bullish > bearish) {
        const label = bullish === 3 ? "unanimous"
            : (bullish === 2 && bearish === 0) ? "majority" : "leaning";
        return {
            direction: "BULLISH", bullish, bearish, neutral, label,
            impliedConfidence: bullish === 3 ? "HIGH" : bullish === 2 && bearish === 0 ? "HIGH" : "MEDIUM",
        };
    }
    if (bearish > bullish) {
        const label = bearish === 3 ? "unanimous"
            : (bearish === 2 && bullish === 0) ? "majority" : "leaning";
        return {
            direction: "BEARISH", bullish, bearish, neutral, label,
            impliedConfidence: bearish === 3 ? "HIGH" : bearish === 2 && bullish === 0 ? "HIGH" : "MEDIUM",
        };
    }
    return { direction: "NEUTRAL", bullish, bearish, neutral, label: "split", impliedConfidence: "LOW" };
}

// ─── Agent 1: Technical Analyst ───────────────────────────────────────────────

async function runTechnicalAgent(stockInfo, symbol, priceData, ind, intradayCtx) {
    const rsiLabel = ind.rsi14 != null
        ? `${ind.rsi14} ${
            ind.rsi14 > 70 ? "(Overbought — reversal risk)" :
            ind.rsi14 < 30 ? "(Oversold — bounce expected)" :
            ind.rsi14 > 55 ? "(Bullish zone)" :
            ind.rsi14 < 45 ? "(Bearish zone)" : "(Neutral zone)"
          }`
        : "N/A";

    const smaLabel = ind.sma20 != null && ind.sma50 != null
        ? (ind.sma20 > ind.sma50
            ? `Bullish — SMA20 ₹${ind.sma20} above SMA50 ₹${ind.sma50}`
            : `Bearish — SMA20 ₹${ind.sma20} below SMA50 ₹${ind.sma50}`)
        : "N/A";

    const ic = intradayCtx;
    const gapLine = ic?.gapPct != null
        ? `${ic.gapPct > 0 ? "+" : ""}${ic.gapPct}% gap-${ic.gapPct >= 0 ? "up" : "down"} at open`
        : "N/A";
    const vwapIntraLine = ic?.intradayVwap
        ? `₹${ic.intradayVwap} — price ${ic.priceAboveVwap ? "ABOVE (bullish)" : "BELOW (bearish)"}`
        : ic?.noSessionData ? "Market not open yet" : "N/A";
    const emaLine = ic?.ema9 && ic?.ema21
        ? `EMA9 ₹${ic.ema9} vs EMA21 ₹${ic.ema21} → ${ic.emaSignal}`
        : "N/A";

    const prompt = `You are a technical analysis expert for Indian NSE intraday trading.
Analyse the indicators below. The 15-MIN section carries more weight for entry — that's what's happening right now.

STOCK: ${stockInfo.name} (${symbol})
CURRENT PRICE: ₹${priceData?.price ?? "N/A"} | Today: ${priceData?.changePercent != null ? (priceData.changePercent > 0 ? "+" : "") + priceData.changePercent.toFixed(2) + "%" : "N/A"}

━━ 15-MIN CHART (intraday — primary for entry timing) ━━
- Gap at open: ${gapLine}
- Opening Range (9:15–9:44 AM): High ₹${ic?.orHigh ?? "N/A"} / Low ₹${ic?.orLow ?? "N/A"}
- Price vs Opening Range: ${ic?.orStatus ?? "N/A"}
- Intraday VWAP: ${vwapIntraLine}
- 15-min RSI(14): ${ic?.rsi15m != null ? ic.rsi15m + (ic.rsi15m > 60 ? " (momentum bullish)" : ic.rsi15m < 40 ? " (momentum bearish)" : " (neutral)") : "N/A"}
- 15-min EMA9/21: ${emaLine}

━━ DAILY CHART (trend bias only) ━━
- Daily RSI(14): ${rsiLabel}
- MACD: ${ind.macd ? `Line ${ind.macd.macdLine} → ${ind.macd.signal}` : "N/A"}
- SMA crossover: ${smaLabel}
- 5-day momentum: ${ind.momentum?.fiveDay != null ? ind.momentum.fiveDay + "%" : "N/A"}
- Volume: ${ind.volumeTrend}
- 52W position: ${ind.positionIn52W}% (0=year low, 100=year high)

DECISION GUIDE — intraday entry rules:
1. Above OR + above intraday VWAP + EMA BULLISH → BULLISH (strong)
2. Below OR + below intraday VWAP + EMA BEARISH → BEARISH (strong)
3. Inside OR → lower confidence but still call a direction based on VWAP + RSI
4. Daily trend confirms intraday → boost confidence. Daily conflicts → reduce confidence.
5. Only NEUTRAL if price is dead flat inside OR, RSI ≈50, and no gap — genuinely rare.

Respond ONLY in this exact JSON — no markdown:
{
  "signal": "BULLISH" | "BEARISH" | "NEUTRAL",
  "confidence": "HIGH" | "MEDIUM" | "LOW",
  "keyPoints": ["specific intraday observation with numbers", "second observation"]
}`;

    const result = await callGroqSafe(MODELS.technical, prompt, 0.15);
    if (!["BULLISH", "BEARISH", "NEUTRAL"].includes(result.signal)) result.signal = "NEUTRAL";
    if (!["HIGH", "MEDIUM", "LOW"].includes(result.confidence)) result.confidence = "MEDIUM";
    if (!Array.isArray(result.keyPoints)) result.keyPoints = [];
    return result;
}

// ─── Agent 2: Sentiment Analyst ───────────────────────────────────────────────

async function runSentimentAgent(stockInfo, symbol, news, priceData, ind) {
    const newsBlock = news.length > 0
        ? news.map((n, i) => `${i + 1}. [${n.source}] ${n.headline}`).join("\n")
        : "No recent news headlines found.";

    const todayChg = priceData?.changePercent != null
        ? (priceData.changePercent > 0 ? "+" : "") + priceData.changePercent.toFixed(2) + "%"
        : "N/A";
    const mom5d = ind.momentum?.fiveDay != null
        ? (ind.momentum.fiveDay > 0 ? "+" : "") + ind.momentum.fiveDay + "%"
        : "N/A";

    const prompt = `You are a market sentiment analyst for Indian NSE equities.
Gauge the current CROWD MOOD around ${stockInfo.name} (${stockInfo.sector} sector, NSE: ${symbol}).

PRICE ACTION (crowd mood proxy):
- Today's move: ${todayChg}
- 5-day trend: ${mom5d}
- Volume: ${ind.volumeTrend ?? "N/A"}

RECENT NEWS (last 7 days):
${newsBlock}

HOW TO DECIDE — be decisive:
1. Strong news (earnings beat/miss, deal, regulatory action, CEO change) → weight it 70%.
2. Sparse/irrelevant news → read price action:
   - Rising today + positive 5-day + elevated volume = BULLISH crowd
   - Falling today + negative 5-day + elevated volume = BEARISH crowd
   - Flat price + average volume + no news = NEUTRAL (only this exact case)
3. Sector tailwinds/headwinds visible in news → factor in.
4. Never default to NEUTRAL just because news is thin — price IS the sentiment.

Respond ONLY in this exact JSON — no markdown:
{
  "sentiment": "BULLISH" | "BEARISH" | "NEUTRAL",
  "confidence": "HIGH" | "MEDIUM" | "LOW",
  "keyPoints": ["key sentiment finding", "second finding"]
}`;

    const result = await callGroqSafe(MODELS.sentiment, prompt, 0.2);
    if (!["BULLISH", "BEARISH", "NEUTRAL"].includes(result.sentiment)) result.sentiment = "NEUTRAL";
    if (!["HIGH", "MEDIUM", "LOW"].includes(result.confidence)) result.confidence = "LOW";
    if (!Array.isArray(result.keyPoints)) result.keyPoints = [];
    return result;
}

// ─── Agent 3: Risk Analyst ────────────────────────────────────────────────────

async function runRiskAgent(stockInfo, symbol, priceData, ind, mktCtx) {
    const posLabel = ind.positionIn52W > 80
        ? "Near 52-week HIGH — limited upside headroom"
        : ind.positionIn52W < 20
        ? "Near 52-week LOW — potential value or continued slide"
        : `Mid-range at ${ind.positionIn52W}% of year`;

    const mom5d  = ind.momentum?.fiveDay != null  ? (ind.momentum.fiveDay > 0 ? "+" : "")  + ind.momentum.fiveDay  + "%" : "N/A";
    const mom20d = ind.momentum?.twentyDay != null ? (ind.momentum.twentyDay > 0 ? "+" : "") + ind.momentum.twentyDay + "%" : "N/A";

    const macroLine = mktCtx?.nifty
        ? `Nifty: ${mktCtx.nifty.changePercent > 0 ? "+" : ""}${mktCtx.nifty.changePercent}% today, ${mktCtx.nifty.aboveDailyOpen ? "above" : "below"} day open`
        : "Nifty: unavailable";

    const prompt = `You are a risk expert for Indian NSE blue-chip stocks.
Assess the risk AND give a directional bias for a short-term trade on ${stockInfo.name} (${stockInfo.sector}, ${symbol}).

CURRENT PRICE: ₹${priceData?.price ?? "N/A"}
52W High: ₹${ind.yearHigh} | 52W Low: ₹${ind.yearLow} | Position: ${posLabel}
5-day momentum: ${mom5d} | 20-day momentum: ${mom20d}
Volume trend: ${ind.volumeTrend}
Macro context: ${macroLine}

BIAS RULES — always give BULLISH or BEARISH, never NEUTRAL:
- Both momentums positive → BULLISH (trend is your friend)
- Both negative → BEARISH
- Mixed → follow 5-day (more current)
- Near 52W high + macro bearish → BEARISH (double risk)
- Near 52W low + positive momentum → BULLISH (potential reversal)
- NEUTRAL is not acceptable — commit to a direction.

Respond ONLY in this exact JSON — no markdown:
{
  "riskLevel": "LOW" | "MEDIUM" | "HIGH",
  "bias": "BULLISH" | "BEARISH",
  "confidence": "HIGH" | "MEDIUM" | "LOW",
  "keyPoints": ["specific risk observation with numbers", "second observation"]
}`;

    const result = await callGroqSafe(MODELS.risk, prompt, 0.2);
    if (!["LOW", "MEDIUM", "HIGH"].includes(result.riskLevel)) result.riskLevel = "MEDIUM";
    if (!["BULLISH", "BEARISH"].includes(result.bias))
        result.bias = (ind.momentum?.fiveDay ?? 0) >= 0 ? "BULLISH" : "BEARISH";
    if (!["HIGH", "MEDIUM", "LOW"].includes(result.confidence)) result.confidence = "MEDIUM";
    if (!Array.isArray(result.keyPoints)) result.keyPoints = [];
    return result;
}

// ─── Synthesizer ──────────────────────────────────────────────────────────────

function roundToHalf(n) { return Math.round(n * 2) / 2; }

async function runSynthesizer(stockInfo, symbol, priceData, tech, sent, risk, consensus, mktCtx, ind, intradayCtx) {
    const cp = priceData?.price ?? null;
    const todayChg = priceData?.changePercent != null
        ? (priceData.changePercent > 0 ? "+" : "") + priceData.changePercent.toFixed(2) + "%"
        : "N/A";

    const voteSummary = `${consensus.bullish} BULLISH | ${consensus.bearish} BEARISH | ${consensus.neutral} abstained → ${consensus.direction} (${consensus.label})`;
    const mktSummary  = describeMarketContext(mktCtx, stockInfo.sector);
    const mktScore    = macroSignal(mktCtx);

    const ic = intradayCtx;
    const intradayBlock = ic && !ic.noSessionData ? `
Gap at open: ${ic.gapPct != null ? (ic.gapPct > 0 ? "+" : "") + ic.gapPct + "% vs prev close" : "N/A"}
Opening Range (9:15–9:44 AM): High ₹${ic.orHigh ?? "N/A"} / Low ₹${ic.orLow ?? "N/A"}
Price vs Opening Range: ${ic.orStatus ?? "N/A"}
Intraday VWAP (today): ₹${ic.intradayVwap ?? "N/A"} — price ${ic.priceAboveVwap ? "ABOVE (bullish)" : "BELOW (bearish)"}
15-min RSI: ${ic.rsi15m ?? "N/A"}
15-min EMA9/21: ${ic.ema9 ?? "N/A"} / ${ic.ema21 ?? "N/A"} → ${ic.emaSignal ?? "N/A"}` : "Market not open yet or no intraday data.";

    const prompt = `You are a veteran NSE intraday trader (15+ years). You are making a LIVE call right now — squared off before 3:15 PM IST. Be decisive.

STOCK: ${stockInfo.name} (${stockInfo.sector}, ${symbol})
LIVE PRICE: ₹${cp ?? "unknown"} | Today: ${todayChg}

━━━ TOP-DOWN MACRO ━━━
${mktSummary}
Macro score: ${mktScore === 1 ? "+1 (tailwind — confirm longs)" : mktScore === -1 ? "-1 (headwind — confirm shorts, fade longs)" : "0 (neutral)"}

━━━ INTRADAY SETUP (15-min — this is your entry trigger) ━━━${intradayBlock}

━━━ ANALYST VOTES ━━━
TECHNICAL: ${tech.signal} (${tech.confidence})
  • ${tech.keyPoints[0] ?? "—"}  • ${tech.keyPoints[1] ?? "—"}

SENTIMENT: ${sent.sentiment} (${sent.confidence})
  • ${sent.keyPoints[0] ?? "—"}

RISK: ${risk.riskLevel} risk | Bias: ${risk.bias} (${risk.confidence})
  • ${risk.keyPoints[0] ?? "—"}

VOTE TALLY: ${voteSummary}

━━━ YOUR DECISION ━━━

ACTION RULES (strict order):
1. BULLISH tally → BUY. BEARISH tally → SELL. Tied → HOLD.
2. Intraday trigger required for BUY: price above OR + above intraday VWAP. If not met → HOLD.
3. Intraday trigger required for SELL: price below OR + below intraday VWAP. If not met → HOLD.
4. Macro score −1 + BUY → downgrade to HOLD unless unanimous consensus.
5. Macro score −1 + SELL → confirms SELL, raise confidence.
6. Gap > +0.5% = bullish day bias. Gap < −0.5% = bearish day bias.

PRICES (rounded to nearest ₹0.50):
- entry BUY: just above current price or OR high breakout level. entry SELL: just below current or OR low.
- target BUY: +0.8%–+1.3%. target SELL: −0.8%–−1.3%.
- stopLoss BUY: 0.35%–0.5% below entry. stopLoss SELL: 0.35%–0.5% above entry.
- HIGH riskLevel → tighter stops.

traderNote: 2–3 sentences, first person. Name the exact intraday trigger (OR breakout, VWAP reclaim, gap direction).
Mention actual ₹ levels. Say when to square off.
Example: "Gap-up open and HDFC broke above the 9:44 AM OR high of ₹1,748 with intraday VWAP support at ₹1,742 — I'm long here. Target ₹1,768, stop at ₹1,734. Square off by 2:45 PM regardless."

reasoning: Three sharp one-liners — intraday setup / sentiment / risk.

Respond ONLY in this exact JSON — zero text outside JSON:
{
  "action": "BUY" | "SELL" | "HOLD",
  "mode": "INTRADAY",
  "confidence": "HIGH" | "MEDIUM" | "LOW",
  "entry": <number>,
  "target": <number>,
  "stopLoss": <number>,
  "traderNote": "<2-3 sentences, first person, specific ₹ levels>",
  "reasoning": ["<intraday setup one-liner>", "<sentiment one-liner>", "<risk one-liner>"]
}`;

    const result = await callGroqSafe(MODELS.synthesizer, prompt, 0.4, 650);

    // Sanitise
    if (!["BUY", "SELL", "HOLD"].includes(result.action))
        result.action = consensus.direction === "BULLISH" ? "BUY"
            : consensus.direction === "BEARISH" ? "SELL" : "HOLD";

    // Macro override — if market is crashing and LLM still said BUY, downgrade
    if (result.action === "BUY" && mktScore === -1 && consensus.label !== "unanimous")
        result.action = "HOLD";

    result.mode = "INTRADAY";
    if (!["HIGH", "MEDIUM", "LOW"].includes(result.confidence)) result.confidence = consensus.impliedConfidence;

    // Fallback prices — always intraday ranges
    if (cp) {
        const isBuy = result.action === "BUY";
        if (!result.entry    || result.entry    <= 0) result.entry    = roundToHalf(cp * (isBuy ? 0.998 : 1.002));
        if (!result.target   || result.target   <= 0) result.target   = roundToHalf(result.entry * (isBuy ? 1.012 : 0.988));
        if (!result.stopLoss || result.stopLoss <= 0) result.stopLoss = roundToHalf(result.entry * (isBuy ? 0.995 : 1.005));
    }

    if (result.entry)    result.entry    = roundToHalf(result.entry);
    if (result.target)   result.target   = roundToHalf(result.target);
    if (result.stopLoss) result.stopLoss = roundToHalf(result.stopLoss);

    if (result.entry && result.target)
        result.targetPct  = Math.round(((result.target   - result.entry) / result.entry) * 10000) / 100;
    if (result.entry && result.stopLoss)
        result.stopLossPct = Math.abs(Math.round(((result.stopLoss - result.entry) / result.entry) * 10000) / 100);

    if (!Array.isArray(result.reasoning) || result.reasoning.length === 0)
        result.reasoning = ["Technical indicators provide directional bias.", "Market sentiment reflects crowd positioning.", "Risk profile assessed for position sizing."];
    result.reasoning = result.reasoning.slice(0, 3);

    return result;
}

// ─── Main orchestrator ────────────────────────────────────────────────────────

export async function analyseStock(symbol) {
    if (!STOCK_MAP.has(symbol)) throw new Error(`${symbol} is not in Zentrade's stock universe`);

    const cacheKey = `ai:v4:analyse:${symbol}`;
    const cached = await redis.get(cacheKey);
    if (cached) return { ...JSON.parse(cached), cached: true };

    const stockInfo = STOCK_MAP.get(symbol);
    logger.info("AIEngine", `Starting analysis for ${symbol} (${stockInfo.sector})`);

    // Fetch everything in parallel — daily + 15-min + news + macro all at once
    const [candles, candles15m, news, rawPrice, mktCtx] = await Promise.all([
        fetchOHLCV(stockInfo.yahooSymbol),
        fetchIntraday(stockInfo.yahooSymbol),
        fetchStockNews(stockInfo.yahooSymbol),
        redis.get(`stock:${symbol}`),
        getMarketContext(stockInfo.sectorIndex, redis),
    ]);

    const indicators   = computeIndicators(candles);
    const intradayCtx  = computeIntradayContext(candles15m);
    const priceData    = rawPrice ? JSON.parse(rawPrice) : null;

    logger.info("AIEngine", `${symbol} | iVWAP: ₹${intradayCtx?.intradayVwap ?? "N/A"} | OR: ${intradayCtx?.orStatus ?? "not open"} | gap: ${intradayCtx?.gapPct != null ? intradayCtx.gapPct + "%" : "N/A"}`);

    const [techResult, sentResult, riskResult] = await Promise.all([
        runTechnicalAgent(stockInfo, symbol, priceData, indicators, intradayCtx),
        runSentimentAgent(stockInfo, symbol, news, priceData, indicators),
        runRiskAgent(stockInfo, symbol, priceData, indicators, mktCtx),
    ]);

    logger.info("AIEngine", `${symbol}: tech=${techResult.signal} sent=${sentResult.sentiment} risk=${riskResult.bias}`);

    const consensus = computeConsensus(techResult.signal, sentResult.sentiment, riskResult.bias);
    logger.info("AIEngine", `${symbol} consensus: ${consensus.direction} (${consensus.label}) | macro score: ${macroSignal(mktCtx)}`);

    const finalResult = await runSynthesizer(stockInfo, symbol, priceData, techResult, sentResult, riskResult, consensus, mktCtx, indicators, intradayCtx);

    const output = {
        action:      finalResult.action,
        mode:        finalResult.mode,
        confidence:  finalResult.confidence,
        entry:       finalResult.entry,
        target:      finalResult.target,
        stopLoss:    finalResult.stopLoss,
        targetPct:   finalResult.targetPct,
        stopLossPct: finalResult.stopLossPct,
        traderNote:  finalResult.traderNote,
        reasoning:   finalResult.reasoning,
        consensus:   consensus.label,
        vwap20:      indicators.vwap20,
        aboveVWAP:   indicators.aboveVWAP,
        intraday: intradayCtx && !intradayCtx.noSessionData ? {
            gapPct:        intradayCtx.gapPct,
            orHigh:        intradayCtx.orHigh,
            orLow:         intradayCtx.orLow,
            orStatus:      intradayCtx.orStatus,
            intradayVwap:  intradayCtx.intradayVwap,
            priceAboveVwap: intradayCtx.priceAboveVwap,
            rsi15m:        intradayCtx.rsi15m,
            emaSignal:     intradayCtx.emaSignal,
        } : null,
        macro: {
            niftyChange:    mktCtx?.nifty?.changePercent ?? null,
            niftyAboveOpen: mktCtx?.nifty?.aboveDailyOpen ?? null,
            sectorChange:   mktCtx?.sector?.changePercent ?? null,
            sector:         stockInfo.sector,
            score:          macroSignal(mktCtx),
        },
        agents: {
            technical: { signal: techResult.signal,    confidence: techResult.confidence, keyPoints: techResult.keyPoints },
            sentiment: { signal: sentResult.sentiment, confidence: sentResult.confidence, keyPoints: sentResult.keyPoints },
            risk:      { riskLevel: riskResult.riskLevel, bias: riskResult.bias, confidence: riskResult.confidence, keyPoints: riskResult.keyPoints },
        },
        cachedAt: Date.now(),
        cached: false,
    };

    await redis.setex(cacheKey, CACHE_TTL, JSON.stringify(output));
    logger.info("AIEngine", `${symbol} → ${output.action} @ ₹${output.entry} | T: ₹${output.target} | SL: ₹${output.stopLoss} | ${consensus.label}`);
    return output;
}
