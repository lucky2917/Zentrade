import { describe, it, expect } from "vitest";
import { isMarketOpen, isNseHoliday, istDateString, NSE_HOLIDAYS } from "../index.js";
import apiFixture from "./fixtures/api-nse-holidays.json";

/** Build a Date whose UTC time corresponds to IST dateStr at hh:mm (ported from apps/api tests). */
const makeIST = (dateStr: string, hhmm: string): Date => {
    const [h = 0, m = 0] = hhmm.split(":").map(Number);
    const istOffsetMs = 5.5 * 60 * 60 * 1000;
    const d = new Date(`${dateStr}T00:00:00.000Z`);
    d.setTime(d.getTime() + h * 3600000 + m * 60000 - istOffsetMs);
    return d;
};

describe("isMarketOpen (ported NSE session cases, parameterized — no fake timers needed)", () => {
    it("open on a weekday during market hours", () => {
        expect(isMarketOpen(makeIST("2026-07-07", "10:30"))).toBe(true); // Tuesday
    });
    it("closed before 09:15 and after 15:30 IST", () => {
        expect(isMarketOpen(makeIST("2026-07-07", "09:00"))).toBe(false);
        expect(isMarketOpen(makeIST("2026-07-07", "09:14"))).toBe(false);
        expect(isMarketOpen(makeIST("2026-07-07", "15:31"))).toBe(false);
    });
    it("boundary minutes are inclusive: exactly 09:15 and 15:30 are open", () => {
        expect(isMarketOpen(makeIST("2026-07-07", "09:15"))).toBe(true);
        expect(isMarketOpen(makeIST("2026-07-07", "15:30"))).toBe(true);
    });
    it("closed on weekends", () => {
        expect(isMarketOpen(makeIST("2026-07-11", "10:30"))).toBe(false); // Saturday
        expect(isMarketOpen(makeIST("2026-07-12", "10:30"))).toBe(false); // Sunday
    });
    it("closed on NSE holidays even mid-session", () => {
        expect(isMarketOpen(makeIST("2026-01-26", "10:30"))).toBe(false); // Republic Day (Monday)
        expect(isNseHoliday(makeIST("2026-12-25", "12:00"))).toBe(true);
    });
    it("IST date string is computed from IST wall clock, not server-local time", () => {
        // 20:00 UTC on Jan 25 is 01:30 IST on Jan 26 — must resolve to the 26th
        expect(istDateString(new Date("2026-01-25T20:00:00.000Z"))).toBe("2026-01-26");
        // and that instant is a holiday in IST even though it's the 25th in UTC
        expect(isNseHoliday(new Date("2026-01-25T20:00:00.000Z"))).toBe(true);
    });
});

describe("drift tripwire against apps/api", () => {
    it("kernel holiday set is identical to the live api's set (captured fixture)", () => {
        expect([...NSE_HOLIDAYS].sort()).toEqual(apiFixture.holidays);
    });
});
