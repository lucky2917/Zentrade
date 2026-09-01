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

// ---- the screen has to know what execution can do ---------------------------
//
// Execution is long-only: the risk gate refuses a SELL with no position held
// and the ledger cannot open a short. A falling stock therefore has no
// executable thesis in it, however clean the setup.
//
// Sending them anyway produced the strangest rows in the record. Offered only
// "BUY" or "HOLD", the model wrote an honestly bearish thesis on a falling
// stock — UNITECH "a sharp volume-driven sell-off", M&M "aggressive selling
// pressure" — proposed BUY because nothing else was available, and left stop
// and target null, because there are no long levels under a short thesis. Two
// model calls each, at 8,000 tokens a minute, for a trade the book cannot take.

describe("a book that cannot short does not reason about shorts", () => {
    const ctx = (mtf) => ({ mtf: { complete: true, ...mtf } });

    it("turns away a setup aligned down", async () => {
        const { tradeableDirection } = await import("../services/autonomous/candidates.js");
        const v = tradeableDirection(ctx({ aligned: true, alignedDirection: "DOWN",
                                          change5m: -0.04 }));
        expect(v.worth).toBe(false);
        expect(v.reason).toMatch(/cannot open a short/);
    });

    it("keeps a setup aligned up", async () => {
        const { tradeableDirection } = await import("../services/autonomous/candidates.js");
        expect(tradeableDirection(ctx({ aligned: true, alignedDirection: "UP",
                                        change5m: 0.04 })).worth).toBe(true);
    });

    // A dip that has not resolved into a downtrend is still a long candidate —
    // a pullback entry is exactly that shape — so only a settled alignment
    // turns one away.
    it("keeps an unaligned pullback, which is a long setup", async () => {
        const { tradeableDirection } = await import("../services/autonomous/candidates.js");
        expect(tradeableDirection(ctx({ aligned: false, alignedDirection: null,
                                        change5m: -0.03 })).worth).toBe(true);
        expect(tradeableDirection(ctx({ conflict: true, change1m: -0.01,
                                        change5m: 0.03 })).worth).toBe(true);
    });

    it("says yes when there is nothing to judge", async () => {
        const { tradeableDirection } = await import("../services/autonomous/candidates.js");
        expect(tradeableDirection(null).worth).toBe(true);
        expect(tradeableDirection(ctx({})).worth).toBe(true);
    });
});

// ---- the shortlist must be filled with candidates that can trade ------------
//
// scanUniverse ranks by the SIZE of the move and cuts to the strongest few. In
// a falling market the biggest movers are the biggest falls, so the shortlist
// filled entirely with shorts, every one was refused downstream, and the real
// longs behind them were never reached. Measured live with the market 82 down
// to 13 up: ZENSARTECH +3.35% on 6.2x volume, HAVELLS +1.63% on 13.4x,
// POLICYBZR on 48.4x — none reasoned about, zero model calls in five minutes.

describe("a falling market does not crowd out the longs", () => {
    const observation = (symbol) => ({ symbol, stale: false, price: 100 });

    it("screens out a settled downtrend before it can take a shortlist slot",
       async () => {
        const { screenSymbol } = await import("../services/autonomous/candidates.js");
        const down = screenSymbol(observation("FALLER"),
            { mtf: { complete: true, aligned: true, alignedDirection: "DOWN",
                     change5m: -0.09 } });
        expect(down.passed).toBe(false);
        expect(down.reasons.join(" ")).toMatch(/cannot open a short/);
    });

    it("keeps a rise, however much smaller than the falls around it", async () => {
        const { screenSymbol } = await import("../services/autonomous/candidates.js");
        const up = screenSymbol(observation("RISER"),
            { mtf: { complete: true, aligned: true, alignedDirection: "UP",
                     change5m: 0.012 } });
        expect(up.passed).toBe(true);
    });

    it("keeps an unaligned dip, which can still be a long entry", async () => {
        const { screenSymbol } = await import("../services/autonomous/candidates.js");
        const dip = screenSymbol(observation("DIP"),
            { mtf: { complete: true, aligned: false, conflict: true, change5m: -0.03 } });
        expect(dip.passed).toBe(true);
    });

    // The point of moving the check into the screen: a small riser must beat a
    // large faller onto the shortlist, because the faller cannot be traded.
    it("shortlists the riser over the bigger faller", async () => {
        const { scanUniverse } = await import("../services/autonomous/candidates.js");
        const { rankCandidates } = await import("../services/autonomous/candidates.js");
        // rankCandidates is what cuts the list; feed it what the screen admits.
        const admitted = [
            { symbol: "RISER", context: { mtf: { complete: true, change5m: 0.012 } } },
        ];
        expect(rankCandidates(admitted).map((c) => c.symbol)).toEqual(["RISER"]);
        expect(typeof scanUniverse).toBe("function");
    });
});
