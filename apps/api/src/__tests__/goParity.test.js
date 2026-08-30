import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { computeConsensus, applyDecisionGuardrails } from "../services/aiEngine.js";

// Exhaustive parity against the Go implementation. The Go binary enumerates
// the input space and writes cases plus its own results; this test recomputes
// every case in TypeScript and compares field by field. Both sides therefore
// see byte-identical input.
//
// Regenerate with:  cd go && go run ./cmd/parity > <PARITY_FIXTURE>
//
// A missing fixture skips rather than fails, so the JS suite stays runnable
// without a Go toolchain. CI must set PARITY_FIXTURE.

const FIXTURE = process.env.PARITY_FIXTURE;
const available = Boolean(FIXTURE) && existsSync(FIXTURE);

describe.skipIf(!available)("Go/TypeScript decision parity", () => {
    const payload = available ? JSON.parse(readFileSync(FIXTURE, "utf8")) : { cases: [], results: [] };

    it("compares a non-trivial number of cases", () => {
        expect(payload.cases.length).toBeGreaterThan(10000);
        expect(payload.cases.length).toBe(payload.results.length);
    });

    it("produces identical output for every enumerated case", () => {
        const diffs = [];
        for (let i = 0; i < payload.cases.length; i += 1) {
            const c = payload.cases[i];
            const go = payload.results[i];

            const consensus = computeConsensus(c.technical, c.sentiment, c.risk);
            const decided = applyDecisionGuardrails(
                { action: c.action, confidence: c.confidence }, consensus, c.score);

            const ts = {
                direction: consensus.direction,
                bullish: consensus.bullish,
                bearish: consensus.bearish,
                neutral: consensus.neutral,
                label: consensus.label,
                impliedConfidence: consensus.impliedConfidence,
                finalAction: decided.action,
                finalConfidence: decided.confidence,
            };

            for (const key of Object.keys(ts)) {
                if (ts[key] !== go[key]) {
                    diffs.push({ index: i, input: c, field: key, ts: ts[key], go: go[key] });
                    break;
                }
            }
            if (diffs.length >= 10) break;
        }

        if (diffs.length) {
            const report = diffs.map((d) =>
                `  case ${d.index} ${JSON.stringify(d.input)}\n` +
                `    field ${d.field}: TS=${JSON.stringify(d.ts)} GO=${JSON.stringify(d.go)}`
            ).join("\n");
            throw new Error(`${diffs.length} parity divergence(s):\n${report}`);
        }
        expect(diffs).toHaveLength(0);
    });

    it("never lets either implementation emit an illegal action", () => {
        const legal = new Set(["BUY", "SELL", "HOLD"]);
        for (const r of payload.results) expect(legal.has(r.finalAction)).toBe(true);
    });
});
