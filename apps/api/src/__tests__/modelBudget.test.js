import { describe, expect, it, beforeEach } from "vitest";
import { noteModelRefusal, modelExhausted, modelBudget } from "../services/aiEngine.js";

// The provider answered every call with a 538-second retry-after: that is a
// daily quota spent, not a burst limit. The failure that matters is not the
// wasted calls — it is that a pipeline which cannot reach the model produces a
// safe HOLD, and a safe HOLD is indistinguishable on screen from a considered
// one. The system has to be able to say "I could not think".

describe("model budget exhaustion", () => {
    const T = 1_700_000_000_000;
    beforeEach(() => noteModelRefusal(0, T));   // clear

    it("treats a short wait as a burst, not exhaustion", () => {
        noteModelRefusal(2_000, T);
        expect(modelExhausted(T + 100)).toBe(false);
    });

    it("treats a wait longer than any burst window as exhaustion", () => {
        noteModelRefusal(538_000, T);
        expect(modelExhausted(T + 1_000)).toBe(true);
        expect(modelBudget(T + 1_000).exhausted).toBe(true);
    });

    it("reports when the provider says it will serve again", () => {
        noteModelRefusal(120_000, T);
        expect(modelBudget(T).resumesInSeconds).toBe(120);
        expect(modelBudget(T + 60_000).resumesInSeconds).toBe(60);
    });

    it("clears once the stated window has passed", () => {
        noteModelRefusal(60_000, T);
        expect(modelExhausted(T + 59_000)).toBe(true);
        expect(modelExhausted(T + 61_000)).toBe(false);
        expect(modelBudget(T + 61_000).resumesInSeconds).toBe(0);
    });

    it("always reports the configured ceiling", () => {
        const b = modelBudget(T);
        expect(b.rpm).toBeGreaterThan(0);
        expect(b.maxConcurrent).toBeGreaterThan(0);
        expect(b).toHaveProperty("queued");
    });
});

describe("the loop is not held hostage by a rate limit", () => {
    const read = async (f) => {
        const { readFileSync } = await import("node:fs");
        const { join } = await import("node:path");
        return readFileSync(join(process.cwd(), f), "utf8");
    };

    // A scheduler job that sleeps is a loop that stops. Observed: candidate-scan
    // in flight for 235 seconds while the model was asked for 105-second waits.
    it("caps how long a call will wait on a provider's retry-after", async () => {
        const src = await read("src/services/aiEngine.js");
        expect(src).toMatch(/MAX_RETRY_WAIT_MS/);
        expect(src).toMatch(/asked > MAX_RETRY_WAIT_MS \? 0/);
    });

    it("fails fast instead of retrying while the budget is spent", async () => {
        expect(await read("src/services/aiEngine.js"))
            .toMatch(/if \(modelExhausted\(\)\) \{/);
    });

    // Two paths spending one budget is how both starve.
    it("bounds how many candidates one discovery pass reasons about", async () => {
        const src = await read("src/services/autonomous/runtime.js");
        expect(src).toMatch(/MAX_SCAN_REASONING/);
        expect(src).toMatch(/result\.candidates\.slice\(0, MAX_SCAN_REASONING\)/);
        expect(src).toMatch(/candidatesDeferred/);
    });

    it("gives a queued call time to be served rather than timing it out", async () => {
        // The transport is rate limited, so a call waits its turn before it is
        // sent. A 20-second bound killed challenges while still queued, and an
        // unreadable challenge is treated as the most adverse outcome.
        expect(await read("src/services/reasoning/pipeline.js"))
            .toMatch(/timeoutMs = 45_000/);
    });

    it("reports the model's state so a session that cannot reason says so", async () => {
        expect(await read("src/services/autonomous/runtime.js"))
            .toMatch(/model: modelBudget\(\)/);
    });
});
