import { describe, it, expect } from "vitest";
import {
    createLogger,
    createMetrics,
    runWithCorrelation,
    currentCorrelationId,
    ensureCorrelationId,
    type LogRecord,
} from "../index.js";

const capture = () => {
    const lines: string[] = [];
    const records: LogRecord[] = [];
    return {
        lines,
        records,
        sink: (line: string, record: LogRecord) => {
            lines.push(line);
            records.push(record);
        },
    };
};

describe("logger — json format", () => {
    it("emits one parseable OTel-shaped object per line", () => {
        const cap = capture();
        const log = createLogger({ format: "json", sink: cap.sink });
        log.info("Ctx", "hello", { a: 1 });

        const parsed = JSON.parse(cap.lines[0]!);
        expect(parsed).toMatchObject({
            severityText: "INFO",
            channel: "INFO",
            context: "Ctx",
            body: "hello",
            attributes: { a: 1 },
        });
        expect(new Date(parsed.timestamp).toString()).not.toBe("Invalid Date");
    });

    it("attaches the active correlation id automatically, in and only in scope", () => {
        const cap = capture();
        const log = createLogger({ format: "json", sink: cap.sink });
        runWithCorrelation("11111111-2222-4333-8444-555555555555", () => log.info("Ctx", "inside"));
        log.info("Ctx", "outside");

        expect(cap.records[0]!.correlationId).toBe("11111111-2222-4333-8444-555555555555");
        expect(cap.records[1]!.correlationId).toBeUndefined();
    });
});

describe("logger — sampling", () => {
    it("drops INFO by rate, always keeps WARN/ERROR and exempt channels", () => {
        const cap = capture();
        const log = createLogger({
            format: "json",
            sink: cap.sink,
            sampleRate: 0,
            sampleExemptChannels: ["TRADE"],
            random: () => 0.99,
        });
        log.info("Ctx", "dropped");
        log.warn("Ctx", "kept-warn");
        log.error("Ctx", "kept-error");
        log.log("INFO", "TRADE", "Ctx", "kept-trade");

        expect(cap.records.map((r) => r.body)).toEqual(["kept-warn", "kept-error", "kept-trade"]);
    });

    it("rate 0.5 keeps roughly half deterministically via injected random", () => {
        const cap = capture();
        let flip = false;
        const log = createLogger({ format: "json", sink: cap.sink, sampleRate: 0.5, random: () => ((flip = !flip) ? 0.1 : 0.9) });
        for (let i = 0; i < 10; i++) log.info("Ctx", `m${i}`);
        expect(cap.records).toHaveLength(5);
    });
});

describe("correlation context", () => {
    it("survives await boundaries and nests correctly", async () => {
        await runWithCorrelation("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", async () => {
            expect(currentCorrelationId()).toBe("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
            await new Promise((r) => setTimeout(r, 5));
            expect(currentCorrelationId()).toBe("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
            runWithCorrelation("99999999-8888-4777-8666-555555555555", () => {
                expect(currentCorrelationId()).toBe("99999999-8888-4777-8666-555555555555");
            });
            expect(currentCorrelationId()).toBe("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
        });
        expect(currentCorrelationId()).toBeUndefined();
    });

    it("ensureCorrelationId honors valid uuids and mints otherwise", () => {
        expect(ensureCorrelationId("AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE")).toBe(
            "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        );
        const minted = ensureCorrelationId("not-a-uuid; DROP TABLE--");
        expect(minted).toMatch(/^[0-9a-f-]{36}$/);
        expect(ensureCorrelationId(undefined)).toMatch(/^[0-9a-f-]{36}$/);
    });
});

describe("metrics", () => {
    it("counters accumulate, gauges overwrite, snapshot serializes", () => {
        const m = createMetrics();
        m.counter("events.published").inc();
        m.counter("events.published").inc(41);
        m.gauge("outbox.unpublished").set(7);
        m.gauge("outbox.unpublished").set(3);

        expect(m.snapshot()).toEqual({
            counters: { "events.published": 42 },
            gauges: { "outbox.unpublished": 3 },
        });
    });
});

describe("performance floor", () => {
    it("a json log line costs well under the trade-path budget", () => {
        const log = createLogger({ format: "json", sink: () => {} });
        const N = 20_000;
        const start = performance.now();
        for (let i = 0; i < N; i++) log.info("Bench", "trade executed", { i, symbol: "RELIANCE", qty: 5 });
        const perCallMs = (performance.now() - start) / N;
        // eslint-disable-next-line no-console
        console.log(`json log: ${(perCallMs * 1000).toFixed(1)}µs/call`);
        // trade path is ~10ms; 2 log lines must stay <3% => <150µs each
        expect(perCallMs).toBeLessThan(0.15);
    });
});
