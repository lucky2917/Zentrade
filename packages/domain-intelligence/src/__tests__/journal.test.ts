import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
    canonicalStringify,
    canonicalHash,
    modelCostUsd,
    priceToMinor,
    buildAgentRun,
    buildDecision,
} from "../index.js";

describe("canonical hashing", () => {
    it("is invariant to object key order, recursively", () => {
        const a = { b: 1, a: { z: [1, 2], y: "x" }, c: null };
        const b = { c: null, a: { y: "x", z: [1, 2] }, b: 1 };
        expect(canonicalHash(a)).toBe(canonicalHash(b));
    });

    it("array order matters (evidence order is meaning)", () => {
        expect(canonicalHash({ a: [1, 2] })).not.toBe(canonicalHash({ a: [2, 1] }));
    });

    it("undefined values are dropped like JSON.stringify drops them", () => {
        expect(canonicalHash({ a: 1, b: undefined })).toBe(canonicalHash({ a: 1 }));
    });

    it("property: hash is stable across shuffled key insertion for arbitrary objects", () => {
        fc.assert(
            fc.property(fc.dictionary(fc.string(), fc.jsonValue(), { maxKeys: 8 }), (obj) => {
                const entries = Object.entries(obj);
                const shuffled = Object.fromEntries([...entries].reverse());
                expect(canonicalHash(shuffled)).toBe(canonicalHash(obj));
            }),
            { numRuns: 300 },
        );
    });

    it("canonical form is valid JSON round-trippable", () => {
        const value = { nested: { arr: [1, "two", null, { deep: true }] } };
        expect(JSON.parse(canonicalStringify(value))).toEqual(value);
    });
});

describe("model cost", () => {
    it("prices known models per published rates", () => {
        // 1M in + 1M out on gpt-oss-120b = 0.15 + 0.60
        expect(modelCostUsd("openai/gpt-oss-120b", { promptTokens: 1_000_000, completionTokens: 1_000_000 })).toBe(0.75);
        expect(modelCostUsd("openai/gpt-oss-20b", { promptTokens: 2_000_000, completionTokens: 0 })).toBe(0.15);
    });

    it("unknown model or missing usage is null, never a fake zero", () => {
        expect(modelCostUsd("gpt-unknown", { promptTokens: 10, completionTokens: 10 })).toBeNull();
        expect(modelCostUsd("openai/gpt-oss-120b", null)).toBeNull();
        expect(modelCostUsd("openai/gpt-oss-120b", { promptTokens: -1, completionTokens: 5 })).toBeNull();
    });
});

describe("priceToMinor", () => {
    it("converts rupee levels to paise, handling half-rupee synthesizer prices", () => {
        expect(priceToMinor(1748.5)).toBe(174850);
        expect(priceToMinor(6.17)).toBe(617);
        expect(priceToMinor(null)).toBeNull();
        expect(priceToMinor(undefined)).toBeNull();
    });

    it("rejects garbage instead of journaling it", () => {
        expect(() => priceToMinor(NaN)).toThrow();
        expect(() => priceToMinor(-5)).toThrow();
        expect(() => priceToMinor(0)).toThrow();
        expect(() => priceToMinor(Infinity)).toThrow();
    });
});

describe("record builders", () => {
    const validRun = {
        agentName: "technical",
        agentVersion: "v4",
        modelId: "llama-3.3-70b-versatile",
        inputHash: "a".repeat(64),
        output: { signal: "BULLISH" },
        status: "ok",
        latencyMs: 812,
        promptTokens: 900,
        completionTokens: 120,
        costUsd: 0.000626,
    };

    it("accepts a valid agent run and rejects malformed hashes/status/unknown keys", () => {
        expect(buildAgentRun(validRun)).toEqual(validRun);
        expect(() => buildAgentRun({ ...validRun, inputHash: "xyz" })).toThrow();
        expect(() => buildAgentRun({ ...validRun, status: "retrying" })).toThrow();
        expect(() => buildAgentRun({ ...validRun, smuggled: 1 })).toThrow();
        expect(() => buildAgentRun({ ...validRun, latencyMs: -1 })).toThrow();
    });

    it("accepts a valid decision and enforces enums and caps", () => {
        const decision = {
            action: "BUY",
            mode: "INTRADAY",
            confidence: "MEDIUM",
            entryMinor: 174850,
            targetMinor: 176600,
            stopMinor: 174000,
            rationale: { traderNote: "note", reasoning: ["a", "b"], consensus: "majority", macroScore: 1 },
            synthesizerVersion: "v4",
        };
        expect(buildDecision(decision)).toEqual(decision);
        expect(() => buildDecision({ ...decision, action: "SHORT" })).toThrow();
        expect(() => buildDecision({ ...decision, entryMinor: 0 })).toThrow();
        expect(() =>
            buildDecision({ ...decision, rationale: { ...decision.rationale, reasoning: ["x".repeat(501)] } }),
        ).toThrow();
    });
});
