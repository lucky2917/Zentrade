import { describe, it, expect } from "vitest";
import { computeReflections, type MemoryGroup } from "../reflection.js";
import type { CalibrationCell } from "../calibration.js";

const cell = (overrides: Partial<CalibrationCell> = {}): CalibrationCell => ({
    agentName: "synthesizer",
    agentVersion: "v4.0.0",
    regime: "all",
    horizon: "intraday",
    n: 40,
    nEffective: 30,
    sufficient: true,
    brier: 0.2,
    hitRate: 0.6,
    ...overrides,
});

const group = (overrides: Partial<MemoryGroup> = {}): MemoryGroup => ({
    symbol: "RELIANCE",
    action: "BUY",
    regime: "UP_LOWVOL",
    horizon: "intraday",
    targets: 3,
    stops: 3,
    ...overrides,
});

const empty = { currentCells: [], priorCells: null, memoryGroups: [] };

describe("calibration drift", () => {
    it("fires at |delta| >= 0.05 between sufficient cells, with direction", () => {
        const findings = computeReflections({
            ...empty,
            currentCells: [cell({ brier: 0.26 })],
            priorCells: [cell({ brier: 0.2 })],
        });
        const drift = findings.find((f) => f.kind === "calibration_drift");
        expect(drift).toMatchObject({
            severity: "warning",
            subject: "synthesizer v4.0.0 all intraday",
            detail: { brierNow: 0.26, brierPrior: 0.2, delta: 0.06, direction: "degrading" },
        });
    });

    it("improvement is also drift, honestly labeled", () => {
        const [f] = computeReflections({
            ...empty,
            currentCells: [cell({ brier: 0.14 })],
            priorCells: [cell({ brier: 0.2 })],
        });
        expect(f!.detail.direction).toBe("improving");
    });

    it("silent below threshold, on cold start, and on insufficient cells", () => {
        expect(
            computeReflections({ ...empty, currentCells: [cell({ brier: 0.24 })], priorCells: [cell({ brier: 0.2 })] })
        ).toHaveLength(0);
        expect(computeReflections({ ...empty, currentCells: [cell()], priorCells: null })).toHaveLength(0);
        expect(
            computeReflections({
                ...empty,
                currentCells: [cell({ sufficient: false, brier: null, hitRate: null })],
                priorCells: [cell()],
            })
        ).toHaveLength(0);
        expect(
            computeReflections({
                ...empty,
                currentCells: [cell({ brier: 0.3 })],
                priorCells: [cell({ sufficient: false, brier: null })],
            }).filter((f) => f.kind === "calibration_drift")
        ).toHaveLength(0);
    });
});

describe("miscalibration", () => {
    it("brier strictly above 0.25 is critical: confidence carries negative information", () => {
        const findings = computeReflections({ ...empty, currentCells: [cell({ brier: 0.2513 })] });
        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({ kind: "miscalibration", severity: "critical" });
    });

    it("exactly 0.25 (maximal uncertainty) is NOT a finding; insufficient cells never fire", () => {
        expect(computeReflections({ ...empty, currentCells: [cell({ brier: 0.25 })] })).toHaveLength(0);
        expect(
            computeReflections({ ...empty, currentCells: [cell({ sufficient: false, brier: null, hitRate: null })] })
        ).toHaveLength(0);
    });
});

describe("regime weakness and strength", () => {
    it("a regime cell 15+ points under the agent's overall hit rate is a weakness", () => {
        const findings = computeReflections({
            ...empty,
            currentCells: [cell({ hitRate: 0.6 }), cell({ regime: "DOWN_HIGHVOL", hitRate: 0.4 })],
        });
        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({
            kind: "regime_weakness",
            severity: "warning",
            subject: "synthesizer v4.0.0 DOWN_HIGHVOL intraday",
            detail: { regimeHitRate: 0.4, overallHitRate: 0.6, delta: -0.2 },
        });
    });

    it("15+ points above is a strength (info); 14 points is silence", () => {
        const strong = computeReflections({
            ...empty,
            currentCells: [cell({ hitRate: 0.6 }), cell({ regime: "UP_LOWVOL", hitRate: 0.76 })],
        });
        expect(strong[0]).toMatchObject({ kind: "regime_strength", severity: "info" });

        const quiet = computeReflections({
            ...empty,
            currentCells: [cell({ hitRate: 0.6 }), cell({ regime: "UP_LOWVOL", hitRate: 0.74 })],
        });
        expect(quiet).toHaveLength(0);
    });

    it("no sufficient overall baseline means no regime findings", () => {
        const findings = computeReflections({
            ...empty,
            currentCells: [cell({ sufficient: false, hitRate: null, brier: null }), cell({ regime: "UP_LOWVOL", hitRate: 0.2 })],
        });
        expect(findings.filter((f) => f.kind.startsWith("regime_"))).toHaveLength(0);
    });
});

describe("contradictions", () => {
    it("2+ targets AND 2+ stops on one setup surface together as one finding", () => {
        const findings = computeReflections({ ...empty, memoryGroups: [group({ targets: 4, stops: 2 })] });
        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({
            kind: "contradiction",
            severity: "warning",
            subject: "RELIANCE BUY UP_LOWVOL intraday",
            detail: { targets: 4, stops: 2 },
        });
    });

    it("a single fluke on either side is not a pattern", () => {
        expect(computeReflections({ ...empty, memoryGroups: [group({ targets: 5, stops: 1 })] })).toHaveLength(0);
        expect(computeReflections({ ...empty, memoryGroups: [group({ targets: 1, stops: 5 })] })).toHaveLength(0);
    });
});

describe("determinism and shape", () => {
    it("output order is a total order over (kind, subject), independent of input order", () => {
        const input = {
            currentCells: [
                cell({ brier: 0.3 }),
                cell({ agentName: "technical", brier: 0.31 }),
                cell({ hitRate: 0.6 }),
                cell({ regime: "DOWN_HIGHVOL", hitRate: 0.3 }),
            ],
            priorCells: [cell({ brier: 0.2 })],
            memoryGroups: [group(), group({ symbol: "TCS" })],
        };
        const a = computeReflections(input);
        const b = computeReflections({
            currentCells: [...input.currentCells].reverse(),
            priorCells: input.priorCells,
            memoryGroups: [...input.memoryGroups].reverse(),
        });
        expect(b).toEqual(a);
        expect(a.map((f) => `${f.kind}|${f.subject}`)).toEqual([...a.map((f) => `${f.kind}|${f.subject}`)].sort());
    });

    it("findings state facts with references, never recommendations", () => {
        const findings = computeReflections({
            ...empty,
            currentCells: [cell({ brier: 0.3 })],
            memoryGroups: [group()],
        });
        for (const f of findings) {
            const text = JSON.stringify(f);
            expect(text).not.toMatch(/should|must|recommend|avoid|prefer/i);
        }
    });
});
