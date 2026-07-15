/**
 * @zentrade/domain-intelligence — intelligence domain logic. Pure.
 * M7 scope: journal hashing, cost accounting, record validation.
 */

export { canonicalStringify, canonicalHash } from "./journal/hash.js";
export { modelCostUsd, KNOWN_MODELS, type TokenUsage } from "./journal/cost.js";
export {
    priceToMinor,
    buildAgentRun,
    buildDecision,
    buildContextSnapshot,
    AgentRunRecord,
    DecisionRecord,
    ContextSnapshot,
} from "./journal/records.js";

export { buildEvidenceBundle, renderEvidenceLegend } from "./evidence/bundle.js";
export {
    parseKeyPoints,
    validateCitations,
    type ParsedKeyPoint,
    type CitationReport,
} from "./evidence/citations.js";
