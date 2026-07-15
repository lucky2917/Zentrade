/**
 * @zentrade/domain-knowledge — the knowledge corpus domain. Deterministic
 * normalization, chunking, and content-addressed identity. Pure: no I/O, no
 * embeddings, no retrieval. Identity is permanent; representations are indexes
 * built later, keyed by the identities defined here.
 */

export { KNOWLEDGE_LICENSES, isAllowedLicense, type KnowledgeLicense } from "./license.js";

export { normalizeContent } from "./normalize.js";

export { documentKey, chunkKey } from "./identity.js";

export { chunkDocument, CHUNK_MAX_CHARS, type BuiltChunk } from "./chunk.js";

export {
    buildDocument,
    KNOWLEDGE_SEMANTICS,
    KnowledgeValidationError,
    type KnowledgeErrorCode,
    type DocumentInput,
    type BuiltDocument,
} from "./knowledge.js";
