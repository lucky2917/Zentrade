import { Router } from "express";
import auth from "../middleware/auth.js";
import { pool } from "../config/db.js";
import logger from "../utils/logger.js";

const router = Router();

/**
 * Journal Read API (M9). Constitutional rules:
 *  - read-only: no statement here ever mutates journal state
 *  - verbatim: rows are projected as stored (column renames only) — nothing
 *    recomputed, re-validated or inferred
 *  - keyset pagination: append-only streams must not shift pages under
 *    concurrent inserts (offset pagination lies here)
 *  - decisions are shared market analyses; linked ORDERS are personal and
 *    are filtered to the requesting user
 */

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const encodeCursor = (createdAt, id) =>
    Buffer.from(`${new Date(createdAt).toISOString()}|${id}`).toString("base64url");

const decodeCursor = (raw) => {
    if (!raw) return null;
    try {
        const [iso, id] = Buffer.from(String(raw), "base64url").toString().split("|");
        if (!iso || !id || Number.isNaN(Date.parse(iso)) || !UUID_PATTERN.test(id)) return { invalid: true };
        return { createdAt: iso, id };
    } catch {
        return { invalid: true };
    }
};

const decisionSummary = (row) => ({
    decisionId: row.id,
    requestId: row.request_id,
    instrument: { instrumentId: row.instrument_id, venue: row.venue, symbol: row.symbol, currency: row.currency },
    action: row.action,
    mode: row.mode,
    confidence: row.confidence,
    entryMinor: row.entry_minor === null ? null : Number(row.entry_minor),
    targetMinor: row.target_minor === null ? null : Number(row.target_minor),
    stopMinor: row.stop_minor === null ? null : Number(row.stop_minor),
    synthesizerVersion: row.synthesizer_version,
    correlationId: row.correlation_id,
    createdAt: row.created_at,
});

router.get("/", auth, async (req, res) => {
    try {
        const limit = Math.min(MAX_LIMIT, Math.max(1, Number(req.query.limit) || DEFAULT_LIMIT));
        const cursor = decodeCursor(req.query.cursor);
        if (cursor?.invalid) return res.status(400).json({ error: "Invalid cursor" });

        const params = [];
        const where = [];

        if (req.query.instrument) {
            const symbol = String(req.query.instrument).toUpperCase().slice(0, 32);
            const venue = String(req.query.venue ?? "NSE").toUpperCase().slice(0, 16);
            params.push(venue, symbol);
            where.push(`i.venue = $${params.length - 1} AND i.symbol = $${params.length}`);
        }

        if (cursor) {
            params.push(cursor.createdAt, cursor.id);
            where.push(`(d.created_at, d.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
        }

        params.push(limit + 1);
        const { rows } = await pool.query(
            `SELECT d.id, d.request_id, d.instrument_id, d.action, d.mode, d.confidence,
                    d.entry_minor, d.target_minor, d.stop_minor, d.synthesizer_version,
                    d.correlation_id, d.created_at, i.venue, i.symbol, i.currency
             FROM decisions d
             JOIN instruments i ON i.id = d.instrument_id
             ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
             ORDER BY d.created_at DESC, d.id DESC
             LIMIT $${params.length}`,
            params
        );

        const hasMore = rows.length > limit;
        const page = hasMore ? rows.slice(0, limit) : rows;
        const last = page[page.length - 1];

        res.json({
            decisions: page.map(decisionSummary),
            hasMore,
            nextCursor: hasMore && last ? encodeCursor(last.created_at, last.id) : null,
        });
    } catch (err) {
        logger.error("DecisionsAPI", "list failed", { error: err.message });
        res.status(500).json({ error: "Failed to fetch decisions" });
    }
});

router.get("/:id", auth, async (req, res) => {
    try {
        const { id } = req.params;
        if (!UUID_PATTERN.test(id)) return res.status(400).json({ error: "Invalid decision id" });

        const { rows: decisionRows } = await pool.query(
            `SELECT d.*, i.venue, i.symbol, i.currency
             FROM decisions d JOIN instruments i ON i.id = d.instrument_id
             WHERE d.id = $1`,
            [id]
        );
        const decision = decisionRows[0];
        if (!decision) return res.status(404).json({ error: "Decision not found" });

        const [requestRows, runRows, evidenceRows, orderRows, outcomeRows] = await Promise.all([
            pool.query("SELECT * FROM decision_requests WHERE id = $1", [decision.request_id]),
            pool.query(
                `SELECT id, agent_name, agent_version, model_id, input_hash, output, status,
                        latency_ms, prompt_tokens, completion_tokens, cost_usd, citation_report, created_at
                 FROM agent_runs WHERE request_id = $1 ORDER BY created_at, agent_name`,
                [decision.request_id]
            ),
            pool.query(
                "SELECT id, ref, kind, source_ref, content, weight, created_at FROM evidence WHERE request_id = $1 ORDER BY ref",
                [decision.request_id]
            ),
            // orders are PERSONAL: only the requester's own linked trades appear
            pool.query(
                `SELECT id, type, quantity, price_paise, total_value_paise, brokerage_paise, pnl_paise, order_mode, created_at
                 FROM orders WHERE decision_id = $1 AND user_id = $2 ORDER BY id`,
                [id, req.userId]
            ),
            pool.query(
                "SELECT id, horizon, basis, hit, entry_minor, exit_minor, realized_return_bps, sessions_used, data_source, labeled_at FROM outcomes WHERE decision_id = $1 ORDER BY horizon",
                [id]
            ),
        ]);
        const request = requestRows.rows[0];

        res.json({
            decision: decisionSummary(decision),
            rationale: decision.rationale,
            request: {
                requestId: request.id,
                requestedBy: request.requested_by,
                correlationId: request.correlation_id,
                contextSnapshot: request.context_snapshot,
                regime: request.regime,
                createdAt: request.created_at,
            },
            agentRuns: runRows.rows.map((r) => ({
                runId: r.id,
                agentName: r.agent_name,
                agentVersion: r.agent_version,
                modelId: r.model_id,
                inputHash: r.input_hash,
                output: r.output,
                status: r.status,
                citationReport: r.citation_report,
                latencyMs: r.latency_ms,
                promptTokens: r.prompt_tokens,
                completionTokens: r.completion_tokens,
                costUsd: r.cost_usd === null ? null : Number(r.cost_usd),
                createdAt: r.created_at,
            })),
            evidence: evidenceRows.rows.map((e) => ({
                evidenceId: e.id,
                ref: e.ref,
                kind: e.kind,
                sourceRef: e.source_ref,
                content: e.content,
                weight: e.weight === null ? null : Number(e.weight),
                createdAt: e.created_at,
            })),
            outcomes: outcomeRows.rows.map((o) => ({
                outcomeId: o.id,
                horizon: o.horizon,
                basis: o.basis,
                hit: o.hit,
                entryMinor: o.entry_minor === null ? null : Number(o.entry_minor),
                exitMinor: o.exit_minor === null ? null : Number(o.exit_minor),
                realizedReturnBps: o.realized_return_bps,
                sessionsUsed: o.sessions_used,
                dataSource: o.data_source,
                labeledAt: o.labeled_at,
            })),
            myOrders: orderRows.rows.map((o) => ({
                orderId: o.id,
                side: o.type,
                quantity: o.quantity,
                priceMinor: Number(o.price_paise),
                totalValueMinor: Number(o.total_value_paise),
                brokerageMinor: Number(o.brokerage_paise),
                pnlMinor: o.pnl_paise === null ? null : Number(o.pnl_paise),
                mode: o.order_mode,
                createdAt: o.created_at,
            })),
        });
    } catch (err) {
        logger.error("DecisionsAPI", "detail failed", { error: err.message });
        res.status(500).json({ error: "Failed to fetch decision" });
    }
});

export default router;
