/**
 * @zentrade/domain-marketdata — market-data domain logic. Pure.
 * M12 scope: versioned regime classification.
 */

export {
    classifyRegime,
    REGIME_TAXONOMY,
    MIN_SESSIONS,
    type RegimeCandle,
    type RegimeLabel,
    type RegimeNotReady,
    type Trend,
    type VolBucket,
} from "./regime.js";
