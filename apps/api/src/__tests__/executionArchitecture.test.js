import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Release-blocking architecture guards for the execution path.
// These encode boundaries that a passing unit test would not notice.

const read = (p) => readFileSync(join("src", p), "utf8");
const listServices = (dir) =>
    readdirSync(join("src/services", dir)).filter((f) => f.endsWith(".js"));

describe("the AI cannot reach execution directly", () => {
    it("no agent or reasoning module imports the execution engine", () => {
        const reasoning = ["aiEngine.js", "autonomous/reassess.js", "autonomous/monitor.js"];
        for (const file of reasoning) {
            const source = read(`services/${file}`);
            expect(source).not.toMatch(/execution\/engine\.js/);
            expect(source).not.toMatch(/tradingEngine\.js/);
        }
    });

    it("the reasoning modules never mutate execution state in SQL", () => {
        for (const file of ["aiEngine.js", "autonomous/reassess.js", "autonomous/monitor.js"]) {
            const source = read(`services/${file}`);
            expect(source).not.toMatch(/INSERT INTO orders/i);
            expect(source).not.toMatch(/UPDATE orders/i);
            expect(source).not.toMatch(/INSERT INTO order_fills/i);
            expect(source).not.toMatch(/UPDATE portfolio/i);
        }
    });

    it("only the loop may call execute, and only after the risk gate", () => {
        const loop = read("services/autonomous/loop.js");
        // The single execute call site must be guarded by a risk ALLOW check.
        expect(loop).toMatch(/evaluateRisk/);
        expect(loop).toMatch(/DECISION\.REJECT/);
        const executeCalls = loop.match(/await execute\(/g) ?? [];
        expect(executeCalls).toHaveLength(1);
    });
});

describe("one execution engine, one position store", () => {
    it("no service other than the engine and tradingEngine writes to portfolio", () => {
        const offenders = [];
        for (const dir of ["", "autonomous", "execution", "fyers"]) {
            const base = dir ? `services/${dir}` : "services";
            for (const file of listServices(dir)) {
                const path = `${base}/${file}`;
                if (path.endsWith("execution/engine.js") || path.endsWith("services/tradingEngine.js")
                    || path.endsWith("services/squareOff.js")) continue;
                const source = read(path);
                if (/INSERT INTO portfolio|UPDATE portfolio SET quantity|DELETE FROM portfolio/i.test(source)) {
                    offenders.push(path);
                }
            }
        }
        expect(offenders).toEqual([]);
    });

    it("production code never imports or opens the research SQLite core", () => {
        // Checks dependencies, not prose: referring to the Python core in a
        // comment is documentation, and a guard that forbids describing the
        // architecture is a guard that will be deleted.
        const importLine = /^\s*(import .*|.*require\().*$/gm;
        for (const dir of ["", "autonomous", "execution"]) {
            for (const file of listServices(dir)) {
                const path = dir ? `services/${dir}/${file}` : `services/${file}`;
                const imports = (read(path).match(importLine) ?? []).join("\n");
                expect(imports, `${path} imports`).not.toMatch(/sqlite|better-sqlite|ZentradeBrain/i);
            }
        }
    });
});

describe("the risk gate is deterministic and unreachable by the model", () => {
    it("the gate performs no I/O and calls no model", () => {
        const gate = read("services/autonomous/riskGate.js");
        expect(gate).not.toMatch(/await |fetch\(|pool\.|redis\./);
        expect(gate).not.toMatch(/callModel|groq|openai/i);
    });

    it("the gate reads no field an LLM can set", () => {
        const gate = read("services/autonomous/riskGate.js");
        for (const field of ["confidence", "urgency", "override", "force", "reasoning"]) {
            expect(gate).not.toMatch(new RegExp(`intent\\.${field}`));
        }
    });
});
