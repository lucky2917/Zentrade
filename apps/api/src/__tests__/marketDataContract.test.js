import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ReflexLane, CROSSING, DIRECTION } from "../services/tick/reflex.js";

// The Node half of the market-data parity contract.
//
// The Go port asserts it reproduces these fixtures. This asserts the fixtures
// still describe the Node implementation. Without both halves, the two could
// drift apart and parity would still "pass" against a stale specification.

const FIXTURES = join(process.cwd(), "../../contracts/market-data/v1/fixtures");
const SEVERITY = {
    [CROSSING.STOP]: "CRITICAL",
    [CROSSING.INVALIDATION]: "CRITICAL",
    [CROSSING.TARGET]: "WARNING",
    [CROSSING.STOP_APPROACH]: "WARNING",
    [CROSSING.PRICE_JUMP]: "WARNING",
    [CROSSING.VWAP_DEVIATION]: "WARNING",
    [CROSSING.VOLUME_SPIKE]: "WARNING",
    [CROSSING.TARGET_APPROACH]: "INFO",
};

const load = () => readdirSync(FIXTURES)
    .filter((f) => f.endsWith(".json") && f !== "index.json")
    .map((f) => JSON.parse(readFileSync(join(FIXTURES, f), "utf8")));

const replay = (fixture) => {
    const lane = new ReflexLane({ clock: () => 0 });
    for (const c of fixture.input.commitments) {
        lane.arm(c.symbol, {
            thesisId: c.thesisId, direction: c.direction,
            stopPaise: c.stopPaise ?? null, targetPaise: c.targetPaise ?? null,
            invalidationPaise: c.invalidationPaise ?? null,
            quantity: c.quantity, correlationId: c.correlationId,
        });
    }
    // Continuous detection is off unless a watch asks for it, which is why the
    // fixtures written before it exist are unchanged by it.
    for (const w of fixture.input.watches ?? []) {
        lane.watch(w.symbol, {
            entryPaise: w.entryPaise ?? null, thesisId: w.thesisId ?? null,
            correlationId: w.correlationId ?? null,
            direction: w.direction ?? DIRECTION.LONG,
            ...(w.approachFraction !== undefined ? { approachFraction: w.approachFraction } : {}),
            ...(w.jumpPercent !== undefined ? { jumpPercent: w.jumpPercent } : {}),
            ...(w.velocityWindowMs !== undefined ? { velocityWindowMs: w.velocityWindowMs } : {}),
            ...(w.vwapDeviation !== undefined ? { vwapDeviation: w.vwapDeviation } : {}),
        });
        if (w.vwapPaise !== undefined) lane.updateVwap(w.symbol, w.vwapPaise);
        if (w.volumeBaseline !== undefined) {
            lane.updateVolumeBaseline(w.symbol,
                { baseline: w.volumeBaseline, ratio: w.volumeSpikeRatio });
        }
    }

    const events = [];
    for (const tick of fixture.input.ticks) {
        for (const c of lane.onTick({ symbol: tick.symbol, pricePaise: tick.pricePaise,
                                      at: tick.receiveTs,
                                      cumulativeVolume: tick.cumulativeVolume ?? null })) {
            events.push({
                contract: "zentrade.marketdata.event.v1",
                kind: c.kind, symbol: c.symbol, severity: SEVERITY[c.kind],
                reason: c.reason
                    ?? `${c.kind} crossed at ${c.pricePaise} against ${c.levelPaise}`,
                pricePaise: c.pricePaise, levelPaise: c.levelPaise,
                thesisId: c.thesisId, correlationId: c.correlationId,
                observedTs: c.at, sequence: lane.snapshot(c.symbol).seq,
            });
        }
    }
    return { lane, events };
};

describe("market data contract v1", () => {
    const fixtures = load();

    it("ships a non-empty fixture set", () => {
        expect(fixtures.length).toBeGreaterThanOrEqual(12);
    });

    it("every fixture declares the contract version it was generated against", () => {
        for (const f of fixtures) expect(f.contract).toBe("zentrade.marketdata.v1");
    });

    it.each(fixtures.map((f) => [f.name, f]))(
        "the node implementation still produces %s exactly", (_name, fixture) => {
            const { lane, events } = replay(fixture);
            expect(events).toEqual(fixture.expected.events);

            for (const want of fixture.expected.finalState) {
                const state = lane.snapshot(want.symbol);
                if (!want.observed) {
                    expect(state).toBeNull();
                    continue;
                }
                expect({
                    lastPaise: state.last, highPaise: state.high,
                    lowPaise: state.low, sequence: state.seq, updatedTs: state.at,
                }).toEqual({
                    lastPaise: want.lastPaise, highPaise: want.highPaise,
                    lowPaise: want.lowPaise, sequence: want.sequence, updatedTs: want.updatedTs,
                });
            }
        });

    it("pins the semantics the contract promises", () => {
        const kinds = new Set(fixtures.flatMap((f) => f.expected.events.map((e) => e.kind)));
        for (const kind of Object.keys(SEVERITY)) expect(kinds).toContain(kind);

        // Severity is fixed by the kind, not chosen by the caller. A stop or a
        // named invalidation is critical because the thesis pre-committed to
        // acting on it; everything else is attention.
        for (const f of fixtures) {
            for (const e of f.expected.events) {
                expect(e.severity).toBe(SEVERITY[e.kind]);
            }
        }
    });

    it("makes only a pre-committed level protective", () => {
        const protective = ["STOP", "INVALIDATION"];
        for (const f of fixtures) {
            for (const e of f.expected.events) {
                expect(e.severity === "CRITICAL").toBe(protective.includes(e.kind));
            }
        }
    });

    it("keeps every price in the contract as an integer", () => {
        for (const f of fixtures) {
            for (const t of f.input.ticks) expect(Number.isInteger(t.pricePaise)).toBe(true);
            for (const e of f.expected.events) {
                expect(Number.isInteger(e.pricePaise)).toBe(true);
                expect(Number.isInteger(e.levelPaise)).toBe(true);
            }
        }
    });

    it("evaluates stop before invalidation before target", () => {
        const both = fixtures.find((f) => f.name === "stop_and_invalidation_same_tick");
        expect(both.expected.events.map((e) => e.kind)).toEqual(["STOP", "INVALIDATION"]);
    });
});
