import { describe, expect, it } from "vitest";
import { clearsCostHurdle, screenedMove } from "../services/autonomous/candidates.js";
import { ROUND_TRIP_COST_BPS } from "../services/reasoning/synthesis.js";
import { EventQueue } from "../services/orchestrator/eventQueue.js";

// Where the reasoning budget went, and why the trades that could have happened
// did not. Measured on the 2026-09-01 session: 41 decisions, 35 HOLD, one
// executable thesis, six calls lost to rate limits.

// ---- arithmetic before reasoning -------------------------------------------
//
// The scan path has always screened on economics. The event path never did, so
// an anomaly detector firing on statistical significance sent a 0.29% move to
// the Senior Trader at the same price as a 7% breakout. Twenty-six of thirty
// three event candidates were moves too small to cover their own costs; all
// twenty-six came back HOLD, each after two model calls.

describe("a move that cannot pay for its round trip earns no decision", () => {
    const ctx = (mtf) => ({ mtf: { complete: true, ...mtf } });

    it("turns away the moves that filled the last session", () => {
        // The real triggers, from decision_records.
        for (const move of [0.0029, 0.0026, 0.0038, 0.0043, 0.0014]) {
            const verdict = clearsCostHurdle(ctx({ change5m: move }));
            expect(verdict.worth).toBe(false);
            expect(verdict.reason).toMatch(/cannot cover the 0\.74% round trip/);
        }
    });

    it("admits the moves that were worth a decision", () => {
        for (const move of [0.0729, 0.0567, 0.0536, 0.0449, 0.0961]) {
            expect(clearsCostHurdle(ctx({ change5m: move })).worth).toBe(true);
        }
    });

    it("turns away a candidate with no measurable move at all", () => {
        // Volatility and volume anomalies carry no direction to trade.
        expect(clearsCostHurdle(ctx({})).worth).toBe(false);
        expect(clearsCostHurdle(null).worth).toBe(false);
        expect(clearsCostHurdle(ctx({})).reason).toBe("no measurable price move to trade");
    });

    it("judges a fall exactly as it judges a rise", () => {
        expect(clearsCostHurdle(ctx({ change5m: -0.05 })).worth).toBe(true);
        expect(clearsCostHurdle(ctx({ change5m: -0.002 })).worth).toBe(false);
    });

    it("sits exactly on the documented cost hurdle, not a number of its own", () => {
        const hurdle = ROUND_TRIP_COST_BPS / 10_000;      // 0.7355% as a fraction
        expect(clearsCostHurdle(ctx({ change5m: hurdle * 1.01 })).worth).toBe(true);
        expect(clearsCostHurdle(ctx({ change5m: hurdle * 0.99 })).worth).toBe(false);
    });

    it("uses the same move the screen and the ranking use", () => {
        const c = ctx({ change1m: 0.05 });
        expect(screenedMove(c)).toBe(0.05);
        expect(clearsCostHurdle(c).worth).toBe(true);
    });
});

// ---- the strongest candidate is served first --------------------------------
//
// Every anomaly is raised CRITICAL, so severity cannot order this queue: they
// all tie at rank 0 and arrival order decides. With reasoning slower than
// arrivals, the breakout that arrived second is the one that expires.

describe("the queue serves opportunity, not arrival order", () => {
    const event = (symbol, strength, severity = "CRITICAL") => ({
        type: "PRICE_JUMP", symbol, severity, strength, thesisId: null });

    it("hands out the strongest of equally critical events first", () => {
        const q = new EventQueue({ clock: () => 1000 });
        q.offer(event("BLIP", 0.29), 1000);        // arrived first, worth little
        q.offer(event("BREAKOUT", 7.29), 1001);
        q.offer(event("MIDDLING", 1.5), 1002);

        expect(q.take().symbol).toBe("BREAKOUT");
        expect(q.take().symbol).toBe("MIDDLING");
        expect(q.take().symbol).toBe("BLIP");
    });

    it("still puts severity above opportunity", () => {
        const q = new EventQueue({ clock: () => 1000 });
        q.offer(event("BIG_BUT_MILD", 9.0, "WARNING"), 1000);
        q.offer(event("SMALL_BUT_CRITICAL", 0.8, "CRITICAL"), 1001);
        expect(q.take().symbol).toBe("SMALL_BUT_CRITICAL");
    });

    it("falls back to arrival order when opportunity is equal", () => {
        const q = new EventQueue({ clock: () => 1000 });
        q.offer(event("FIRST", 2.0), 1000);
        q.offer(event("SECOND", 2.0), 1001);
        expect(q.take().symbol).toBe("FIRST");
    });

    it("drops the weakest when it runs out of room, never the strongest", () => {
        const q = new EventQueue({ capacity: 2, clock: () => 1000 });
        q.offer(event("STRONG", 8.0), 1000);
        q.offer(event("WEAK", 0.3), 1001);
        q.offer(event("MEDIUM", 3.0), 1002);

        const served = [q.take()?.symbol, q.take()?.symbol];
        expect(served).toContain("STRONG");
        expect(served).toContain("MEDIUM");
        expect(served).not.toContain("WEAK");
    });

    it("keeps the strongest view of a condition that recurs", () => {
        const q = new EventQueue({ clock: () => 1000 });
        q.offer(event("TCS", 6.0), 1000);
        q.offer(event("TCS", 1.0), 1001);          // a later, milder look
        q.offer(event("OTHER", 3.0), 1002);
        // The mild re-observation must not demote what was already seen.
        expect(q.take().symbol).toBe("TCS");
    });

    it("treats an event carrying no move as carrying no claim", () => {
        const q = new EventQueue({ clock: () => 1000 });
        q.offer({ type: "VOLUME_SPIKE", symbol: "NOISE", severity: "CRITICAL" }, 1000);
        q.offer(event("REAL", 2.0), 1001);
        expect(q.take().symbol).toBe("REAL");
    });
});
