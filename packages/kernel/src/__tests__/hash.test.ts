import { describe, it, expect } from "vitest";
import { sha256Hex, canonicalHash, canonicalStringify } from "../hash/canonical.js";

describe("sha256Hex", () => {
    it("matches the standard SHA-256 test vector for 'abc'", () => {
        expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    });

    it("is deterministic and sensitive to every byte", () => {
        expect(sha256Hex("knowledge")).toBe(sha256Hex("knowledge"));
        expect(sha256Hex("knowledge")).not.toBe(sha256Hex("knowledgе")); // last char is Cyrillic е
    });
});

describe("canonicalHash", () => {
    it("is invariant to object key order", () => {
        expect(canonicalStringify({ a: 1, b: 2 })).toBe(canonicalStringify({ b: 2, a: 1 }));
        expect(canonicalHash({ a: 1, b: 2 })).toBe(canonicalHash({ b: 2, a: 1 }));
    });

    it("preserves array order", () => {
        expect(canonicalHash([1, 2])).not.toBe(canonicalHash([2, 1]));
    });
});
