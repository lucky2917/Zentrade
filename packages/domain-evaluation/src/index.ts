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
