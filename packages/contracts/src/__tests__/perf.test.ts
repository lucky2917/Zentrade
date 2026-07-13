import { describe, it, expect } from "vitest";
import { MarketTick } from "../index.js";
import fixtures from "./fixtures/sanitised-ticks.json";

/**
 * Regression floor, not a benchmark: the roadmap target is >=50k validations/s
 * on one core; we assert a conservative 10k/s so CI-machine variance never
 * flakes, while a pathological slowdown (accidental async refinement, regex
 * backtracking) still fails loudly. Measured numbers are printed for the
 * milestone report.
 */
describe("validation throughput", () => {
    it("MarketTick parses at >= 10k ops/s (target 50k)", () => {
        const N = 50_000;
        // warmup
        for (let i = 0; i < 1_000; i++) MarketTick.parse(fixtures.stock);

        const start = performance.now();
        for (let i = 0; i < N; i++) MarketTick.parse(i % 2 ? fixtures.stock : fixtures.index);
        const elapsedMs = performance.now() - start;

        const opsPerSec = Math.round((N / elapsedMs) * 1000);
        // eslint-disable-next-line no-console
        console.log(`MarketTick validation: ${opsPerSec.toLocaleString()} ops/s (${N} parses in ${elapsedMs.toFixed(0)}ms)`);
        expect(opsPerSec).toBeGreaterThan(10_000);
    });
});
