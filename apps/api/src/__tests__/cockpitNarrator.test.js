import { describe, expect, it, vi } from "vitest";
import { Narrator, KIND, BRAIN, CATEGORY, categoryOf }
    from "../services/cockpit/narrator.js";

// The narration spine.
//
// The property this file exists to protect is that the cockpit never invents
// activity. Everything else here is about making a browser refresh safe.

const at = (ms) => new Date(Date.UTC(2026, 7, 31, 4, 30, 0, 0) + ms);

const build = (over = {}) => {
    let now = 0;
    const narrator = new Narrator({ clock: () => at(now), ...over });
    return { narrator, advance: (ms) => { now += ms; } };
};

describe("the narrator invents nothing", () => {
    // The whole cockpit rests on this. A narrator with a timer would make the
    // screen a simulation of a trader rather than a view of one.
    it("emits nothing at all unless something calls it", async () => {
        const { narrator } = build();
        const seen = [];
        narrator.subscribe((e) => seen.push(e));

        await new Promise((r) => setTimeout(r, 120));

        expect(seen).toEqual([]);
        expect(narrator.seq).toBe(0);
        expect(narrator.snapshot().events).toEqual([]);
        expect(narrator.brain).toBe(BRAIN.IDLE);
    });

    it("holds no timer of its own", () => {
        const spy = vi.spyOn(globalThis, "setInterval");
        build();
        expect(spy).not.toHaveBeenCalled();
        spy.mockRestore();
    });

    // A payload carrying its own `kind` used to replace the event's identity.
    // A PROTECTIVE_EVENT describing a STOP crossing became an event of kind
    // "STOP" — not in the vocabulary, routed nowhere, rendered as nothing.
    it("never lets a payload overwrite the event's own identity", () => {
        const { narrator } = build();
        const event = narrator.emit(KIND.PROTECTIVE_EVENT, {
            kind: "STOP", seq: 999, at: "1999-01-01T00:00:00.000Z",
            category: "NONSENSE", symbol: "RELIANCE",
        });
        expect(event.kind).toBe(KIND.PROTECTIVE_EVENT);
        expect(event.category).toBe(CATEGORY.POSITIONS);
        expect(event.seq).toBe(1);
        expect(event.at).not.toBe("1999-01-01T00:00:00.000Z");
        // The descriptive fields still arrive.
        expect(event.symbol).toBe("RELIANCE");
    });

    it("refuses a kind it does not know rather than inventing a category", () => {
        const { narrator } = build();
        expect(() => narrator.emit("MADE_UP", {})).toThrow(/unknown narration kind/);
        expect(narrator.seq).toBe(0);
    });
});

describe("sequencing makes a refresh safe", () => {
    it("assigns a monotonic sequence", () => {
        const { narrator } = build();
        for (let i = 0; i < 5; i += 1) narrator.emit(KIND.MARKET_OBSERVATION, {});
        expect(narrator.recent().map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    });

    it("returns only what a client does not already have", () => {
        const { narrator } = build();
        for (let i = 0; i < 5; i += 1) narrator.emit(KIND.MARKET_OBSERVATION, { i });
        expect(narrator.since(3).map((e) => e.seq)).toEqual([4, 5]);
        expect(narrator.since(5)).toEqual([]);
        expect(narrator.since(0).map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    });

    it("caps a catch-up so a long absence cannot flood the client", () => {
        const { narrator } = build();
        for (let i = 0; i < 50; i += 1) narrator.emit(KIND.MARKET_OBSERVATION, {});
        const page = narrator.since(0, 10);
        expect(page).toHaveLength(10);
        // The newest ten, in order, so the client sees current reality first.
        expect(page.map((e) => e.seq)).toEqual([41, 42, 43, 44, 45, 46, 47, 48, 49, 50]);
    });

    it("is bounded, and says where its history begins", () => {
        const { narrator } = build({ capacity: 10 });
        for (let i = 0; i < 25; i += 1) narrator.emit(KIND.MARKET_OBSERVATION, {});
        expect(narrator.log).toHaveLength(10);
        expect(narrator.snapshot().oldestSeq).toBe(16);
        expect(narrator.seq).toBe(25);
    });
});

describe("derived state so a late viewer sees where things stand", () => {
    it("follows the brain from idle through thinking and back", () => {
        const { narrator } = build();
        expect(narrator.brain).toBe(BRAIN.IDLE);

        narrator.emit(KIND.REASONING_STARTED, { symbol: "RELIANCE", trigger: "PRICE_JUMP" });
        expect(narrator.brain).toBe(BRAIN.THINKING);
        expect(narrator.currentThought.symbol).toBe("RELIANCE");

        narrator.emit(KIND.THESIS_FORMED, { thesis: "t" });
        narrator.emit(KIND.DECISION, { action: "HOLD" });
        expect(narrator.currentThought.stages).toHaveLength(2);
        expect(narrator.currentThought.decision).toBe("HOLD");

        narrator.emit(KIND.REASONING_FINISHED, { action: "HOLD", holdingPositions: true });
        expect(narrator.brain).toBe(BRAIN.MONITORING);
        expect(narrator.currentThought).toBeNull();
    });

    it("goes back to idle when nothing is held", () => {
        const { narrator } = build();
        narrator.emit(KIND.REASONING_STARTED, { symbol: "X" });
        narrator.emit(KIND.REASONING_FINISHED, { holdingPositions: false });
        expect(narrator.brain).toBe(BRAIN.IDLE);
    });

    it("counts reasoning per session, not for the life of the process", () => {
        const { narrator, advance } = build();
        narrator.emit(KIND.REASONING_STARTED, {});
        narrator.emit(KIND.REASONING_STARTED, {});
        expect(narrator.counters.reasoningCalls).toBe(2);

        advance(24 * 60 * 60 * 1000);   // next IST session
        narrator.emit(KIND.REASONING_STARTED, {});
        expect(narrator.counters.reasoningCalls).toBe(1);
    });

    it("keeps a decision card only when a decision reached an order", () => {
        const { narrator } = build();
        narrator.emit(KIND.REASONING_FINISHED, { action: "HOLD" });
        expect(narrator.decisionCards).toHaveLength(0);

        narrator.emit(KIND.REASONING_FINISHED, {
            action: "BUY", card: { symbol: "RELIANCE", action: "BUY" } });
        expect(narrator.decisionCards).toHaveLength(1);
        expect(narrator.decisionCards[0].symbol).toBe("RELIANCE");
    });
});

describe("categories drive the operator's filters", () => {
    it("gives every kind exactly one category", () => {
        for (const kind of Object.values(KIND)) {
            expect(Object.values(CATEGORY)).toContain(categoryOf(kind));
        }
    });

    it("filters by category without touching order", () => {
        const { narrator } = build();
        narrator.emit(KIND.MARKET_EVENT, { symbol: "A" });
        narrator.emit(KIND.DECISION, { action: "HOLD" });
        narrator.emit(KIND.MARKET_EVENT, { symbol: "B" });
        expect(narrator.recent(50, CATEGORY.MARKET).map((e) => e.symbol))
            .toEqual(["A", "B"]);
    });
});

describe("a broken viewer cannot break the runtime", () => {
    it("survives a subscriber that throws", () => {
        const { narrator } = build();
        const good = [];
        narrator.subscribe(() => { throw new Error("render exploded"); });
        narrator.subscribe((e) => good.push(e));

        expect(() => narrator.emit(KIND.DECISION, { action: "HOLD" })).not.toThrow();
        expect(good).toHaveLength(1);
    });

    it("stops delivering after unsubscribe", () => {
        const { narrator } = build();
        const seen = [];
        const off = narrator.subscribe((e) => seen.push(e));
        narrator.emit(KIND.DECISION, {});
        off();
        narrator.emit(KIND.DECISION, {});
        expect(seen).toHaveLength(1);
    });
});
