import { describe, expect, it } from "vitest";
import { buildMarketState, BREADTH, blocksNewExposure, MIN_SYMBOLS_FOR_BREADTH }
    from "../services/intelligence/marketState.js";
import { buildTraderState } from "../services/reasoning/traderState.js";
import { synthesise } from "../services/reasoning/synthesis.js";

const spread = (n, move) => Object.fromEntries(
    Array.from({ length: n }, (_, i) => [`S${i}`, move]));

describe("market breadth is measured, never assumed", () => {
    it("is UNKNOWN below the minimum sample, and says so", () => {
        const m = buildMarketState({ moves: spread(5, -0.02) });
        expect(m.breadth).toBe(BREADTH.UNKNOWN);
        expect(m.basis).toMatch(/breadth needs/);
    });

    it("recognises a broad decline", () => {
        const moves = { ...spread(16, -0.021), A: 0.004, B: 0.002, C: 0.001, D: 0.003 };
        const m = buildMarketState({ moves });
        expect(m.breadth).toBe(BREADTH.BROAD_DECLINE);
        expect(m.direction).toBe("DOWN");
        expect(m.shock).toBe(true);
        expect(m.severeShock).toBe(true);
    });

    it("a synchronised but tiny move is not a shock", () => {
        const m = buildMarketState({ moves: spread(20, -0.001) });
        expect(m.direction).toBe("DOWN");
        expect(m.shock).toBe(false);
    });

    it("a mixed tape is MIXED", () => {
        const moves = { ...spread(10, 0.02), ...Object.fromEntries(
            Array.from({ length: 10 }, (_, i) => [`D${i}`, -0.02])) };
        expect(buildMarketState({ moves }).breadth).toBe(BREADTH.MIXED);
    });

    it("blocks buying into a decline and selling into an advance", () => {
        const down = buildMarketState({ moves: spread(20, -0.02) });
        expect(blocksNewExposure(down, "BUY").blocked).toBe(true);
        expect(blocksNewExposure(down, "SELL")).toBeNull();
        const up = buildMarketState({ moves: spread(20, 0.02) });
        expect(blocksNewExposure(up, "SELL").blocked).toBe(true);
    });
});

describe("every decision carries market state", () => {
    const context = {
        asOf: "2026-08-31T05:30:00Z", sessionPhase: "MID_SESSION", minutesIntoSession: 165,
        price: 1000, vwap: 995, vwapDistance: 0.005, vwapAvailable: true,
        barsSeen: { m1: 46, m5: 10, m15: 4 },
        mtf: { complete: true, aligned: true, alignedDirection: "UP", conflict: false,
               direction1m: "UP", direction5m: "UP", direction15m: "UP",
               volatilityRatio: 1.1, volatilityExpanding: false, timeframesKnown: 3 },
    };

    it("says so explicitly when breadth was not measured", () => {
        const state = buildTraderState({ symbol: "X", context, asOf: new Date() });
        expect(state.market.breadth).toBe("UNKNOWN");
        expect(state.evidence.some((e) => /not evidence that the market is calm/.test(e.statement)))
            .toBe(true);
    });

    it("puts a market-wide decline into the evidence the trader reasons over", () => {
        const market = buildMarketState({ moves: spread(20, -0.021) });
        const state = buildTraderState({ symbol: "X", context, market, asOf: new Date() });
        expect(state.market.breadth).toBe(BREADTH.BROAD_DECLINE);
        expect(state.market.shock).toBe(true);
        expect(state.evidence.some((e) => /market-wide decline in progress/.test(e.statement)))
            .toBe(true);
    });

    it("refuses a long into a collapse however good the single chart looks", () => {
        const market = buildMarketState({ moves: spread(20, -0.021) });
        const state = buildTraderState({ symbol: "X", context, market, asOf: new Date() });
        const result = synthesise({
            proposal: { action: "BUY", supportingEvidence: ["a", "b", "c"],
                        contradictingEvidence: [], stopPaise: 99_000, targetPaise: 105_000,
                        quantity: 100 },
            traderState: state, limits: {} });
        expect(result.action).toBe("HOLD");
        expect(result.downgraded).toBe(true);
        expect(result.reasons.join(" ")).toMatch(/market-wide decline/);
    });

    it("does not refuse the same trade when the market is merely mixed", () => {
        const moves = { ...spread(10, 0.02), ...Object.fromEntries(
            Array.from({ length: 10 }, (_, i) => [`D${i}`, -0.02])) };
        const state = buildTraderState({
            symbol: "X", context, market: buildMarketState({ moves }), asOf: new Date() });
        const result = synthesise({
            proposal: { action: "BUY", supportingEvidence: ["a", "b", "c"],
                        contradictingEvidence: [], stopPaise: 99_000, targetPaise: 105_000,
                        quantity: 100 },
            traderState: state, limits: {} });
        expect(result.action).toBe("BUY");
    });

    it("never blocks an exit because of market breadth", () => {
        const market = buildMarketState({ moves: spread(20, -0.021) });
        const state = buildTraderState({
            symbol: "X", context, market,
            position: { quantity: 100, entryPricePaise: 100_000, currentPricePaise: 95_000,
                        holdingSeconds: 600, stopDistance: 0.1, targetDistance: 0.9 },
            asOf: new Date() });
        const result = synthesise({
            proposal: { action: "EXIT", supportingEvidence: [], contradictingEvidence: [],
                        stopPaise: null, targetPaise: null, quantity: 100 },
            traderState: state, limits: {} });
        expect(result.action).toBe("EXIT");
    });
});
