import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import {
    decide, diffResults, engineMode, stopGoClient,
    shadowDivergences, resetShadowDivergences,
    ENGINE_TYPESCRIPT, ENGINE_SHADOW, ENGINE_GO,
} from "../services/decisionEngine.js";

// Shadow mode must never change what the agent does. These tests cover the
// switch itself: mode selection, rollback, divergence reporting, and the rule
// that a missing or disagreeing Go engine falls back to TypeScript.

const DAEMON = process.env.ZENTRADE_DECISIOND_PATH;
const daemonAvailable = Boolean(DAEMON) && existsSync(DAEMON);

const sample = {
    technical: "BULLISH", sentiment: "BULLISH", risk: "NEUTRAL",
    score: -1, action: "BUY", confidence: "HIGH",
};

beforeEach(() => { resetShadowDivergences(); });
afterAll(() => { stopGoClient(); });

describe("engine mode selection and rollback", () => {
    it("defaults to typescript", () => {
        delete process.env.ZENTRADE_DECISION_ENGINE;
        expect(engineMode()).toBe(ENGINE_TYPESCRIPT);
    });

    it("falls back to typescript for an unknown mode", () => {
        process.env.ZENTRADE_DECISION_ENGINE = "rust";
        expect(engineMode()).toBe(ENGINE_TYPESCRIPT);
        delete process.env.ZENTRADE_DECISION_ENGINE;
    });

    it("accepts the three real modes, case-insensitively", () => {
        for (const [set, want] of [["TypeScript", ENGINE_TYPESCRIPT], ["SHADOW", ENGINE_SHADOW], ["Go", ENGINE_GO]]) {
            process.env.ZENTRADE_DECISION_ENGINE = set;
            expect(engineMode()).toBe(want);
        }
        delete process.env.ZENTRADE_DECISION_ENGINE;
    });
});

describe("diffResults", () => {
    const base = {
        direction: "BULLISH", bullish: 2, bearish: 0, neutral: 1,
        label: "majority", impliedConfidence: "HIGH",
        finalAction: "HOLD", finalConfidence: "HIGH",
    };
    it("reports nothing for identical results", () => {
        expect(diffResults(base, { ...base })).toHaveLength(0);
    });
    it("names every field that differs", () => {
        const diffs = diffResults(base, { ...base, finalAction: "BUY", label: "leaning" });
        expect(diffs.map((d) => d.field).sort()).toEqual(["finalAction", "label"]);
    });
});

describe("typescript mode is unaffected by the migration", () => {
    it("decides without consulting Go", async () => {
        process.env.ZENTRADE_DECISION_ENGINE = ENGINE_TYPESCRIPT;
        const out = await decide(sample);
        expect(out.finalAction).toBe("HOLD");   // macro override
        expect(out.label).toBe("majority");
        delete process.env.ZENTRADE_DECISION_ENGINE;
    });

    it("falls back to typescript when the Go binary is missing", async () => {
        process.env.ZENTRADE_DECISION_ENGINE = ENGINE_SHADOW;
        const saved = process.env.ZENTRADE_DECISIOND_PATH;
        delete process.env.ZENTRADE_DECISIOND_PATH;
        const out = await decide(sample);
        expect(out.finalAction).toBe("HOLD");
        if (saved) process.env.ZENTRADE_DECISIOND_PATH = saved;
        delete process.env.ZENTRADE_DECISION_ENGINE;
    });
});

describe.skipIf(!daemonAvailable)("shadow mode against the real Go daemon", () => {
    it("agrees with TypeScript and records no divergence", async () => {
        process.env.ZENTRADE_DECISION_ENGINE = ENGINE_SHADOW;
        const out = await decide(sample);
        expect(out.finalAction).toBe("HOLD");
        expect(shadowDivergences()).toHaveLength(0);
        delete process.env.ZENTRADE_DECISION_ENGINE;
    });

    it("agrees across a spread of representative cases", async () => {
        process.env.ZENTRADE_DECISION_ENGINE = ENGINE_SHADOW;
        const signals = ["BULLISH", "BEARISH", "NEUTRAL", "GARBAGE"];
        const actions = ["BUY", "SELL", "HOLD", "ACCUMULATE", ""];
        for (const t of signals) for (const s of signals) for (const r of signals) {
            for (const score of [-1, 0, 1]) for (const action of actions) {
                await decide({ technical: t, sentiment: s, risk: r, score, action, confidence: "HIGH" });
            }
        }
        expect(shadowDivergences()).toHaveLength(0);
        delete process.env.ZENTRADE_DECISION_ENGINE;
    }, 60000);

    it("go mode returns the Go result when the two agree", async () => {
        process.env.ZENTRADE_DECISION_ENGINE = ENGINE_GO;
        const out = await decide(sample);
        expect(out.finalAction).toBe("HOLD");
        expect(shadowDivergences()).toHaveLength(0);
        delete process.env.ZENTRADE_DECISION_ENGINE;
    });
});
