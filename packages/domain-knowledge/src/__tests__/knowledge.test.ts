import { describe, it, expect } from "vitest";
import { sha256Hex } from "@zentrade/kernel";
import {
    buildDocument,
    chunkDocument,
    documentKey,
    chunkKey,
    normalizeContent,
    isAllowedLicense,
    KNOWLEDGE_LICENSES,
    KNOWLEDGE_SEMANTICS,
    CHUNK_MAX_CHARS,
    KnowledgeValidationError,
    type DocumentInput,
} from "../index.js";

const input = (overrides: Partial<DocumentInput> = {}): DocumentInput => ({
    sourceUri: "https://sebi.gov.in/report/2026-07-01",
    rawContent: "First paragraph of the filing.\n\nSecond paragraph with more detail.",
    title: "Quarterly Filing",
    license: "public-domain",
    contentType: "text/plain",
    retrievedAt: "2026-07-16T10:00:00.000Z",
    maxChars: 500_000,
    ...overrides,
});

describe("normalization (knowledge_v1)", () => {
    it("is deterministic: NFC, BOM stripped, CRLF folded, outer whitespace trimmed", () => {
        const raw = "﻿  café\r\n\r\nsecond line  ";
        expect(normalizeContent(raw)).toBe("café\n\nsecond line");
    });

    it("preserves inner single line breaks", () => {
        expect(normalizeContent("line one\nline two")).toBe("line one\nline two");
    });
});

describe("document identity", () => {
    it("is content plus provenance, and nothing else", () => {
        const a = buildDocument(input());
        const sameContentDifferentMetadata = buildDocument(
            input({ title: "Renamed", license: "operator-owned", publisher: "SEBI" }),
        );
        expect(sameContentDifferentMetadata.documentKey).toBe(a.documentKey);
    });

    it("changes when the content changes", () => {
        const a = buildDocument(input());
        const b = buildDocument(input({ rawContent: "First paragraph of the filing.\n\nDifferent second paragraph." }));
        expect(b.documentKey).not.toBe(a.documentKey);
    });

    it("changes when the source changes, even for identical content", () => {
        const a = buildDocument(input());
        const b = buildDocument(input({ sourceUri: "https://mirror.example/report" }));
        expect(b.documentKey).not.toBe(a.documentKey);
    });

    it("stamps the frozen semantics on every document", () => {
        expect(buildDocument(input()).knowledgeSemantics).toBe(KNOWLEDGE_SEMANTICS);
    });
});

describe("chunking (knowledge_v1)", () => {
    it("covers content with contiguous non-overlapping ordered chunks", () => {
        const built = buildDocument(input());
        built.chunks.forEach((chunk, i) => {
            expect(chunk.ordinal).toBe(i);
            expect(chunk.charEnd).toBeGreaterThanOrEqual(chunk.charStart);
            if (i > 0) expect(chunk.charStart).toBeGreaterThanOrEqual(built.chunks[i - 1]!.charEnd);
        });
    });

    it("regenerates chunk text exactly by slicing the normalized document", () => {
        const built = buildDocument(input());
        for (const chunk of built.chunks) {
            expect(built.normalizedText.slice(chunk.charStart, chunk.charEnd)).toBe(chunk.text);
            expect(sha256Hex(chunk.text)).toBe(chunk.textSha256);
        }
    });

    it("packs small paragraphs together up to the budget", () => {
        const paragraphs = Array.from({ length: 4 }, (_, i) => `paragraph ${i} short body`).join("\n\n");
        const chunks = chunkDocument(normalizeContent(paragraphs), "k");
        expect(chunks).toHaveLength(1);
    });

    it("hard-splits a single paragraph longer than the budget, never exceeding it", () => {
        const long = "a".repeat(CHUNK_MAX_CHARS * 2 + 300);
        const chunks = chunkDocument(long, "k");
        expect(chunks).toHaveLength(3);
        for (const chunk of chunks) expect(chunk.charEnd - chunk.charStart).toBeLessThanOrEqual(CHUNK_MAX_CHARS);
        expect(chunks[chunks.length - 1]!.charEnd).toBe(long.length);
    });

    it("is deterministic and independent of chunk identity across a re-run", () => {
        const a = buildDocument(input());
        const b = buildDocument(input());
        expect(b.chunks.map((c) => c.chunkKey)).toEqual(a.chunks.map((c) => c.chunkKey));
    });
});

describe("license enforcement", () => {
    it("accepts every allowlisted license", () => {
        for (const license of KNOWLEDGE_LICENSES) {
            expect(isAllowedLicense(license)).toBe(true);
            expect(buildDocument(input({ license })).license).toBe(license);
        }
    });

    it("fails closed on an unknown license before any storage", () => {
        expect(isAllowedLicense("gpl-3.0")).toBe(false);
        expect(() => buildDocument(input({ license: "gpl-3.0" }))).toThrow(KnowledgeValidationError);
        try {
            buildDocument(input({ license: "" }));
        } catch (err) {
            expect((err as KnowledgeValidationError).code).toBe("license_not_allowed");
        }
    });
});

describe("size guard", () => {
    it("rejects content whose normalized length exceeds the configured limit", () => {
        try {
            buildDocument(input({ rawContent: "x".repeat(50), maxChars: 10 }));
            throw new Error("expected rejection");
        } catch (err) {
            expect(err).toBeInstanceOf(KnowledgeValidationError);
            expect((err as KnowledgeValidationError).code).toBe("content_too_large");
        }
    });

    it("measures the normalized length, so trimmed noise does not count", () => {
        expect(buildDocument(input({ rawContent: `  ${"x".repeat(10)}  `, maxChars: 10 })).charLen).toBe(10);
    });

    it("rejects content that is empty after normalization", () => {
        try {
            buildDocument(input({ rawContent: "   \n\n   " }));
            throw new Error("expected rejection");
        } catch (err) {
            expect((err as KnowledgeValidationError).code).toBe("empty_content");
        }
    });
});

describe("replay", () => {
    it("recomputes every identity from the stored normalized text and offsets", () => {
        const built = buildDocument(input({ rawContent: "alpha para one.\n\nbeta para two.\n\ngamma para three." }));
        expect(documentKey(built.sourceUri, sha256Hex(built.normalizedText))).toBe(built.documentKey);
        for (const chunk of built.chunks) {
            const text = built.normalizedText.slice(chunk.charStart, chunk.charEnd);
            expect(chunkKey(built.documentKey, chunk.ordinal, sha256Hex(text))).toBe(chunk.chunkKey);
        }
    });
});

describe("embeddings are not identity", () => {
    it("the built document exposes no embedding or vector field", () => {
        const keys = Object.keys(buildDocument(input()));
        expect(keys.some((k) => /embed|vector|model/i.test(k))).toBe(false);
    });
});
