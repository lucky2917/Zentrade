import { describe, expect, it } from "vitest";
import { revalidate, VERDICT, CODE, DEFAULT_TOLERANCE, driftBps }
    from "../services/execution/revalidate.js";
import { evaluate as evaluateRisk, DECISION } from "../services/autonomous/riskGate.js";

const NOW = Date.parse("2026-08-31T05:30:00Z");

const observation = (over = {}) => ({
    pricePaise: 100_000, atMs: NOW - 5_000, tickSeq: 4200, ...over });

const world = (over = {}) => ({
    nowMs: NOW, pricePaise: 100_000, priceAgeMs: 1_000, position: null, ...over });

const entry = (over = {}) => ({
    action: "BUY", side: "BUY", symbol: "RELIANCE", quantity: 200,
    pricePaise: 100_000, correlationId: "c1", ...over });

const exit = (over = {}) => ({
    action: "EXIT", side: "SELL", symbol: "RELIANCE", quantity: 200,
    pricePaise: 100_000, correlationId: "c1", ...over });

describe("a decision cannot execute against a materially different market", () => {
    it("proceeds when the world has not moved", () => {
        const r = revalidate({ intent: entry(), observation: observation(), world: world() });
        expect(r.verdict).toBe(VERDICT.PROCEED);
        expect(r.intent.pricePaise).toBe(100_000);
    });

    it("refuses an entry when price drifted beyond tolerance", () => {
        // 100_000 -> 100_400 is 40 bps, over the 30 bps entry limit.
        const r = revalidate({ intent: entry(), observation: observation(),
                               world: world({ pricePaise: 100_400 }) });
        expect(r.verdict).toBe(VERDICT.REJECT);
        expect(r.code).toBe(CODE.PRICE_DRIFT);
        expect(r.reason).toMatch(/40 bps/);
    });

    it("refuses a drift downward just as readily", () => {
        const r = revalidate({ intent: entry(), observation: observation(),
                               world: world({ pricePaise: 99_600 }) });
        expect(r.verdict).toBe(VERDICT.REJECT);
        expect(r.code).toBe(CODE.PRICE_DRIFT);
    });

    it("re-prices inside tolerance rather than executing at the stale price", () => {
        const r = revalidate({ intent: entry(), observation: observation(),
                               world: world({ pricePaise: 100_200 }) });
        expect(r.verdict).toBe(VERDICT.REPRICED);
        expect(r.intent.pricePaise).toBe(100_200);          // executes at the market
        expect(r.intent.referencePricePaise).toBe(100_000); // remembers the thesis price
    });

    it("never blocks an exit on drift, however far the price has run", () => {
        const r = revalidate({ intent: exit(), observation: observation(),
                               world: world({ pricePaise: 88_000, position: { quantity: 200 } }) });
        expect(r.verdict).toBe(VERDICT.REPRICED);
        expect(r.intent.pricePaise).toBe(88_000);
    });

    it("expires a decision the model took too long to produce", () => {
        const r = revalidate({ intent: entry(),
                               observation: observation({ atMs: NOW - 45_000 }), world: world() });
        expect(r.verdict).toBe(VERDICT.REJECT);
        expect(r.code).toBe(CODE.DECISION_EXPIRED);
    });

    it("refuses new exposure on stale data but lets an exit through", () => {
        const staleWorld = world({ priceAgeMs: 120_000, position: { quantity: 200 } });
        expect(revalidate({ intent: entry(), observation: observation(), world: staleWorld }).code)
            .toBe(CODE.STALE_DATA);
        const out = revalidate({ intent: exit(), observation: observation(), world: staleWorld });
        expect(out.verdict).not.toBe(VERDICT.REJECT);
        expect(out.staleExit).toBe(true);
    });

    it("refuses an exit for a position that closed while the model was thinking", () => {
        const r = revalidate({ intent: exit(), observation: observation(),
                               world: world({ position: { quantity: 0 } }) });
        expect(r.verdict).toBe(VERDICT.REJECT);
        expect(r.code).toBe(CODE.POSITION_GONE);
    });

    it("sizes an exit down to what is actually still held", () => {
        const r = revalidate({ intent: exit({ quantity: 200 }), observation: observation(),
                               world: world({ position: { quantity: 80 } }) });
        expect(r.verdict).toBe(VERDICT.REPRICED);
        expect(r.intent.quantity).toBe(80);
        expect(r.reason).toMatch(/POSITION_REDUCED/);
    });

    it("refuses when there is no current price at all", () => {
        const r = revalidate({ intent: entry(), observation: observation(),
                               world: world({ pricePaise: null }) });
        expect(r.code).toBe(CODE.NO_PRICE);
    });

    it("notices a position that appeared since the decision", () => {
        const r = revalidate({ intent: entry(), observation: observation(),
                               world: world({ position: { quantity: 50 } }) });
        expect(r.reason).toMatch(/position opened since the decision/);
    });

    it("computes drift symmetrically", () => {
        expect(driftBps(100_000, 100_100)).toBeCloseTo(10);
        expect(driftBps(100_000, 99_900)).toBeCloseTo(-10);
        expect(driftBps(0, 100)).toBeNull();
    });
});

describe("revalidation hands the risk gate something it can actually judge", () => {
    const portfolio = { cashPaise: 100_000_000, positions: [], positionCount: 0,
                        grossExposurePaise: 0, netExposurePaise: 0 };

    it("the gate's own drift guard is now live, because the two prices differ", () => {
        const r = revalidate({ intent: entry(), observation: observation(),
                               world: world({ pricePaise: 100_200 }) });
        // Inside revalidation tolerance, so it proceeds; the gate sees a real
        // 20 bps difference rather than a value compared with itself.
        expect(r.intent.pricePaise).not.toBe(r.intent.referencePricePaise);
        const risk = evaluateRisk(r.intent, { portfolio, nowMs: NOW, session: {} });
        expect(risk.decision).toBe(DECISION.ALLOW);
    });

    it("the gate's proposal-age guard is now live, because createdAtMs is set", () => {
        const r = revalidate({ intent: entry(), observation: observation(), world: world() });
        expect(Number.isFinite(r.intent.createdAtMs)).toBe(true);
        // Six minutes later the gate refuses it on age alone.
        const risk = evaluateRisk(r.intent, { portfolio, nowMs: NOW + 6 * 60 * 1000, session: {} });
        expect(risk.decision).toBe(DECISION.REJECT);
        expect(risk.code).toBe("STALE_PROPOSAL");
    });

    it("without revalidation both guards are structurally dead", () => {
        // The pre-fix intent: same price for both fields, no createdAtMs.
        const raw = entry({ referencePricePaise: 100_000 });
        const risk = evaluateRisk(raw, { portfolio, nowMs: NOW + 60 * 60 * 1000, session: {} });
        expect(risk.decision).toBe(DECISION.ALLOW);   // an hour-old decision, approved
    });
});
