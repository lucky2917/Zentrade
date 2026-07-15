import { z } from "zod";
import { defineEvent } from "../envelope/envelope.js";

/**
 * eval.outcome.labeled v1 — a decision's realized outcome was recorded (M11).
 * Outcomes are historical facts: computed deterministically from candles
 * available strictly after decision time, reproducible forever.
 */
export const OutcomeHit = z.enum(["target", "stop", "neither"]);
export type OutcomeHit = z.infer<typeof OutcomeHit>;

export const OutcomeBasis = z.enum(["path", "close", "squareoff", "abstain"]);
export type OutcomeBasis = z.infer<typeof OutcomeBasis>;

export const EvalOutcomeLabeledPayloadV1 = z.strictObject({
    outcomeId: z.uuid(),
    decisionId: z.uuid(),
    instrumentId: z.uuid(),
    horizon: z.string().min(1).max(16),
    basis: OutcomeBasis,
    hit: OutcomeHit,
    realizedReturnBps: z.int().nullable(),
    entryMinor: z.int().nullable(),
    exitMinor: z.int().nullable(),
    sessionsUsed: z.int().nonnegative(),
});
export type EvalOutcomeLabeledPayloadV1 = z.infer<typeof EvalOutcomeLabeledPayloadV1>;

export const EvalOutcomeLabeledV1 = defineEvent("eval.outcome.labeled", 1, EvalOutcomeLabeledPayloadV1);
export const EVAL_OUTCOME_LABELED = { type: "eval.outcome.labeled", v: 1 } as const;

/**
 * eval.calibration.updated v1 — a new calibration snapshot was computed (M13).
 * Snapshots are append-only derived aggregates: each recompute inserts a new
 * one; nothing about a prior snapshot ever changes. Measurement only —
 * NOTHING consumes this to influence decisions yet.
 */
export const EvalCalibrationUpdatedPayloadV1 = z.strictObject({
    snapshotId: z.uuid(),
    asOf: z.iso.date(),
    semantics: z.string().min(1).max(32),
    cellCount: z.int().nonnegative(),
    sufficientCells: z.int().nonnegative(),
    sampleCount: z.int().nonnegative(),
});
export type EvalCalibrationUpdatedPayloadV1 = z.infer<typeof EvalCalibrationUpdatedPayloadV1>;

export const EvalCalibrationUpdatedV1 = defineEvent("eval.calibration.updated", 1, EvalCalibrationUpdatedPayloadV1);
export const EVAL_CALIBRATION_UPDATED = { type: "eval.calibration.updated", v: 1 } as const;
