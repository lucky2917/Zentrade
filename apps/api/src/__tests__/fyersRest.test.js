import { describe, it, expect, vi } from "vitest";

vi.mock("../config/redis.js", () => ({
    default: { get: async () => null, set: async () => "OK", del: async () => 0,
               incr: async () => 1, quit: async () => "OK" },
}));
vi.mock("fyers-api-v3", () => ({
    fyersModel: class { setAppId() {} setRedirectUrl() {} setAccessToken() {} },
    fyersDataSocket: { getInstance: () => ({ on() {}, connect() {}, close() {} }) },
}));

const { formatDate, CHUNK_LIMIT_DAYS } = await import("../services/fyers/fyersREST.js");

const IST = "+05:30";

describe("fyers date formatting", () => {
    it("keeps the IST trading date for a market-hours instant", () => {
        expect(formatDate(new Date(`2024-03-01T09:15:00${IST}`))).toBe("2024-03-01");
        expect(formatDate(new Date(`2024-03-01T15:30:00${IST}`))).toBe("2024-03-01");
    });

    it("does not shift the date in the 00:00-05:30 IST band", () => {
        // toISOString() is UTC, so these formatted to the previous day and
        // silently moved every requested window back one session. The 03:31
        // IST budget reset sits inside this band.
        expect(formatDate(new Date(`2024-03-01T00:01:00${IST}`))).toBe("2024-03-01");
        expect(formatDate(new Date(`2024-03-01T02:00:00${IST}`))).toBe("2024-03-01");
        expect(formatDate(new Date(`2024-03-01T05:29:00${IST}`))).toBe("2024-03-01");
    });

    it("does not shift the date late in the IST evening", () => {
        expect(formatDate(new Date(`2024-03-01T23:59:00${IST}`))).toBe("2024-03-01");
    });

    it("handles a month boundary in both directions", () => {
        expect(formatDate(new Date(`2024-03-01T00:30:00${IST}`))).toBe("2024-03-01");
        expect(formatDate(new Date(`2024-02-29T23:30:00${IST}`))).toBe("2024-02-29");
    });

    it("handles a leap day", () => {
        expect(formatDate(new Date(`2024-02-29T04:00:00${IST}`))).toBe("2024-02-29");
    });

    it("is stable across a UTC day boundary", () => {
        // 18:30 UTC is 00:00 IST the next day
        expect(formatDate(new Date("2024-03-01T18:30:00Z"))).toBe("2024-03-02");
        expect(formatDate(new Date("2024-03-01T18:29:00Z"))).toBe("2024-03-01");
    });
});

describe("chunk limits are an adapter constant", () => {
    it("declares 100 days for every intraday resolution", () => {
        for (const resolution of ["1", "5", "15", "30", "60", "240"]) {
            expect(CHUNK_LIMIT_DAYS[resolution]).toBe(100);
        }
    });

    it("declares 366 days for daily and coarser", () => {
        for (const resolution of ["D", "1W", "1M"]) {
            expect(CHUNK_LIMIT_DAYS[resolution]).toBe(366);
        }
    });

    it("is a local assumption, not a measured provider ceiling", () => {
        // Recorded so nobody later reads these numbers as documented Fyers
        // limits. The depth probe tests whether the provider agrees.
        expect(Object.values(CHUNK_LIMIT_DAYS).every((v) => Number.isInteger(v))).toBe(true);
    });
});
