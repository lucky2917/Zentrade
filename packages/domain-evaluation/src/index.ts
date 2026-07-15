/**
 * @zentrade/domain-evaluation — outcome labeling. Pure, deterministic,
 * zero look-ahead. The worker (apps side) supplies candles; this package
 * never fetches anything.
 */

export {
    labelDecisionOutcome,
    HORIZONS_FOR_MODE,
    type DailyCandle,
    type LabelableDecision,
    type HorizonSpec,
    type OutcomeLabel,
    type NotReady,
} from "./labeler.js";

export {
    computeCalibrationCells,
    claimedProbability,
    decayWeight,
    decisionSuccess,
    stanceSuccess,
    CALIBRATION_SEMANTICS,
    type CalibrationSample,
    type CalibrationCell,
} from "./calibration.js";

export {
    computeReflections,
    REFLECTION_SEMANTICS,
    PRIOR_WINDOW_DAYS,
    FINDING_KINDS,
    type FindingKind,
    type FindingSeverity,
    type MemoryGroup,
    type ReflectionInput,
    type ReflectionFinding,
} from "./reflection.js";
