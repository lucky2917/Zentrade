import { Router } from "express";
import { KnowledgeValidationError } from "@zentrade/domain-knowledge";
import auth from "../middleware/auth.js";
import { ingestDocument, listDocuments, getDocument } from "../services/knowledgeStore.js";
import logger from "../utils/logger.js";

const router = Router();

/**
 * Knowledge API (M17). Ingestion is the only write path into the corpus;
 * reads project stored documents and their chunks verbatim, with chunk text
 * regenerated from offsets. The corpus is immutable and influences nothing on
 * the decision path. Inputs are validated at the boundary; the domain enforces
 * license and size, and its rejections map to precise status codes.
 */

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;
const KEY_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const ERROR_STATUS = {
    missing_field: 400,
    license_not_allowed: 422,
    empty_content: 422,
    content_too_large: 413,
};

const encodeCursor = (ingestedAt, id) =>
    Buffer.from(`${new Date(ingestedAt).toISOString()}|${id}`).toString("base64url");

const decodeCursor = (raw) => {
    if (!raw) return null;
    try {
        const [iso, id] = Buffer.from(String(raw), "base64url").toString().split("|");
        if (!iso || !id || Number.isNaN(Date.parse(iso)) || !UUID_PATTERN.test(id)) return { invalid: true };
        return { ingestedAt: iso, id };
    } catch {
        return { invalid: true };
    }
};

const optionalString = (value) => (value === undefined || value === null ? null : String(value));

router.post("/", auth, async (req, res) => {
    const body = req.body ?? {};

    if (body.instrumentId !== undefined && body.instrumentId !== null && !UUID_PATTERN.test(String(body.instrumentId))) {
        return res.status(400).json({ error: "invalid instrumentId" });
    }
    if (body.publishedAt !== undefined && body.publishedAt !== null && !DATE_PATTERN.test(String(body.publishedAt))) {
        return res.status(400).json({ error: "invalid publishedAt" });
    }
    if (typeof body.rawContent !== "string") {
        return res.status(400).json({ error: "rawContent must be a string" });
    }

    try {
        const result = await ingestDocument({
            sourceUri: optionalString(body.sourceUri) ?? "",
            rawContent: body.rawContent,
            title: optionalString(body.title) ?? "",
            license: optionalString(body.license) ?? "",
            contentType: optionalString(body.contentType) ?? "",
            publisher: optionalString(body.publisher),
            publishedAt: optionalString(body.publishedAt),
            instrumentId: optionalString(body.instrumentId),
            retrievedAt: new Date().toISOString(),
        });
        res.status(result.deduped ? 200 : 201).json(result);
    } catch (err) {
        if (err instanceof KnowledgeValidationError) {
            return res.status(ERROR_STATUS[err.code] ?? 400).json({ error: err.message, code: err.code });
        }
        logger.error("KnowledgeAPI", "ingest failed", { error: err.message });
        res.status(500).json({ error: "failed to ingest document" });
    }
});

router.get("/", auth, async (req, res) => {
    const limit = Math.min(MAX_LIMIT, Math.max(1, Number(req.query.limit) || DEFAULT_LIMIT));
    const cursor = decodeCursor(req.query.cursor);
    if (cursor?.invalid) return res.status(400).json({ error: "invalid cursor" });

    try {
        const { documents, hasMore, next } = await listDocuments({ limit, cursor });
        res.json({
            documents,
            hasMore,
            nextCursor: hasMore && next ? encodeCursor(next.ingestedAt, next.id) : null,
        });
    } catch (err) {
        logger.error("KnowledgeAPI", "list failed", { error: err.message });
        res.status(500).json({ error: "failed to list documents" });
    }
});

router.get("/:documentKey", auth, async (req, res) => {
    const { documentKey } = req.params;
    if (!KEY_PATTERN.test(documentKey)) return res.status(400).json({ error: "invalid document key" });

    try {
        const document = await getDocument(documentKey);
        if (!document) return res.status(404).json({ error: "document not found" });
        res.json(document);
    } catch (err) {
        logger.error("KnowledgeAPI", "detail failed", { error: err.message });
        res.status(500).json({ error: "failed to load document" });
    }
});

export default router;
