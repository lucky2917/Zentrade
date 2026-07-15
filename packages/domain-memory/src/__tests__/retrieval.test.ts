import { describe, it, expect } from "vitest";
import { scoreMemory, rankMemories, MAX_RETRIEVAL, type RetrievalCandidate } from "../retrieval.js";

const AS_OF = "2026-07-16";
let seq = 0;
const mem = (overrides: Partial<RetrievalCandidate> = {}): RetrievalCandidate => ({
    memoryKey: String(++seq).padStart(64, "0"),
    decisionId: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    horizon: "intraday",
    symbol: "RELIANCE",
    venue: "NSE",
    action: "BUY",
    mode: "INTRADAY",
    confidence: "MEDIUM",
    regime: "UP_LOWVOL",
    hit: "target",
    basis: "squareoff",
    realizedReturnBps: 100,
    decisionDate: AS_OF > "2026-07-15" ? "2026-07-15" : AS_OF,
    ...overrides,
});
const QUERY = { symbol: "RELIANCE", regime: "UP_LOWVOL", action: "BUY", mode: "INTRADAY" };

describe("scoring formula (retrieval_v1, hand-computed)", () => {
    it("perfect match, fresh, decisive = 0.5 + ~0.3 + 0.2", () => {
        const m = mem({ decisionDate: AS_OF });
        expect(scoreMemory(m, QUERY, AS_OF)).toBeCloseTo(1.0, 6);
    });

    it("outcome weight measures informativeness, not success: stop == target", () => {
        expect(scoreMemory(mem({ hit: "stop" }), QUERY, AS_OF)).toBe(scoreMemory(mem({ hit: "target" }), QUERY, AS_OF));
        expect(scoreMemory(mem({ hit: "neither" }), QUERY, AS_OF)).toBeLessThan(scoreMemory(mem({ hit: "stop" }), QUERY, AS_OF));
    });

    it("staleness decays with a 90-day half-life", () => {
        const fresh = scoreMemory(mem({ decisionDate: AS_OF }), QUERY, AS_OF);
        const stale = scoreMemory(mem({ decisionDate: "2026-04-17" }), QUERY, AS_OF); // 90d earlier
        expect(fresh - stale).toBeCloseTo(0.3 * 0.5, 6);
    });

    it("regime match is a weight, not a filter: cross-regime memories stay reachable", () => {
        const other = mem({ regime: "DOWN_HIGHVOL", decisionDate: AS_OF });
        expect(scoreMemory(other, QUERY, AS_OF)).toBeCloseTo(1.0 - 0.5 * 0.3, 6);
        expect(rankMemories([other], QUERY, AS_OF).length).toBe(1);
    });
});

describe("deterministic ordering", () => {
    it("input permutation never changes the ranked output", () => {
        const candidates = Array.from({ length: 40 }, (_, i) =>
            mem({
                symbol: i % 2 ? "RELIANCE" : "TCS",
                hit: ["target", "stop", "neither"][i % 3]!,
                decisionDate: `2026-0${(i % 6) + 1}-10`,
            }),
        );
        const forward = rankMemories(candidates, QUERY, AS_OF);
        const backward = rankMemories([...candidates].reverse(), QUERY, AS_OF);
        const shuffled = rankMemories([...candidates].sort(() => 0.5), QUERY, AS_OF);
        expect(backward).toEqual(forward);
        expect(shuffled).toEqual(forward);
    });

    it("equal scores and equal dates fall through to the bytewise memoryKey tiebreak", () => {
        const a = mem({ memoryKey: "b".repeat(64) });
        const b = mem({ memoryKey: "a".repeat(64) });
        const ranked = rankMemories([a, b], QUERY, AS_OF);
        expect(ranked.map((m) => m.memoryKey)).toEqual([b.memoryKey, a.memoryKey]);
    });
});

describe("diversity and duplicates", () => {
    it("one episode per decision: multi-horizon episodes collapse to the best-scored", () => {
        const decisionId = "00000000-0000-4000-8000-aaaaaaaaaaaa";
        const intraday = mem({ decisionId, horizon: "intraday" });
        const weekly = mem({ decisionId, horizon: "5d", decisionDate: "2026-01-02" });
        const ranked = rankMemories([weekly, intraday], QUERY, AS_OF);
        expect(ranked).toHaveLength(1);
        expect(ranked[0]!.horizon).toBe("intraday");
    });

    it("anti-echo-chamber: losses are guaranteed seats even when wins outscore them", () => {
        const wins = Array.from({ length: 20 }, () => mem({ hit: "target", decisionDate: AS_OF }));
        const losses = Array.from({ length: 5 }, () => mem({ hit: "stop", decisionDate: "2025-09-01" }));
        const ranked = rankMemories([...wins, ...losses], QUERY, AS_OF, 8);
        expect(ranked.filter((m) => m.hit === "stop").length).toBeGreaterThanOrEqual(2);
        expect(ranked).toHaveLength(8);
    });

    it("contradictory memories both surface: recall reports, reasoning resolves", () => {
        const won = mem({ hit: "target", realizedReturnBps: 150 });
        const lost = mem({ hit: "stop", realizedReturnBps: -150 });
        const keys = rankMemories([won, lost], QUERY, AS_OF).map((m) => m.memoryKey);
        expect(keys).toContain(won.memoryKey);
        expect(keys).toContain(lost.memoryKey);
    });

    it("the context budget is a hard cap", () => {
        const many = Array.from({ length: 100 }, () => mem());
        expect(rankMemories(many, QUERY, AS_OF).length).toBeLessThanOrEqual(MAX_RETRIEVAL);
        expect(rankMemories(many, QUERY, AS_OF, 99).length).toBeLessThanOrEqual(MAX_RETRIEVAL);
        expect(rankMemories(many, QUERY, AS_OF, 3)).toHaveLength(3);
    });
});
