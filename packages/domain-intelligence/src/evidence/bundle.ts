import type { EvidenceItem } from "@zentrade/contracts";

/**
 * Evidence bundle assembly (M8). Pure: takes the exact market inputs the
 * pipeline fetched and emits immutable observation items with STABLE refs.
 * Null/absent data produces no item — agents cannot cite what was not
 * observed. Refs are deterministic so identical inputs replay identically.
 */

interface BundleInputs {
    priceData: { price?: number; changePercent?: number; timestamp?: number } | null;
    indicators: Record<string, unknown> | null;
    intradayCtx: Record<string, unknown> | null;
    marketCtx: { nifty?: unknown; sector?: unknown } | null;
    news: { headline: string; source: string }[];
}

const item = (
    ref: string,
    kind: EvidenceItem["kind"],
    sourceRef: string,
    content: unknown,
): EvidenceItem => ({ ref, kind, sourceRef, content, weight: null });

const has = (v: unknown): boolean => v !== null && v !== undefined;

export const buildEvidenceBundle = (inputs: BundleInputs): EvidenceItem[] => {
    const items: EvidenceItem[] = [];
    const { priceData, indicators: ind, intradayCtx: ic, marketCtx, news } = inputs;

    if (priceData && has(priceData.price)) {
        items.push(
            item("price:live", "price", "redis:stock-cache", {
                price: priceData.price,
                changePercent: priceData.changePercent ?? null,
                timestamp: priceData.timestamp ?? null,
            }),
        );
    }

    if (ind) {
        if (has(ind.rsi14)) items.push(item("ind:rsi14", "indicator", "fyers:candles:D:365", { rsi14: ind.rsi14 }));
        if (has(ind.sma20) && has(ind.sma50))
            items.push(item("ind:sma", "indicator", "fyers:candles:D:365", { sma20: ind.sma20, sma50: ind.sma50 }));
        if (has(ind.macd)) items.push(item("ind:macd", "indicator", "fyers:candles:D:365", ind.macd));
        if (has(ind.momentum)) items.push(item("ind:momentum", "indicator", "fyers:candles:D:365", ind.momentum));
        if (has(ind.volumeTrend))
            items.push(item("ind:volume", "indicator", "fyers:candles:D:365", { volumeTrend: ind.volumeTrend }));
        if (has(ind.positionIn52W))
            items.push(
                item("ind:52w", "indicator", "fyers:candles:D:365", {
                    positionIn52W: ind.positionIn52W,
                    yearHigh: ind.yearHigh ?? null,
                    yearLow: ind.yearLow ?? null,
                }),
            );
        if (has(ind.vwap20))
            items.push(item("ind:vwap20", "indicator", "fyers:candles:D:365", { vwap20: ind.vwap20, aboveVWAP: ind.aboveVWAP ?? null }));
    }

    if (ic && !(ic as { noSessionData?: boolean }).noSessionData) {
        if (has(ic.gapPct)) items.push(item("intra:gap", "intraday", "fyers:candles:15m:5d", { gapPct: ic.gapPct }));
        if (has(ic.orHigh) || has(ic.orLow))
            items.push(
                item("intra:or", "intraday", "fyers:candles:15m:5d", {
                    orHigh: ic.orHigh ?? null,
                    orLow: ic.orLow ?? null,
                    orStatus: ic.orStatus ?? null,
                }),
            );
        if (has(ic.intradayVwap))
            items.push(
                item("intra:vwap", "intraday", "fyers:candles:15m:5d", {
                    intradayVwap: ic.intradayVwap,
                    priceAboveVwap: ic.priceAboveVwap ?? null,
                }),
            );
        if (has(ic.rsi15m)) items.push(item("intra:rsi15", "intraday", "fyers:candles:15m:5d", { rsi15m: ic.rsi15m }));
        if (has(ic.ema9) && has(ic.ema21))
            items.push(
                item("intra:ema", "intraday", "fyers:candles:15m:5d", {
                    ema9: ic.ema9,
                    ema21: ic.ema21,
                    emaSignal: ic.emaSignal ?? null,
                }),
            );
    }

    if (marketCtx?.nifty) items.push(item("macro:nifty", "macro", "fyers:candles:index:D", marketCtx.nifty));
    if (marketCtx?.sector) items.push(item("macro:sector", "macro", "fyers:candles:index:D", marketCtx.sector));

    news.slice(0, 8).forEach((n, i) => {
        // stored as observed; renderers must escape — news text is untrusted
        items.push(item(`news:${i + 1}`, "news", "finnhub:company-news", { headline: n.headline, source: n.source }));
    });

    return items;
};

/** Render the citation legend appended to every agent prompt. */
export const renderEvidenceLegend = (items: EvidenceItem[]): string =>
    items.map((i) => `[${i.ref}] ${JSON.stringify(i.content)}`).join("\n");
