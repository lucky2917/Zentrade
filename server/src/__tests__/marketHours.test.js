import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { isMarketOpen, NSE_HOLIDAYS } from "../utils/marketHours.js";

const makeIST = (dateStr, hhmm) => {
    // Build a Date whose UTC time corresponds to IST dateStr at hhmm
    const [h, m] = hhmm.split(":").map(Number);
    const istOffsetMs = 5.5 * 60 * 60 * 1000;
    const d = new Date(`${dateStr}T00:00:00.000Z`);
    d.setTime(d.getTime() + h * 3600000 + m * 60000 - istOffsetMs);
    return d;
};

describe("isMarketOpen", () => {
    afterEach(() => vi.useRealTimers());

    it("returns true on a weekday during market hours", () => {
        // 2026-07-07 is a Tuesday
        vi.setSystemTime(makeIST("2026-07-07", "10:30"));
        expect(isMarketOpen()).toBe(true);
    });

    it("returns false before 09:15 IST", () => {
        vi.setSystemTime(makeIST("2026-07-07", "09:00"));
        expect(isMarketOpen()).toBe(false);
    });

    it("returns false after 15:30 IST", () => {
        vi.setSystemTime(makeIST("2026-07-07", "15:31"));
        expect(isMarketOpen()).toBe(false);
    });

    it("returns true at exactly 09:15 IST", () => {
        vi.setSystemTime(makeIST("2026-07-07", "09:15"));
        expect(isMarketOpen()).toBe(true);
    });

    it("returns true at exactly 15:30 IST", () => {
        vi.setSystemTime(makeIST("2026-07-07", "15:30"));
        expect(isMarketOpen()).toBe(true);
    });

    it("returns false on Saturday", () => {
        // 2026-07-04 is a Saturday
        vi.setSystemTime(makeIST("2026-07-04", "11:00"));
        expect(isMarketOpen()).toBe(false);
    });

    it("returns false on Sunday", () => {
        vi.setSystemTime(makeIST("2026-07-05", "11:00"));
        expect(isMarketOpen()).toBe(false);
    });

    it("returns false on NSE holiday (Republic Day 2026-01-26)", () => {
        vi.setSystemTime(makeIST("2026-01-26", "11:00"));
        expect(isMarketOpen()).toBe(false);
    });

    it("returns false on Christmas 2026", () => {
        vi.setSystemTime(makeIST("2026-12-25", "11:00"));
        expect(isMarketOpen()).toBe(false);
    });
});

describe("NSE_HOLIDAYS", () => {
    it("contains Republic Day for 2025 and 2026", () => {
        expect(NSE_HOLIDAYS.has("2025-01-26")).toBe(true);
        expect(NSE_HOLIDAYS.has("2026-01-26")).toBe(true);
    });

    it("does not contain a regular weekday", () => {
        expect(NSE_HOLIDAYS.has("2026-07-07")).toBe(false);
    });
});
