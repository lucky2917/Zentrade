import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// G5. One authoritative writer for cash, positions and order rows.
//
// Three modules wrote these tables with their own SQL: the execution engine,
// the manual trading path and the end-of-day square-off. The arithmetic was
// already shared, so the money was right, but the writes were not — and when
// migration 026 added a NOT NULL column, it broke exactly one of them, in the
// path that runs once a day at 15:25.
//
// This is a guard, not a style rule. It fails if that SQL reappears anywhere
// outside the bookkeeper, which is the only way "single writer" stays true
// after the person who wrote it has moved on.

const ROOT = join(process.cwd(), "src");
const WRITER = join("services", "execution", "bookkeeper.js");

const sourceFiles = (dir) => {
    const out = [];
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
            if (entry === "__tests__" || entry === "node_modules") continue;
            out.push(...sourceFiles(full));
            continue;
        }
        if (entry.endsWith(".js")) out.push(full);
    }
    return out;
};

// Each pattern is a write that must have exactly one home.
const FORBIDDEN = [
    { name: "order row insert", re: /INSERT\s+INTO\s+orders/i },
    { name: "cash mutation", re: /UPDATE\s+users\s+SET\s+balance_paise/i },
    { name: "position insert", re: /INSERT\s+INTO\s+portfolio/i },
    { name: "position update", re: /UPDATE\s+portfolio\s+SET/i },
    { name: "position delete", re: /DELETE\s+FROM\s+portfolio/i },
];

describe("one authoritative writer for order, position and cash state", () => {
    const files = sourceFiles(ROOT);

    it("finds the source tree", () => {
        expect(files.length).toBeGreaterThan(20);
    });

    for (const { name, re } of FORBIDDEN) {
        it(`only the bookkeeper performs a ${name}`, () => {
            const offenders = files
                .filter((f) => !f.endsWith(WRITER))
                .filter((f) => re.test(readFileSync(f, "utf8")))
                .map((f) => f.replace(ROOT, "src"));
            expect(offenders).toEqual([]);
        });
    }

    it("the bookkeeper actually performs every one of them", () => {
        const source = readFileSync(join(ROOT, WRITER), "utf8");
        for (const { name, re } of FORBIDDEN) {
            expect({ name, present: re.test(source) }).toEqual({ name, present: true });
        }
    });

    // A writer that other modules bypass by opening their own pool connection
    // would satisfy the checks above and defeat their purpose.
    it("every caller passes in the transaction it already holds", () => {
        const source = readFileSync(join(ROOT, WRITER), "utf8");
        expect(source).not.toMatch(/\bpool\.query\b/);
        expect(source).not.toMatch(/from "\.\.\/\.\.\/config\/db\.js"/);
    });
});
