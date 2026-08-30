import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Orchestrator } from "../services/orchestrator/orchestrator.js";
import { AutonomousRuntime } from "../services/autonomous/runtime.js";
import { makeEvent } from "../services/autonomous/events.js";

// G4. One decision, one instant.
//
// Every port used to read the wall clock at its own call time, so the price a
// decision was formed on, the portfolio it was sized against and the world it
// was revalidated in were three different moments. Nothing was wrong by much,
// and nothing was reproducible either.

const OPEN_IST = new Date(Date.UTC(2026, 7, 31, 4, 30));   // 10:00 IST, a Monday

const position = (over = {}) => ({
    symbol: "RELIANCE", userId: 1, quantity: 10, thesisId: 5,
    entryPricePaise: 100_000, currentPricePaise: 98_000, unrealisedPnlPaise: -20_000,
    pnlPercent: -2, holdingSeconds: 600, stopDistance: -0.1, targetDistance: 0.6,
    correlationId: "corr-1", stale: false, dataAgeMs: 0, hasThesis: true, ...over,
});

describe("the live ports read no clock of their own", () => {
    // A default that silently falls back to the wall clock would make the
    // guarantee unverifiable from the outside, so it is verified from the
    // inside: this module must contain exactly one clock, the injected one.
    it("livePorts.js contains no direct wall-clock read", () => {
        const source = readFileSync(
            join(process.cwd(), "src/services/autonomous/livePorts.js"), "utf8");
        const stripped = source.replace(/clock = \(\) => new Date\(\),/, "");
        expect(stripped).not.toMatch(/new Date\(\)/);
        expect(stripped).not.toMatch(/Date\.now\(\)/);
    });
});

describe("one instant per decision", () => {
    const buildPorts = (seen) => ({
        loadPositions: async (asOf) => { seen.push(["loadPositions", asOf]); return [position()]; },
        loadPortfolio: async (asOf) => {
            seen.push(["loadPortfolio", asOf]);
            return { userId: 1, cashPaise: 10_000_000, positionCount: 1,
                     grossExposurePaise: 980_000, unrealisedPnlPaise: -20_000 };
        },
        loadObservations: async (asOf) => { seen.push(["loadObservations", asOf]); return []; },
        positionFor: async (_s, asOf) => { seen.push(["positionFor", asOf]); return position(); },
        loadThesis: async () => ({ id: 5, stop_paise: 97_000, target_paise: 105_000 }),
        reassess: async ({ asOf }) => {
            seen.push(["reassess", asOf]);
            return { action: "EXIT", confidence: "HIGH", thesisStillValid: false,
                     whatChanged: "stop", material: true, reasoning: "r", evidence: [] };
        },
        evaluateRisk: async (_i, _p, asOf) => {
            seen.push(["evaluateRisk", asOf]);
            return { decision: "ALLOW", code: "OK" };
        },
        intentFrom: (d, p) => ({ action: d.action, side: "SELL", symbol: p.symbol,
                                 quantity: p.quantity, pricePaise: p.currentPricePaise,
                                 referencePricePaise: p.currentPricePaise,
                                 correlationId: p.correlationId }),
        currentWorld: async () => ({ nowMs: OPEN_IST.getTime(), pricePaise: 98_000,
                                     priceAgeMs: 0, position: { quantity: 10 } }),
        execute: vi.fn(async () => ({ ok: true })),
        recordEvent: async () => ({ id: 1 }),
        markEventHandled: async () => null,
        markEventFailed: async () => null,
        recordReassessment: async () => ({ id: 1 }),
        journal: async () => null,
    });

    it("binds every read in a position decision to the same moment", async () => {
        const seen = [];
        const orchestrator = new Orchestrator({
            clock: () => new Date(OPEN_IST), ports: buildPorts(seen) });
        orchestrator.queue.offer({
            ...makeEvent({ type: "STOP_BREACH", symbol: "RELIANCE", severity: "CRITICAL",
                           thesisId: 5, correlationId: "corr-1", source: "test",
                           observed: {}, reason: "stop", observedAt: OPEN_IST,
                           bucket: "b" }),
            storedId: 1,
        }, OPEN_IST.getTime());

        await orchestrator.reasoningCycle();

        const bound = seen.filter(([name]) => name !== "loadObservations");
        expect(bound.length).toBeGreaterThanOrEqual(3);
        for (const [name, asOf] of bound) {
            expect({ name, at: asOf?.toISOString?.() ?? null })
                .toEqual({ name, at: OPEN_IST.toISOString() });
        }
    });

    it("binds every read in a monitor cycle to the same moment", async () => {
        const seen = [];
        const orchestrator = new Orchestrator({
            clock: () => new Date(OPEN_IST), ports: buildPorts(seen) });
        await orchestrator.monitorCycle();

        expect(seen.map(([n]) => n)).toContain("loadObservations");
        for (const [name, asOf] of seen) {
            expect({ name, at: asOf?.toISOString?.() ?? null })
                .toEqual({ name, at: OPEN_IST.toISOString() });
        }
    });

    it("binds a candidate decision to one moment", async () => {
        const seen = [];
        const analyseCandidate = vi.fn(async ({ asOf }) => {
            seen.push(["analyseCandidate", asOf]);
            return { action: "HOLD", confidence: "LOW", reasoning: "r", evidence: [] };
        });
        const runtime = new AutonomousRuntime({
            engine: {}, reconciler: null, clock: () => new Date(OPEN_IST),
            ports: {
                loadObservations: async (asOf) => { seen.push(["loadObservations", asOf]); return []; },
                loadPositions: async (asOf) => { seen.push(["loadPositions", asOf]); return []; },
                analyseCandidate, journal: async () => null,
            },
        });

        await runtime.handleCandidate({ symbol: "INFY", context: { price: 1500 } });
        expect(analyseCandidate).toHaveBeenCalledOnce();
        expect(seen.find(([n]) => n === "analyseCandidate")[1].toISOString())
            .toBe(OPEN_IST.toISOString());
    });

    // The one read that must NOT reuse the decision's instant. Revalidating a
    // stale decision against its own timestamp revalidates nothing.
    it("takes a fresh instant for the pre-execution revalidation", async () => {
        const seen = [];
        const ports = buildPorts(seen);
        let ticks = 0;
        const orchestrator = new Orchestrator({
            clock: () => new Date(OPEN_IST.getTime() + (ticks++) * 1000),
            ports: { ...ports, currentWorld: async (_s, asOf) => {
                seen.push(["currentWorld", asOf]);
                return { nowMs: OPEN_IST.getTime(), pricePaise: 98_000,
                         priceAgeMs: 0, position: { quantity: 10 } };
            } },
        });
        orchestrator.queue.offer({
            ...makeEvent({ type: "STOP_BREACH", symbol: "RELIANCE", severity: "CRITICAL",
                           thesisId: 5, correlationId: "corr-1", source: "test",
                           observed: {}, reason: "stop", observedAt: OPEN_IST,
                           bucket: "b" }),
            storedId: 1,
        }, OPEN_IST.getTime());

        await orchestrator.reasoningCycle();
        const world = seen.find(([n]) => n === "currentWorld");
        expect(world).toBeDefined();
        expect(world[1]).toBeUndefined();   // not bound to the decision's instant
    });
});
