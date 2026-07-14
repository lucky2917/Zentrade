import { NSE_HOLIDAYS, istDateString } from "@zentrade/kernel";

/**
 * Trading-calendar domain rules.
 *
 * Data convention (matches migration 014): calendar rows exist only for
 * EXCEPTIONS. An absent weekday means a regular session; weekends are closed.
 * Session times are venue-local wall clock, minutes-since-midnight here.
 */

export interface CalendarRow {
    venue: string;
    calDate: string; // YYYY-MM-DD, venue-local
    isHoliday: boolean;
    sessionOpenMinute?: number | null;
    sessionCloseMinute?: number | null;
}

export interface SessionSpec {
    openMinute: number; // inclusive
    closeMinute: number; // inclusive (NSE closes AT 15:30)
    utcOffsetMinutes: number;
}

export const NSE_SESSION: SessionSpec = {
    openMinute: 9 * 60 + 15,
    closeMinute: 15 * 60 + 30,
    utcOffsetMinutes: 330,
};

/** The exception rows to seed for NSE, derived from the kernel's single-source holiday set. */
export const nseCalendarSeedRows = (venue = "NSE"): CalendarRow[] =>
    [...NSE_HOLIDAYS].sort().map((date) => ({ venue, calDate: date, isHoliday: true }));

const venueLocalParts = (at: Date, spec: SessionSpec): { dateStr: string; minuteOfDay: number; weekday: number } => {
    const shifted = new Date(at.getTime() + spec.utcOffsetMinutes * 60_000);
    return {
        dateStr: shifted.toISOString().slice(0, 10),
        minuteOfDay: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
        weekday: shifted.getUTCDay(),
    };
};

/**
 * Is the venue's session open at instant `at`, given its exception rows?
 * Pure: the caller supplies the rows (adapter fetches them).
 */
export const isSessionOpenAt = (
    at: Date,
    spec: SessionSpec,
    exceptionRows: readonly CalendarRow[],
): boolean => {
    const { dateStr, minuteOfDay, weekday } = venueLocalParts(at, spec);

    if (weekday === 0 || weekday === 6) return false;

    const exception = exceptionRows.find((r) => r.calDate === dateStr);
    if (exception) {
        if (exception.isHoliday) return false;
        const open = exception.sessionOpenMinute ?? spec.openMinute;
        const close = exception.sessionCloseMinute ?? spec.closeMinute;
        return minuteOfDay >= open && minuteOfDay <= close;
    }

    return minuteOfDay >= spec.openMinute && minuteOfDay <= spec.closeMinute;
};

/** Re-export for differential testing convenience. */
export { istDateString };
