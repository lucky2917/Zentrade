import { AnalystKeyPoint } from "@zentrade/contracts";

/**
 * Citation validation (M8). A claim without evidence, or citing evidence
 * that was never in the bundle, invalidates the run — the constitution's
 * "citation theater" defense. Coercion is deliberately minimal: a bare
 * string keyPoint becomes an UNCITED claim (and thus invalid), never a
 * silently-pardoned one.
 */

export interface ParsedKeyPoint {
    point: string;
    refs: string[];
}

export interface CitationReport {
    status: "ok" | "invalid";
    keyPoints: ParsedKeyPoint[];
    uncitedCount: number;
    unknownRefs: string[];
}

/** Coerce raw LLM keyPoints into inspectable shape without pardoning them. */
export const parseKeyPoints = (raw: unknown): ParsedKeyPoint[] => {
    if (!Array.isArray(raw)) return [];
    return raw.slice(0, 8).map((entry) => {
        if (typeof entry === "string") return { point: entry.slice(0, 300), refs: [] };
        const parsed = AnalystKeyPoint.safeParse(entry);
        if (parsed.success) return parsed.data;
        const maybe = entry as { point?: unknown; refs?: unknown };
        return {
            point: String(maybe?.point ?? "").slice(0, 300),
            refs: Array.isArray(maybe?.refs) ? maybe.refs.map(String).slice(0, 8) : [],
        };
    });
};

export const validateCitations = (rawKeyPoints: unknown, bundleRefs: ReadonlySet<string>): CitationReport => {
    const keyPoints = parseKeyPoints(rawKeyPoints);
    const unknownRefs: string[] = [];
    let uncitedCount = 0;

    for (const kp of keyPoints) {
        if (kp.refs.length === 0 || kp.point.length === 0) uncitedCount++;
        for (const ref of kp.refs) {
            if (!bundleRefs.has(ref)) unknownRefs.push(ref);
        }
    }

    const status = keyPoints.length === 0 || uncitedCount > 0 || unknownRefs.length > 0 ? "invalid" : "ok";
    return { status, keyPoints, uncitedCount, unknownRefs };
};
