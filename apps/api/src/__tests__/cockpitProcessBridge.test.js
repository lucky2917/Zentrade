import { describe, expect, it, vi } from "vitest";
import { Narrator, KIND, BRAIN } from "../services/cockpit/narrator.js";

// Narration crossing a process boundary.
//
// The autonomous runtime and the API are separate processes: the trader can
// restart without dropping the cockpit, and the API cannot start a second
// runtime. Narration therefore has a writer (the agent) and a reader (the API).
//
// The writer assigns the sequence. The reader preserves it. If both assigned
// their own, a browser reconnecting to the reader would dedupe against numbers
// the writer never used.

const fakeRedis = () => {
    const handlers = {};
    const published = [];
    const client = {
        published,
        publish: vi.fn(async (channel, payload) => { published.push({ channel, payload }); }),
        duplicate: () => ({
            on: (name, fn) => { handlers[name] = fn; },
            subscribe: vi.fn(async () => 1),
            quit: vi.fn(async () => "OK"),
        }),
        deliver: (channel, payload) => handlers.message?.(channel, payload),
    };
    return client;
};

describe("the writer publishes, the reader preserves", () => {
    it("carries an event across with its identity intact", async () => {
        const writer = new Narrator();
        const reader = new Narrator();
        const redis = fakeRedis();
        writer.publishTo(redis, "cockpit:narration");
        await reader.consumeFrom(redis, "cockpit:narration");

        writer.emit(KIND.DECISION, { symbol: "RELIANCE", action: "HOLD" });
        await new Promise((r) => setImmediate(r));
        redis.deliver("cockpit:narration", redis.published[0].payload);

        expect(reader.recent()).toHaveLength(1);
        const [event] = reader.recent();
        expect(event.seq).toBe(1);
        expect(event.kind).toBe(KIND.DECISION);
        expect(event.symbol).toBe("RELIANCE");
        expect(reader.seq).toBe(writer.seq);
    });

    it("rebuilds the reader's derived state from the stream alone", async () => {
        const writer = new Narrator();
        const reader = new Narrator();
        const redis = fakeRedis();
        writer.publishTo(redis, "c");
        await reader.consumeFrom(redis, "c");

        writer.emit(KIND.REASONING_STARTED, { symbol: "RELIANCE", trigger: "PRICE_JUMP" });
        writer.emit(KIND.THESIS_FORMED, { thesis: "continuation" });
        writer.emit(KIND.DECISION, { action: "HOLD" });
        await new Promise((r) => setImmediate(r));
        for (const m of redis.published) redis.deliver("c", m.payload);

        expect(reader.brain).toBe(BRAIN.THINKING);
        expect(reader.currentThought.symbol).toBe("RELIANCE");
        expect(reader.currentThought.stages).toHaveLength(2);
        expect(reader.counters.reasoningCalls).toBe(1);
    });

    it("drops a duplicate rather than renumbering it", async () => {
        const writer = new Narrator();
        const reader = new Narrator();
        const redis = fakeRedis();
        writer.publishTo(redis, "c");
        await reader.consumeFrom(redis, "c");

        writer.emit(KIND.MARKET_EVENT, { symbol: "A" });
        await new Promise((r) => setImmediate(r));
        redis.deliver("c", redis.published[0].payload);
        redis.deliver("c", redis.published[0].payload);   // redelivered

        expect(reader.recent()).toHaveLength(1);
        expect(reader.seq).toBe(1);
    });

    it("drops an out-of-order arrival rather than rewinding", async () => {
        const reader = new Narrator();
        const event = (seq) => JSON.stringify({
            seq, at: "2026-08-31T04:30:00.000Z", kind: KIND.MARKET_EVENT,
            category: "MARKET", symbol: `S${seq}` });
        const redis = fakeRedis();
        await reader.consumeFrom(redis, "c");

        redis.deliver("c", event(5));
        redis.deliver("c", event(3));
        redis.deliver("c", event(6));

        expect(reader.recent().map((e) => e.seq)).toEqual([5, 6]);
    });

    it("ignores a message that is not narration at all", async () => {
        const reader = new Narrator();
        const redis = fakeRedis();
        await reader.consumeFrom(redis, "c");

        redis.deliver("c", "not json");
        redis.deliver("c", JSON.stringify({ seq: 1, kind: "MADE_UP", at: "x" }));
        redis.deliver("c", JSON.stringify({ kind: KIND.DECISION, at: "x" }));   // no seq

        expect(reader.recent()).toEqual([]);
        expect(reader.seq).toBe(0);
    });

    it("does not let a publish failure reach the decision path", async () => {
        const writer = new Narrator();
        const redis = fakeRedis();
        redis.publish = vi.fn(async () => { throw new Error("redis down"); });
        writer.publishTo(redis, "c");

        expect(() => writer.emit(KIND.DECISION, { action: "HOLD" })).not.toThrow();
        await new Promise((r) => setImmediate(r));
        expect(writer.recent()).toHaveLength(1);
    });

    it("reports which side of the bridge it is on", async () => {
        const writer = new Narrator();
        const reader = new Narrator();
        const redis = fakeRedis();
        writer.publishTo(redis, "c");
        await reader.consumeFrom(redis, "c");

        expect(writer.health().publishing).toBe(true);
        expect(writer.health().consuming).toBe(false);
        expect(reader.health().consuming).toBe(true);
        expect(reader.health().publishing).toBe(false);
    });
});

describe("exactly one runtime can exist", () => {
    it("the API process never constructs an autonomous runtime", async () => {
        const { readFileSync } = await import("node:fs");
        const { join } = await import("node:path");
        const source = readFileSync(join(process.cwd(), "src/index.js"), "utf8");
        expect(source).not.toMatch(/new AutonomousRuntime/);
        expect(source).not.toMatch(/setReflexSink/);
        // It follows the agent's narration instead.
        expect(source).toMatch(/consumeFrom\(redis, NARRATION_CHANNEL\)/);
    });

    it("the vendor edge holds no detector of its own", async () => {
        const { readFileSync } = await import("node:fs");
        const { join } = await import("node:path");
        const source = readFileSync(
            join(process.cwd(), "src/services/fyers/fyersWebSocket.js"), "utf8");
        expect(source).not.toMatch(/reflexSink/);
        expect(source).not.toMatch(/ingestTick/);
    });

    it("the agent process is the only one that builds the runtime", async () => {
        const { readFileSync } = await import("node:fs");
        const { join } = await import("node:path");
        const source = readFileSync(join(process.cwd(), "src/agent.js"), "utf8");
        expect(source).toMatch(/new AutonomousRuntime/);
        // And it does not serve HTTP: one process, one responsibility.
        expect(source).not.toMatch(/express|listen\(/);
        // Bars are built by the API from the socket it owns.
        expect(source).toMatch(/barAggregator: null/);
    });
});
