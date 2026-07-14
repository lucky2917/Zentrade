import { randomUUID } from "node:crypto";
import {
    buildAgentRun,
    buildDecision,
    buildContextSnapshot,
} from "@zentrade/domain-intelligence";
import { INTEL_DECISION_PUBLISHED } from "@zentrade/contracts";
import { currentCorrelationId, metrics } from "@zentrade/observability";
import { pool } from "../config/db.js";
import { instrumentResolver } from "./referenceData.js";
import { enqueueEvent } from "./eventBackbone.js";
import { raiseAlarm } from "./opsAlarms.js";
import logger from "../utils/logger.js";

/**
 * Decision Journal repository (M7) — permanent historical evidence.
 *
 * Properties, in priority order:
 *  correctness   — records validated by domain builders BEFORE any tx opens
 *  immutability  — enforced in the database (triggers, migration 015)
 *  traceability  — instrument FK, correlation id, request->runs->decision chain
 *  auditability  — model ids, input hashes, token counts, cost at write time
 *  replayability — hashes are canonical; the event mirrors the row
 *  performance   — one transaction, one round-trip-ish flush, measured
 *
 * Dark by default: JOURNAL_ENABLED must be set. Journal failure must never
 * break the analyse path — it logs, counts, and alarms instead.
 */

export const isJournalEnabled = () =>
    process.env.JOURNAL_ENABLED === "1" || process.env.JOURNAL_ENABLED === "true";

export const journalAnalysis = async ({ symbol, trigger, contextSnapshot, runs, decision }) => {
    // validate everything before touching the database
    const snapshot = buildContextSnapshot(contextSnapshot);
    const runRecords = runs.map((r) => buildAgentRun(r));
    const decisionRecord = decision ? buildDecision(decision) : null;

    const instrument = await instrumentResolver.bySymbol("NSE", symbol);
    if (!instrument) {
        throw new Error(`cannot journal unregistered instrument NSE:${symbol}`);
    }

    const correlationId = currentCorrelationId() ?? randomUUID();

    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        const {
            rows: [request],
        } = await client.query(
            `INSERT INTO decision_requests (instrument_id, requested_by, correlation_id, context_snapshot)
             VALUES ($1, $2, $3, $4) RETURNING id`,
            [instrument.instrumentId, trigger, correlationId, JSON.stringify(snapshot)]
        );

        for (const run of runRecords) {
            await client.query(
                `INSERT INTO agent_runs
                   (request_id, agent_name, agent_version, model_id, input_hash, output,
                    status, latency_ms, prompt_tokens, completion_tokens, cost_usd)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
                [
                    request.id,
                    run.agentName,
                    run.agentVersion,
                    run.modelId,
                    run.inputHash,
                    JSON.stringify(run.output ?? null),
                    run.status,
                    run.latencyMs,
                    run.promptTokens,
                    run.completionTokens,
                    run.costUsd,
                ]
            );
        }

        let decisionId = null;
        if (decisionRecord) {
            const {
                rows: [row],
            } = await client.query(
                `INSERT INTO decisions
                   (request_id, instrument_id, action, mode, confidence,
                    entry_minor, target_minor, stop_minor, rationale, synthesizer_version, correlation_id)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
                [
                    request.id,
                    instrument.instrumentId,
                    decisionRecord.action,
                    decisionRecord.mode,
                    decisionRecord.confidence,
                    decisionRecord.entryMinor,
                    decisionRecord.targetMinor,
                    decisionRecord.stopMinor,
                    JSON.stringify(decisionRecord.rationale),
                    decisionRecord.synthesizerVersion,
                    correlationId,
                ]
            );
            decisionId = row.id;

            // event commits atomically with the journal rows it announces
            await enqueueEvent(
                {
                    type: INTEL_DECISION_PUBLISHED.type,
                    v: INTEL_DECISION_PUBLISHED.v,
                    correlationId,
                    payload: {
                        decisionId,
                        requestId: request.id,
                        instrumentId: instrument.instrumentId,
                        venue: instrument.venue,
                        symbol: instrument.symbol,
                        action: decisionRecord.action,
                        mode: decisionRecord.mode,
                        confidence: decisionRecord.confidence,
                        currency: instrument.currency,
                        entryMinor: decisionRecord.entryMinor,
                        targetMinor: decisionRecord.targetMinor,
                        stopMinor: decisionRecord.stopMinor,
                        agentRunCount: runRecords.length,
                    },
                },
                client
            );
        }

        await client.query("COMMIT");
        metrics.counter("journal.requests").inc();
        metrics.counter("journal.agent_runs").inc(runRecords.length);
        if (decisionId) metrics.counter("journal.decisions").inc();
        return { requestId: request.id, decisionId, correlationId };
    } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
    } finally {
        client.release();
    }
};

/** The analyse-path entry: flag-gated, never throws into the caller. */
export const journalSafely = async (input) => {
    if (!isJournalEnabled()) return null;
    const started = performance.now();
    try {
        const result = await journalAnalysis(input);
        metrics.gauge("journal.last_flush_ms").set(Math.round(performance.now() - started));
        return result;
    } catch (err) {
        metrics.counter("journal.write_failures").inc();
        logger.error("DecisionJournal", "write failed (analysis unaffected)", {
            symbol: input?.symbol,
            error: err.message,
        });
        await raiseAlarm("journal_write_failure", "Decision journal write failed", [
            `Symbol: ${input?.symbol ?? "unknown"}; error: ${err.message}`,
            "AI runs are NOT being recorded. Investigate before trusting journal completeness.",
        ]).catch(() => {});
        return null;
    }
};
