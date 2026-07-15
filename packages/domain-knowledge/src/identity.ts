import { canonicalHash } from "@zentrade/kernel";

/**
 * Knowledge identity (M17) — content-addressed, permanent, and independent of
 * every representation choice we might later make.
 *
 * A document is identified by WHERE it came from and WHAT it says:
 *   documentKey = hash(scope="document", sourceUri, contentSha256)
 * A chunk is identified by its document, its position, and its exact content:
 *   chunkKey = hash(scope="chunk", documentKey, ordinal, textSha256)
 *
 * No embedding model, vector store, chunk ranking, or retrieval score appears
 * anywhere in identity. Embeddings are a downstream index keyed by chunkKey;
 * re-embedding produces new side data for the same key, never a new chunk.
 * Identity is permanent; representations are replaceable.
 */

export const documentKey = (sourceUri: string, contentSha256: string): string =>
    canonicalHash({ scope: "document", sourceUri, contentSha256 });

export const chunkKey = (docKey: string, ordinal: number, textSha256: string): string =>
    canonicalHash({ scope: "chunk", documentKey: docKey, ordinal, textSha256 });
