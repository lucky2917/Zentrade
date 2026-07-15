import { describe, it, expect } from "vitest";
import { buildEvidenceBundle, renderEvidenceLegend, validateCitations, parseKeyPoints } from "../index.js";

const fullInputs = {
    priceData: { price: 1518.4, changePercent: 1.02, timestamp: 1783929474262 },
    indicators: {
        rsi14: 61.2,
        sma20: 1500.5,
        sma50: 1471.1,
        macd: { macdLine: 4.2, signal: "BULLISH" },
        momentum: { fiveDay: 2.1, twentyDay: 4.4 },
        volumeTrend: "elevated",
        positionIn52W: 78,
        yearHigh: 1608.8,
        yearLow: 1156.0,
        vwap20: 1495.2,
        aboveVWAP: true,
    },
    intradayCtx: {
        noSessionData: false,
        gapPct: 0.6,
        orHigh: 1521.0,
        orLow: 1508.2,
        orStatus: "ABOVE",
        intradayVwap: 1512.4,
        priceAboveVwap: true,
        rsi15m: 63,
        ema9: 1516.1,
        ema21: 1511.8,
        emaSignal: "BULLISH",
    },
    marketCtx: { nifty: { changePercent: 0.8 }, sector: { changePercent: 1.4 } },
    news: [
        { headline: "Reliance wins spectrum auction", source: "ET" },
        { headline: "Refining margins improve", source: "Mint" },
    ],
};

describe("buildEvidenceBundle", () => {
    it("emits stable refs across every kind for full inputs", () => {
        const bundle = buildEvidenceBundle(fullInputs);
        const refs = bundle.map((i) => i.ref);
        expect(refs).toEqual([
            "price:live",
            "ind:rsi14",
            "ind:sma",
            "ind:macd",
            "ind:momentum",
            "ind:volume",
            "ind:52w",
            "ind:vwap20",
            "intra:gap",
            "intra:or",
            "intra:vwap",
            "intra:rsi15",
            "intra:ema",
            "macro:nifty",
            "macro:sector",
            "news:1",
            "news:2",
        ]);
        expect(new Set(refs).size).toBe(refs.length); // refs unique
        expect(bundle.every((i) => i.sourceRef.length > 0)).toBe(true);
    });

    it("is deterministic: identical inputs -> identical bundle", () => {
        expect(buildEvidenceBundle(fullInputs)).toEqual(buildEvidenceBundle(fullInputs));
    });

    it("absent data yields no item — agents cannot cite what was not observed", () => {
        const sparse = buildEvidenceBundle({
            priceData: null,
            indicators: { rsi14: 44.1 },
            intradayCtx: { noSessionData: true },
            marketCtx: null,
            news: [],
        });
        expect(sparse.map((i) => i.ref)).toEqual(["ind:rsi14"]);
    });

    it("caps news at 8 items and legend renders one line per item", () => {
        const many = buildEvidenceBundle({
            ...fullInputs,
            news: Array.from({ length: 12 }, (_, i) => ({ headline: `h${i}`, source: "s" })),
        });
        expect(many.filter((i) => i.kind === "news")).toHaveLength(8);
        const legend = renderEvidenceLegend(many);
        expect(legend.split("\n")).toHaveLength(many.length);
        expect(legend).toContain("[ind:rsi14]");
    });
});

describe("validateCitations", () => {
    const refs = new Set(["ind:rsi14", "news:1", "intra:vwap"]);

    it("accepts fully cited claims", () => {
        const report = validateCitations(
            [
                { point: "RSI at 61 supports momentum", refs: ["ind:rsi14"] },
                { point: "spectrum win is a tailwind", refs: ["news:1", "intra:vwap"] },
            ],
            refs,
        );
        expect(report.status).toBe("ok");
        expect(report.uncitedCount).toBe(0);
        expect(report.unknownRefs).toEqual([]);
    });

    it("uncited claim invalidates the run (bare strings are uncited, not pardoned)", () => {
        const report = validateCitations(["price is rising"], refs);
        expect(report.status).toBe("invalid");
        expect(report.uncitedCount).toBe(1);
    });

    it("citing evidence that was never in the bundle invalidates the run", () => {
        const report = validateCitations([{ point: "vol spike", refs: ["ind:volume"] }], refs);
        expect(report.status).toBe("invalid");
        expect(report.unknownRefs).toEqual(["ind:volume"]);
    });

    it("empty or non-array claims are invalid — an agent must say something citable", () => {
        expect(validateCitations([], refs).status).toBe("invalid");
        expect(validateCitations(undefined, refs).status).toBe("invalid");
        expect(validateCitations("not-an-array", refs).status).toBe("invalid");
    });

    it("parseKeyPoints coerces without pardoning and caps lengths", () => {
        const parsed = parseKeyPoints([
            "bare string",
            { point: "x".repeat(400), refs: ["a:b"] },
            { garbage: true },
            42,
        ]);
        expect(parsed[0]).toEqual({ point: "bare string", refs: [] });
        expect(parsed[1]!.point).toHaveLength(300);
        // non-object garbage coerces to an EMPTY (thus uncited, thus invalid)
        // claim — the parser never fabricates content from junk
        expect(parsed[2]).toEqual({ point: "", refs: [] });
        expect(parsed[3]).toEqual({ point: "", refs: [] });
    });
});
