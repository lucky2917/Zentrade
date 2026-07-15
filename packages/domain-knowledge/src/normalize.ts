/**
 * Content normalization (M17) — part of semantics `knowledge_v1`, FROZEN:
 * changing this transform requires a new semantics id, because it changes
 * what content_sha256 and document identity resolve to.
 *
 * The transform is deliberately minimal and deterministic. It fixes only the
 * differences that are noise for identity — encoding form, byte-order marks,
 * line-ending style, and outer whitespace — and touches nothing else. Inner
 * structure (paragraphs, single line breaks) is preserved for chunking.
 */

const BOM = "﻿";

export const normalizeContent = (raw: string): string =>
    raw
        .normalize("NFC")
        .replace(new RegExp(BOM, "g"), "")
        .replace(/\r\n?/g, "\n")
        .trim();
