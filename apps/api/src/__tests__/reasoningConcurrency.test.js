import { describe, expect, it } from "vitest";
import { Orchestrator, DEFAULT_REASONING } from "../services/orchestrator/orchestrator.js";
import { makeEvent } from "../services/autonomous/events.js";

// G3. Reasoning used to drain three events and process them one at a time.
// Each event costs two sequential model calls, so a cycle outlived its own
// five-second interval: the job spent the open skipping itself while the queue
// expired work at sixty seconds and offered it again forever.
//
// Symbols are now reasoned about in parallel. Events on the SAME symbol are
// not, because two workers holding one position would each propose an exit.

const OPEN_IST = new Date(Date.UTC(2026, 7, 31, 4, 30));   // 10:00 IST, a Monday

const event = (symbol, type = "PRICE_JUMP", storedId = null) => ({
    ...makeEvent({
        type, symbol, severity: "WARNING", thesisId: 1,
        correlationId: `c-${symbol}-${type}`, source: "test",
        observed: {}, reason: "test", observedAt: OPEN_IST, bucket: type,
    }),
    storedId,
});

const buildOrchestrator = ({ ports = {}, reasoning = {} } = {}) =>
    new Orchestrator({ clock: () => OPEN_IST, reasoning, ports: {
        markEventHandled: async () => null,
        markEventFailed: async () => null,
        ...ports,
    } });

// Replaces the reasoning body with something observable. The scheduling policy
// is what changed; the decision path it drives is covered elsewhere.
const instrument = (orchestrator, { delayMs = 10 } = {}) => {
    const log = { started: [], finished: [], inFlight: 0, peak: 0, overlaps: new Set() };
    orchestrator.handleEvent = async (evt) => {
        log.inFlight += 1;
        log.peak = Math.max(log.peak, log.inFlight);
        log.started.push(evt.symbol);
        for (const other of log.started.slice(0, -1)) {
            if (!log.finished.includes(other)) log.overlaps.add(`${other}|${evt.symbol}`);
        }
        await new Promise((r) => setTimeout(r, delayMs));
        log.finished.push(evt.symbol);
        log.inFlight -= 1;
        return { symbol: evt.symbol, type: evt.type };
    };
    return log;
};

describe("bounded parallel reasoning", () => {
    it("defaults to a batch larger than one worker can carry", () => {
        expect(DEFAULT_REASONING.batch).toBeGreaterThan(DEFAULT_REASONING.concurrency);
        expect(DEFAULT_REASONING.concurrency).toBeGreaterThan(1);
    });

    it("reasons about different symbols at the same time", async () => {
        const orchestrator = buildOrchestrator({ reasoning: { batch: 6, concurrency: 3 } });
        const log = instrument(orchestrator);
        for (const s of ["A", "B", "C"]) orchestrator.queue.offer(event(s), OPEN_IST.getTime());

        await orchestrator.reasoningCycle();
        expect(log.peak).toBe(3);
        expect(log.finished.sort()).toEqual(["A", "B", "C"]);
    });

    it("never reasons about one symbol twice at once", async () => {
        const orchestrator = buildOrchestrator({ reasoning: { batch: 6, concurrency: 3 } });
        const log = instrument(orchestrator);
        // Three different conditions on the same position, all queued together.
        for (const type of ["PRICE_JUMP", "STOP_APPROACHING", "VOLUME_SPIKE"]) {
            orchestrator.queue.offer(event("A", type), OPEN_IST.getTime());
        }

        await orchestrator.reasoningCycle();
        expect(log.peak).toBe(1);
        expect(log.overlaps.has("A|A")).toBe(false);
        expect(log.started).toEqual(["A", "A", "A"]);
    });

    it("holds concurrency at the configured ceiling", async () => {
        const orchestrator = buildOrchestrator({ reasoning: { batch: 8, concurrency: 2 } });
        const log = instrument(orchestrator);
        for (const s of ["A", "B", "C", "D", "E", "F"]) {
            orchestrator.queue.offer(event(s), OPEN_IST.getTime());
        }

        await orchestrator.reasoningCycle();
        expect(log.peak).toBe(2);
        expect(log.finished).toHaveLength(6);
        expect(orchestrator.metrics.maxReasoningConcurrency).toBe(2);
    });

    // The reason this work exists. Sequentially six events cost six delays; the
    // point of the change is that they no longer do.
    it("clears a burst in fewer passes than it has events", async () => {
        const orchestrator = buildOrchestrator({ reasoning: { batch: 6, concurrency: 3 } });
        const log = instrument(orchestrator, { delayMs: 40 });
        for (const s of ["A", "B", "C", "D", "E", "F"]) {
            orchestrator.queue.offer(event(s), OPEN_IST.getTime());
        }

        const started = Date.now();
        await orchestrator.reasoningCycle();
        const elapsed = Date.now() - started;

        expect(log.finished).toHaveLength(6);
        // Six events, three workers: two passes, not six.
        expect(elapsed).toBeLessThan(40 * 5);
    });

    it("returns results in chain order, not completion order", async () => {
        const orchestrator = buildOrchestrator({ reasoning: { batch: 6, concurrency: 3 } });
        const delays = { A: 40, B: 5, C: 20 };
        orchestrator.handleEvent = async (evt) => {
            await new Promise((r) => setTimeout(r, delays[evt.symbol]));
            return { symbol: evt.symbol };
        };
        for (const s of ["A", "B", "C"]) orchestrator.queue.offer(event(s), OPEN_IST.getTime());

        const handled = await orchestrator.reasoningCycle();
        expect(handled.map((h) => h.symbol)).toEqual(["A", "B", "C"]);
    });

    it("keeps a failing event from abandoning the rest of its chain", async () => {
        const failed = [];
        const handledIds = [];
        const orchestrator = buildOrchestrator({
            reasoning: { batch: 6, concurrency: 2 },
            ports: {
                markEventFailed: async (id, err) => { failed.push([id, err]); return null; },
                markEventHandled: async (id) => { handledIds.push(id); return null; },
            },
        });
        orchestrator.handleEvent = async (evt) => {
            if (evt.type === "PRICE_JUMP") throw new Error("model unavailable");
            return { symbol: evt.symbol, type: evt.type };
        };
        orchestrator.queue.offer(event("A", "PRICE_JUMP", 11), OPEN_IST.getTime());
        orchestrator.queue.offer(event("A", "STOP_APPROACHING", 12), OPEN_IST.getTime());
        orchestrator.queue.offer(event("B", "PRICE_JUMP", 13), OPEN_IST.getTime());

        const handled = await orchestrator.reasoningCycle();
        expect(handled).toHaveLength(3);
        expect(orchestrator.metrics.errors).toBe(2);
        // The failures stay PENDING so the condition comes back.
        expect(failed.map((f) => f[0]).sort()).toEqual([11, 13]);
        // The second event on the failing symbol still ran.
        expect(handledIds).toEqual([12]);
    });

    it("does nothing and costs nothing when the queue is empty", async () => {
        const orchestrator = buildOrchestrator();
        const log = instrument(orchestrator);
        const handled = await orchestrator.reasoningCycle();
        expect(handled).toEqual([]);
        expect(log.started).toEqual([]);
        expect(orchestrator.metrics.reasoningBatches).toBe(0);
    });

    it("still returns released events to the durable store", async () => {
        const released = [];
        const orchestrator = buildOrchestrator({
            ports: { markEventFailed: async (id, err) => { released.push([id, err]); return null; } },
        });
        instrument(orchestrator);
        orchestrator.queue.capacity = 1;
        orchestrator.queue.offer(event("A", "PRICE_JUMP", 1), OPEN_IST.getTime());
        orchestrator.queue.offer(event("B", "PRICE_JUMP", 2), OPEN_IST.getTime());

        await orchestrator.reasoningCycle();
        expect(released).toHaveLength(1);
        expect(released[0][1]).toBe("released by the queue");
    });
});
