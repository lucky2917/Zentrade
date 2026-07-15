/**
 * License allowlist (M17). Knowledge enters the corpus only under a license
 * we are permitted to store. This is an ALLOWLIST enforced fail-closed: an
 * unknown or unlisted license is rejected, never assumed permissive.
 *
 * The list is additive-only. Adding a license is a deliberate, reviewed edit
 * here AND in the database CHECK constraint. An existing license identifier
 * is never removed or silently reinterpreted — a document's license means
 * forever what it meant at ingestion.
 */

export const KNOWLEDGE_LICENSES = [
    "public-domain",
    "operator-owned",
    "cc-by-4.0",
    "cc-by-sa-4.0",
    "licensed-redistributable",
] as const;

export type KnowledgeLicense = (typeof KNOWLEDGE_LICENSES)[number];

export const isAllowedLicense = (license: string): license is KnowledgeLicense =>
    (KNOWLEDGE_LICENSES as readonly string[]).includes(license);
