import { createHash } from "node:crypto";

/**
 * Canonical hashing (M7, relocated to kernel in M12 — generic primitive).
 *
 * Journal rows store a sha256 of every agent's input instead of the raw
 * prompt (prompt text lives in versioned code; storing it would bloat the
 * journal and duplicate git). The hash must be REPRODUCIBLE forever:
 * identical logical input -> identical hash, regardless of object key
 * order or insertion history. Replay (M21) depends on this.
 */

/** Deterministic serialization: object keys sorted recursively; arrays keep order. */
export const canonicalStringify = (value: unknown): string => {
    if (value === null || typeof value !== "object") {
        if (value === undefined) return "null";
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return `[${value.map(canonicalStringify).join(",")}]`;
    }
    const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => `${JSON.stringify(k)}:${canonicalStringify(v)}`);
    return `{${entries.join(",")}}`;
};

/** sha256 hex of the canonical form. */
export const canonicalHash = (value: unknown): string =>
    createHash("sha256").update(canonicalStringify(value)).digest("hex");

/**
 * sha256 hex of a string's UTF-8 bytes, verbatim (no canonicalization).
 * Used to fingerprint stored content — normalized documents and their chunk
 * slices — so integrity and identity are reproducible from the bytes alone.
 */
export const sha256Hex = (input: string): string =>
    createHash("sha256").update(input, "utf8").digest("hex");
