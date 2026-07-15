import type { CalibrationCell } from "./calibration.js";

/**
 * Reflection (M16) — semantics `reflection_v1`, FROZEN: changing any
 * threshold or rule below requires a new semantics id.
 *
 * Reflections are structured observations the system makes about itself by
 * reading its own measurement history. They state measured facts with
 * references — never recommendations, never advice. Nothing on the decision
 * path reads them.
 *
 * Finding kinds:
 *  - calibration_drift:  |brier now - brier prior| >= 0.05, both cells
 *    sufficient, prior snapshot at least 7 days older (cold start = silence)
 *  - miscalibration:     sufficient cell with brier > 0.25 — strictly worse
 *    than claiming maximal uncertainty; stated confidence carries negative
 *    information there
 *  - regime_weakness:    sufficient regime cell hit rate >= 15 points BELOW
 *    the same agent/version/horizon "all" cell (itself sufficient)
 *  - regime_strength:    same rule, ABOVE
 *  - contradiction:      a memory group (symbol, action, regime, horizon)
 *    holding >= 2 targets AND >= 2 stops — the same setup produced opposite
 *    decisive outcomes; reasoning must resolve it, reflection only surfaces it
 *
 * Sufficiency gates are inherited from calibration_v1: insufficient cells
 * can never generate findings. Output ordering is a total lexicographic
 * order over (kind, subject) so replays are byte-identical.
 */

export const REFLECTION_SEMANTICS = "reflection_v1" as const;
export const PRIOR_WINDOW_DAYS = 7;

const DRIFT_MIN = 0.05;
const MISCALIBRATION_BRIER = 0.25;
const REGIME_DELTA = 0.15;
const CONTRADICTION_MIN_EACH = 2;

export const FINDING_KINDS = [
    "calibration_drift",
    "miscalibration",
    "regime_weakness",
    "regime_strength",
    "contradiction",
] as const;
export type FindingKind = (typeof FINDING_KINDS)[number];

export type FindingSeverity = "info" | "warning" | "critical";

const SEVERITY_BY_KIND: Record<FindingKind, FindingSeverity> = {
    calibration_drift: "warning",
    miscalibration: "critical",
    regime_weakness: "warning",
    regime_strength: "info",
    contradiction: "warning",
};

export interface MemoryGroup {
    symbol: string;
    action: string;
    regime: string;
    horizon: string;
    targets: number;
    stops: number;
}

export interface ReflectionInput {
    currentCells: readonly CalibrationCell[];
    /** cells of the latest snapshot >= PRIOR_WINDOW_DAYS older, or null when none exists */
    priorCells: readonly CalibrationCell[] | null;
    memoryGroups: readonly MemoryGroup[];
}

export interface ReflectionFinding {
    kind: FindingKind;
    severity: FindingSeverity;
    subject: string;
    detail: Record<string, unknown>;
}

const round4 = (x: number): number => Math.round(x * 1e4) / 1e4;

const cellKey = (c: CalibrationCell): string => `${c.agentName} ${c.agentVersion} ${c.regime} ${c.horizon}`;

const finding = (kind: FindingKind, subject: string, detail: Record<string, unknown>): ReflectionFinding => ({
    kind,
    severity: SEVERITY_BY_KIND[kind],
    subject,
    detail,
});

const driftFindings = (
    current: readonly CalibrationCell[],
    prior: readonly CalibrationCell[] | null,
): ReflectionFinding[] => {
    if (!prior) return [];
    const priorByKey = new Map(prior.map((c) => [cellKey(c), c]));
    const out: ReflectionFinding[] = [];
    for (const now of current) {
        if (!now.sufficient || now.brier === null) continue;
        const then = priorByKey.get(cellKey(now));
        if (!then || !then.sufficient || then.brier === null) continue;
        const delta = round4(now.brier - then.brier);
        if (Math.abs(delta) >= DRIFT_MIN) {
            out.push(
                finding("calibration_drift", cellKey(now), {
                    brierNow: now.brier,
                    brierPrior: then.brier,
                    delta,
                    direction: delta > 0 ? "degrading" : "improving",
                }),
            );
        }
    }
    return out;
};

const miscalibrationFindings = (current: readonly CalibrationCell[]): ReflectionFinding[] =>
    current
        .filter((c) => c.sufficient && c.brier !== null && c.brier > MISCALIBRATION_BRIER)
        .map((c) =>
            finding("miscalibration", cellKey(c), {
                brier: c.brier,
                threshold: MISCALIBRATION_BRIER,
                hitRate: c.hitRate,
                nEffective: c.nEffective,
            }),
        );

const regimeFindings = (current: readonly CalibrationCell[]): ReflectionFinding[] => {
    const allCells = new Map(
        current
            .filter((c) => c.regime === "all" && c.sufficient && c.hitRate !== null)
            .map((c) => [`${c.agentName} ${c.agentVersion} ${c.horizon}`, c]),
    );
    const out: ReflectionFinding[] = [];
    for (const c of current) {
        if (c.regime === "all" || !c.sufficient || c.hitRate === null) continue;
        const baseline = allCells.get(`${c.agentName} ${c.agentVersion} ${c.horizon}`);
        if (!baseline || baseline.hitRate === null) continue;
        const delta = round4(c.hitRate - baseline.hitRate);
        if (Math.abs(delta) < REGIME_DELTA) continue;
        out.push(
            finding(delta < 0 ? "regime_weakness" : "regime_strength", cellKey(c), {
                regimeHitRate: c.hitRate,
                overallHitRate: baseline.hitRate,
                delta,
                nEffective: c.nEffective,
            }),
        );
    }
    return out;
};

const contradictionFindings = (groups: readonly MemoryGroup[]): ReflectionFinding[] =>
    groups
        .filter((g) => g.targets >= CONTRADICTION_MIN_EACH && g.stops >= CONTRADICTION_MIN_EACH)
        .map((g) =>
            finding("contradiction", `${g.symbol} ${g.action} ${g.regime} ${g.horizon}`, {
                targets: g.targets,
                stops: g.stops,
            }),
        );

export const computeReflections = (input: ReflectionInput): ReflectionFinding[] => {
    const findings = [
        ...driftFindings(input.currentCells, input.priorCells),
        ...miscalibrationFindings(input.currentCells),
        ...regimeFindings(input.currentCells),
        ...contradictionFindings(input.memoryGroups),
    ];
    findings.sort((a, b) => `${a.kind}|${a.subject}`.localeCompare(`${b.kind}|${b.subject}`));
    return findings;
};
