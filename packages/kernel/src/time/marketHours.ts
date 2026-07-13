/**
 * NSE session logic — lifted verbatim from apps/api/src/utils/marketHours.js
 * (M3), parameterized by `at` so replay and tests can pin time. This is the
 * single source going forward; the apps/api copy remains until its consumers
 * migrate (M5 calendars), guarded by a drift-tripwire fixture test here.
 *
 * Semantics preserved exactly: Mon–Fri, 09:15–15:30 IST inclusive, closed on
 * NSE holidays. Holiday list is maintained per calendar year.
 */

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

// M1 (api audit): NSE trading holidays — update this set each year.
// Source: NSE India official holiday list (https://www.nseindia.com).
export const NSE_HOLIDAYS: ReadonlySet<string> = new Set([
    // 2025
    "2025-01-26",
    "2025-03-14",
    "2025-04-14",
    "2025-04-18",
    "2025-05-01",
    "2025-08-15",
    "2025-10-02",
    "2025-10-20",
    "2025-10-22",
    "2025-11-05",
    "2025-12-25",
    // 2026
    "2026-01-26",
    "2026-02-19",
    "2026-03-03",
    "2026-04-03",
    "2026-04-14",
    "2026-05-01",
    "2026-08-15",
    "2026-10-02",
    "2026-11-09",
    "2026-11-10",
    "2026-11-24",
    "2026-12-25",
]);

/** Shift a Date so its local getters read IST wall-clock time. */
const toIstWallClock = (at: Date): Date =>
    new Date(at.getTime() + IST_OFFSET_MS + at.getTimezoneOffset() * 60 * 1000);

export const istDateString = (at: Date): string => {
    const ist = toIstWallClock(at);
    const month = String(ist.getMonth() + 1).padStart(2, "0");
    const day = String(ist.getDate()).padStart(2, "0");
    return `${ist.getFullYear()}-${month}-${day}`;
};

export const isNseHoliday = (at: Date): boolean => NSE_HOLIDAYS.has(istDateString(at));

const MARKET_OPEN_MINUTE = 9 * 60 + 15;
const MARKET_CLOSE_MINUTE = 15 * 60 + 30;

export const isMarketOpen = (at: Date = new Date()): boolean => {
    const ist = toIstWallClock(at);

    const day = ist.getDay();
    if (day === 0 || day === 6) return false;

    if (NSE_HOLIDAYS.has(istDateString(at))) return false;

    const minuteOfDay = ist.getHours() * 60 + ist.getMinutes();
    return minuteOfDay >= MARKET_OPEN_MINUTE && minuteOfDay <= MARKET_CLOSE_MINUTE;
};
