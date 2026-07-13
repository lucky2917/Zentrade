/**
 * @zentrade/kernel — shared primitives with zero runtime dependencies.
 *
 * Rules of this package (constitutional):
 *  1. No runtime dependencies. Nothing here does I/O, ever.
 *  2. Money never holds floats; division always names its rounding mode.
 *  3. Everything is deterministic given its inputs (time is injected).
 */

export {
    Money,
    CURRENCY_SCALES,
    roundDiv,
    CurrencyMismatchError,
    MoneyRangeError,
    type CurrencyCode,
    type RoundingMode,
} from "./money/money.js";

export { ok, err, isOk, isErr, map, mapErr, andThen, unwrapOr, type Result, type Ok, type Err } from "./result/result.js";

export { systemClock, fixedClock, type Clock } from "./time/clock.js";

export { isMarketOpen, isNseHoliday, istDateString, NSE_HOLIDAYS } from "./time/marketHours.js";
