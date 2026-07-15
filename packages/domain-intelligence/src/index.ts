/**
 * @zentrade/domain-intelligence — intelligence domain logic. Pure.
 * M7 scope: journal hashing, cost accounting, record validation.
 */

// canonical hashing lives in kernel since M12; re-exported here so M7 consumers are unchanged
export { canonicalStringify, canonicalHash } from "@zentrade/kernel";
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
