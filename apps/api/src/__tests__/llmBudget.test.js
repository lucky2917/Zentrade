import { describe, expect, it, beforeEach } from "vitest";
import { recordTokens, tokenBudget } from "../services/aiEngine.js";

// A requests-per-minute ceiling does not protect a TOKEN quota.
//
// Measured on the live session: one decision costs about 3,270 tokens across
// its two calls, so a 200,000 token allowance buys roughly sixty decisions a
// day — and an RPM limiter will spend all of them within an hour and then
// return 429 for the rest of the session. The budget has to be counted.

const T = Date.UTC(2026, 7, 31, 6, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

describe("token accounting", () => {
    // Reset by rolling to a fresh IST day before each case.
    let clock = T;
    beforeEach(() => { clock += DAY; recordTokens({ promptTokens: 0, completionTokens: 0 }, clock); });

    it("counts what the provider actually reported, not an estimate", () => {
        recordTokens({ promptTokens: 912, completionTokens: 557 }, clock);
        const b = tokenBudget(clock);
        expect(b.used).toBe(1469);
        expect(b.remaining).toBe(b.budget - 1469);
    });

    it("accumulates across calls", () => {
        recordTokens({ promptTokens: 900, completionTokens: 500 }, clock);
        recordTokens({ promptTokens: 800, completionTokens: 400 }, clock);
        expect(tokenBudget(clock).used).toBe(2600);
    });

    it("tolerates a response that reported no usage", () => {
        recordTokens(undefined, clock);
        recordTokens({}, clock);
        expect(tokenBudget(clock).used).toBe(0);
    });

    it("resets on a new IST session day, so today means today", () => {
        recordTokens({ promptTokens: 100_000, completionTokens: 0 }, clock);
        expect(tokenBudget(clock).used).toBe(100_000);
        expect(tokenBudget(clock + DAY).used).toBe(0);
    });
});

describe("the reserve protects open positions", () => {
    let clock = T + 100 * DAY;
    beforeEach(() => { clock += DAY; recordTokens({}, clock); });

    // Discovery is the first thing to stop. A new idea is worth less than a
    // question about capital already at risk.
    it("permits discovery while there is comfortable headroom", () => {
        const b = tokenBudget(clock);
        recordTokens({ promptTokens: Math.floor(b.budget * 0.5), completionTokens: 0 }, clock);
        expect(tokenBudget(clock).discoveryPermitted).toBe(true);
    });

    it("stops discovery once the budget nears its reserve", () => {
        const b = tokenBudget(clock);
        recordTokens({ promptTokens: Math.floor(b.budget * 0.85), completionTokens: 0 }, clock);
        const after = tokenBudget(clock);
        expect(after.discoveryPermitted).toBe(false);
        expect(after.exhausted).toBe(false);   // reassessment can still run
    });

    it("reports exhaustion only when nothing is left", () => {
        const b = tokenBudget(clock);
        recordTokens({ promptTokens: b.budget, completionTokens: 0 }, clock);
        const after = tokenBudget(clock);
        expect(after.exhausted).toBe(true);
        expect(after.remaining).toBe(0);
        expect(after.fractionRemaining).toBe(0);
    });
});

describe("prompts carry no waste", () => {
    const read = async (f) => {
        const { readFileSync } = await import("node:fs");
        const { join } = await import("node:path");
        return readFileSync(join(process.cwd(), f), "utf8");
    };

    it("the challenger is not sent the account block or the scan rationale", async () => {
        const { buildChallengePrompt, buildFormationPrompt } =
            await import("../services/reasoning/thesis.js");
        const state = {
            asOf: "2026-08-31T09:00:00Z", symbol: "X",
            screenReasons: ["MTF alignment", "volume expansion"],
            market: { sessionPhase: "MID", minutesIntoSession: 200, regime: "T",
                      regimeBasis: "b", dataStale: false },
            evidence: [], news: [],
            risk: { cashPaise: 9_000_000, positionCount: 0,
                    grossExposurePaise: 0, unrealisedPnlPaise: 0 },
            position: null, symbolState: { price: 100 },
        };
        const challenge = buildChallengePrompt(state, { thesis: "t", proposedAction: "BUY",
                                                        supportingEvidence: [] });
        // It judges a thesis; it does not size positions and does not care why
        // the scanner surfaced the name.
        expect(challenge).not.toMatch(/ACCOUNT/);
        expect(challenge).not.toMatch(/WHY THIS SYMBOL SURFACED/);
        // The formation prompt still needs both.
        const formation = buildFormationPrompt(state);
        expect(formation).toMatch(/ACCOUNT/);
        expect(formation).toMatch(/WHY THIS SYMBOL SURFACED/);
        // And the challenger still gets what it needs to judge.
        expect(challenge).toMatch(/THE THESIS UNDER EXAMINATION/);
        expect(challenge).toMatch(/THESIS_BROKEN/);
        expect(challenge).toMatch(/THESIS_HOLDS/);
    });

    it("the same symbol is not re-priced while nothing has changed", async () => {
        const src = await read("src/services/autonomous/runtime.js");
        expect(src).toMatch(/CANDIDATE_COOLDOWN_MS/);
        expect(src).toMatch(/lastCandidateReasoningAt/);
        expect(src).toMatch(/candidatesCooledDown/);
    });

    it("discovery yields to the reserve before positions do", async () => {
        const src = await read("src/services/autonomous/runtime.js");
        expect(src).toMatch(/tokenBudget\(\)/);
        expect(src).toMatch(/discoveryPermitted/);
        // The throttle sits on the candidate path only.
        const idx = src.indexOf("discoveryPermitted");
        expect(src.slice(0, idx)).toMatch(/async handleCandidate/);
    });
});

// A dropped socket is not a reason to stop trading.
//
// Observed live: the agent died on `read ETIMEDOUT` from an idle TLS
// connection, mid-session, holding an open position. Both pools reconnect on
// their own within seconds; the exit lost the whole session instead.
describe("transient connection errors do not kill the process", () => {
    const read = async (f) => {
        const { readFileSync } = await import("node:fs");
        const { join } = await import("node:path");
        return readFileSync(join(process.cwd(), f), "utf8");
    };

    for (const file of ["src/agent.js", "src/index.js"]) {
        it(`${file} survives a pooled-connection timeout`, async () => {
            const src = await read(file);
            for (const code of ["ETIMEDOUT", "ECONNRESET", "EPIPE", "EAI_AGAIN"]) {
                expect({ file, code, listed: src.includes(`"${code}"`) })
                    .toEqual({ file, code, listed: true });
            }
            // And a genuine fault is still fatal: an unknown error must not be
            // swallowed and left running in an unknown state.
            expect(src).toMatch(/uncaught exception|Uncaught exception/);
        });
    }
});

// A per-symbol cooldown does not pace spending: the scanner simply moves to the
// next symbol. Measured live, 9 decisions in 3.3 minutes is ~6,900 tokens a
// minute, which spends a 200,000 allowance in 29 minutes of a 375-minute
// session. Discovery is paced against the clock instead.
describe("discovery is paced across the session", () => {
    let sessionProgress, discoveryAheadOfPace;
    beforeEach(async () => {
        ({ sessionProgress, discoveryAheadOfPace } =
            await import("../services/autonomous/runtime.js"));
    });

    // 09:15 IST is 03:45 UTC; 15:30 IST is 10:00 UTC.
    const ist = (h, m) => new Date(Date.UTC(2026, 7, 31, h, m) - 5.5 * 60 * 60 * 1000);

    it("measures how far through the trading session it is", () => {
        expect(sessionProgress(ist(9, 15))).toBe(0);
        expect(sessionProgress(ist(15, 30))).toBe(1);
        expect(sessionProgress(ist(12, 22))).toBeCloseTo(0.5, 1);
        // Outside the session it clamps rather than going negative.
        expect(sessionProgress(ist(6, 0))).toBe(0);
        expect(sessionProgress(ist(20, 0))).toBe(1);
    });

    const spent = (fraction) => ({ budget: 200_000, used: 200_000 * fraction });

    it("allows spending that tracks the clock", () => {
        expect(discoveryAheadOfPace(spent(0.10), ist(10, 0))).toBe(false);
        expect(discoveryAheadOfPace(spent(0.50), ist(13, 0))).toBe(false);
    });

    it("pauses discovery when spending runs ahead of the session", () => {
        // Half the budget an hour into a six-hour session.
        expect(discoveryAheadOfPace(spent(0.50), ist(10, 0))).toBe(true);
    });

    it("gives the open a head start so it is not starved", () => {
        // Right at the bell, a little spending is expected.
        expect(discoveryAheadOfPace(spent(0.10), ist(9, 16))).toBe(false);
        expect(discoveryAheadOfPace(spent(0.40), ist(9, 16))).toBe(true);
    });

    it("does not divide by a budget of zero", () => {
        expect(discoveryAheadOfPace({ budget: 0, used: 0 }, ist(12, 0))).toBe(false);
        expect(discoveryAheadOfPace(null, ist(12, 0))).toBe(false);
    });

    // Capital already at risk is not a budgeting question.
    it("paces discovery only, never position reassessment", async () => {
        const { readFileSync } = await import("node:fs");
        const { join } = await import("node:path");
        const src = readFileSync(
            join(process.cwd(), "src/services/autonomous/runtime.js"), "utf8");
        // Exactly one call site, and it is inside handleCandidate — not in
        // protect(), which acts on capital already at risk.
        expect(src.match(/discoveryAheadOfPace\(tokens/g)).toHaveLength(1);

        const bodyOf = (name) => {
            const start = src.indexOf(`async ${name}(`);
            const next = src.indexOf("\n    async ", start + 1);
            return src.slice(start, next === -1 ? undefined : next);
        };
        expect(bodyOf("handleCandidate")).toMatch(/discoveryAheadOfPace/);
        expect(bodyOf("protect")).not.toMatch(/discoveryAheadOfPace/);
        expect(bodyOf("protect")).not.toMatch(/tokenBudget/);
    });
});
