/**
 * @zentrade/contracts — the schema spine of ZenTrade.
 *
 * Rules of this package (constitutional):
 *  1. Zero dependencies besides zod. It imports from no other workspace.
 *  2. Everything is strict: unknown keys are rejected at the boundary.
 *  3. Evolution is append-only — see envelope.ts for the versioning policy.
 *  4. Every exported schema has a committed JSON-Schema golden; changing a
 *     golden is a reviewed, deliberate act (the breaking-change tripwire).
 */

export { AssetClass, OrderSide, Stance, Confidence, RegimeTag, UNLABELED_REGIME } from "./common/enums.js";
export { Venue, InstrumentRef, VenueSymbolRef } from "./common/instrument.js";
export { EventEnvelopeBase, defineEvent, EVENT_TYPE_PATTERN } from "./envelope/envelope.js";
export { MarketTick } from "./marketdata/tick.js";
export { Candle, CandleResolution } from "./marketdata/candle.js";
export { MdCandleClosedV1, MdCandleClosedPayloadV1, MD_CANDLE_CLOSED } from "./marketdata/events.js";
export { MdRegimeLabeledV1, MdRegimeLabeledPayloadV1, MD_REGIME_LABELED } from "./marketdata/regimeEvents.js";
export { RefInstrumentAddedV1, RefInstrumentAddedPayloadV1, REF_INSTRUMENT_ADDED } from "./reference/events.js";
export {
    IntelDecisionPublishedV1,
    IntelDecisionPublishedPayloadV1,
    INTEL_DECISION_PUBLISHED,
    DecisionAction,
} from "./intelligence/events.js";
export {
    EvidenceKind,
    EvidenceRef,
    EvidenceItem,
    AnalystKeyPoint,
    CitationStatus,
    EVIDENCE_REF_PATTERN,
} from "./intelligence/evidence.js";
export { TradeExecutedV1, TradeExecutedPayloadV1, TRADE_EXECUTED } from "./trading/events.js";
export {
    EvalOutcomeLabeledV1,
    EvalOutcomeLabeledPayloadV1,
    EVAL_OUTCOME_LABELED,
    OutcomeHit,
    OutcomeBasis,
} from "./evaluation/events.js";
