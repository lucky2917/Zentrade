import { describe, expect, it, vi } from "vitest";
import { makeMemoryRetriever, memoryEvidence, summariseMemories }
    from "../services/memory/repository.js";
import { buildTraderState } from "../services/reasoning/traderState.js";
import { TIER } from "../services/reasoning/evidence.js";

// M11-M17 built the whole memory chain — outcome labelling, regimes,
// calibration, episodic memory, retrieval, reflection — and then nothing read
// it. The brain remembered everything and consulted none of it, so it began
// every session as naive as its first.
//
// Retrieval now reaches the decision path. The rules that make it safe are not
// relaxed: eligibility is strictly before the decision's instant, memories are
// OBSERVATIONS rather than advice, and a failure degrades the decision instead
// of failing it.

const row = (over = {}) => ({
    memory_key: "a".repeat(64), decision_id: "d-1", horizon: "1d",
    symbol: "RELIANCE", venue: "NSE", action: "BUY", mode: "INTRADAY",
    confidence: "HIGH", regime: "TREND_UP_VOL_LOW", hit: "target",
    basis: "path", realized_return_bps: 120, decision_date: "2026-08-01", ...over,
});

const ASOF = "2026-08-31T04:30:00.000Z";   // 10:00 IST

describe("episodic memory reaches reasoning", () => {
    it("ranks candidates and returns them", async () => {
        const db = { query: vi.fn(async () => ({ rows: [
            row(), row({ memory_key: "b".repeat(64), decision_id: "d-2", hit: "stop",
                         realized_return_bps: -80, decision_date: "2026-08-10" }),
        ] })) };
        const retrieve = makeMemoryRetriever({ db });
        const got = await retrieve({ symbol: "RELIANCE", regime: "TREND_UP_VOL_LOW",
                                     action: "BUY", asOf: ASOF });
        expect(got).toHaveLength(2);
        expect(got.every((m) => typeof m.score === "number")).toBe(true);
    });

    // A memory that contains the outcome of the decision it is informing is
    // look-ahead, and look-ahead is the one thing this whole stack exists to
    // prevent.
    it("bounds eligibility strictly before the decision's IST session", async () => {
        const db = { query: vi.fn(async () => ({ rows: [] })) };
        await makeMemoryRetriever({ db })({ symbol: "RELIANCE", asOf: ASOF });

        const [, params] = db.query.mock.calls[0];
        expect(params[1]).toBe("2026-08-31");
        expect(db.query.mock.calls[0][0]).toMatch(/decision_date\s*<\s*\$2/);
    });

    it("asks only for the frozen episodic semantics", async () => {
        const db = { query: vi.fn(async () => ({ rows: [] })) };
        await makeMemoryRetriever({ db })({ symbol: "RELIANCE", asOf: ASOF });
        expect(db.query.mock.calls[0][1][0]).toBe("episodic_v1");
    });

    it("returns nothing rather than guessing when the instant is unusable", async () => {
        const db = { query: vi.fn() };
        const retrieve = makeMemoryRetriever({ db });
        expect(await retrieve({ symbol: "RELIANCE", asOf: "not a date" })).toEqual([]);
        expect(await retrieve({ symbol: "", asOf: ASOF })).toEqual([]);
        expect(db.query).not.toHaveBeenCalled();
    });
});

describe("a memory is an observation, never advice", () => {
    const memories = [
        { memoryKey: "a".repeat(64), decisionDate: "2026-08-01", action: "BUY",
          symbol: "RELIANCE", confidence: "HIGH", regime: "TREND_UP_VOL_LOW",
          hit: "target", realizedReturnBps: 120 },
        { memoryKey: "b".repeat(64), decisionDate: "2026-08-10", action: "BUY",
          symbol: "RELIANCE", confidence: "HIGH", regime: "TREND_UP_VOL_LOW",
          hit: "stop", realizedReturnBps: -80 },
    ];

    it("enters the evidence chain as OBSERVATION, not FACT and not INFERENCE", () => {
        const evidence = memoryEvidence(memories);
        expect(evidence).toHaveLength(2);
        for (const e of evidence) {
            expect(e.tier).toBe(TIER.OBSERVATION);
            expect(e.source).toMatch(/^memory:/);
        }
    });

    // Contradictory episodes must surface together. Hiding one is how a system
    // convinces itself of something the record does not support.
    it("surfaces contradictory outcomes side by side", () => {
        const statements = memoryEvidence(memories).map((e) => e.statement).join(" | ");
        expect(statements).toMatch(/resolved target/);
        expect(statements).toMatch(/resolved stop/);
        expect(summariseMemories(memories)).toBe(
            "2 comparable past decision(s): 1 stop, 1 target");
    });

    it("says nothing at all when there is nothing to say", () => {
        expect(memoryEvidence([])).toEqual([]);
        expect(summariseMemories([])).toBeNull();
    });

    it("reaches the TraderState the prompts are built from", () => {
        const state = buildTraderState({
            symbol: "RELIANCE", context: { price: 1000, asOf: ASOF }, memories,
            asOf: ASOF,
        });
        expect(state.memory.summary).toMatch(/2 comparable past decision/);
        expect(state.memory.episodes).toHaveLength(2);
        expect(state.evidence.some((e) => e.source.startsWith("memory:"))).toBe(true);
        // And it does not displace the deterministic evidence.
        expect(state.evidence.some((e) => e.tier === TIER.FACT)).toBe(true);
    });

    it("is absent, not invented, when nothing was retrieved", () => {
        const state = buildTraderState({
            symbol: "RELIANCE", context: { price: 1000, asOf: ASOF }, asOf: ASOF });
        expect(state.memory.summary).toBeNull();
        expect(state.memory.episodes).toEqual([]);
    });
});
