import { describe, it, expect } from "vitest";
import { buildEpisode, episodeKey, EPISODE_SEMANTICS, type EpisodeSource } from "../episode.js";

const DECISION_ID = "6f9619ff-8b86-4d01-b42d-00cf4fc964ff";

const source = (overrides: Partial<EpisodeSource> = {}): EpisodeSource => ({
    decisionId: DECISION_ID,
    horizon: "intraday",
    symbol: "RELIANCE",
    venue: "NSE",
    action: "BUY",
    mode: "INTRADAY",
    confidence: "MEDIUM",
    regime: "UP_LOWVOL",
    decisionDate: "2026-07-10",
    basis: "squareoff",
    hit: "target",
    realizedReturnBps: 100,
    stances: ["BULLISH", "BULLISH", "NEUTRAL"],
    ...overrides,
});

describe("memory identity law", () => {
    it("the key names a position in experience: (decisionId, horizon) and nothing else", () => {
        const base = buildEpisode(source());
        const differentEverything = buildEpisode(
            source({ symbol: "TCS", action: "SELL", regime: "DOWN_HIGHVOL", hit: "stop", realizedReturnBps: -300, stances: [] })
        );
        expect(differentEverything.memoryKey).toBe(base.memoryKey);

        expect(buildEpisode(source({ horizon: "5d" })).memoryKey).not.toBe(base.memoryKey);
        expect(
            buildEpisode(source({ decisionId: "00000000-0000-4000-8000-000000000000" })).memoryKey
        ).not.toBe(base.memoryKey);
    });

    it("keys are stable sha256 hex, reproducible from the bare pair", () => {
        const episode = buildEpisode(source());
        expect(episode.memoryKey).toMatch(/^[0-9a-f]{64}$/);
        expect(episode.memoryKey).toBe(episodeKey(DECISION_ID, "intraday"));
        expect(episodeKey(DECISION_ID, "intraday")).toBe(episodeKey(DECISION_ID, "intraday"));
    });
});

describe("deterministic narrative (regenerable, therefore never stored)", () => {
    it("same journal facts -> byte-identical narrative, every time", () => {
        const a = buildEpisode(source());
        const b = buildEpisode(source());
        expect(a).toEqual(b);
        expect(a.narrative).toBe(
            "BUY RELIANCE (NSE) intraday at MEDIUM confidence in UP_LOWVOL on 2026-07-10; " +
                "analysts 2 bullish / 0 bearish of 3; horizon intraday: outcome target (+100bps, basis squareoff)"
        );
        expect(a.semantics).toBe(EPISODE_SEMANTICS);
    });

    it("losses, null returns and stance-free failures render honestly", () => {
        const loss = buildEpisode(source({ hit: "stop", realizedReturnBps: -50, stances: ["BEARISH"] }));
        expect(loss.narrative).toContain("outcome stop (-50bps");
        expect(loss.narrative).toContain("analysts 0 bullish / 1 bearish of 1");

        const bare = buildEpisode(source({ realizedReturnBps: null, stances: [] }));
        expect(bare.narrative).toContain("(unquantified");
        expect(bare.narrative).toContain("no analyst stances");
    });

    it("refuses to form an episode over incomplete experience", () => {
        expect(() => buildEpisode(source({ decisionId: "" }))).toThrow(/missing decisionId/);
        expect(() => buildEpisode(source({ regime: "" }))).toThrow(/missing regime/);
    });
});
