import { describe, it, expect } from "vitest";
import { isMarketOpen, NSE_HOLIDAYS } from "@zentrade/kernel";
import { computeSeedPlan, nseCalendarSeedRows, isSessionOpenAt, NSE_SESSION } from "../index.js";

describe("computeSeedPlan", () => {
    const seed = (venue: string, symbol: string) => ({
        venue,
        symbol,
        name: symbol,
        assetClass: "equity",
        currency: "INR",
        tickSize: 0.05,
        lotSize: 1,
        metadata: {},
    });

    it("inserts only what is missing", () => {
        const plan = computeSeedPlan(
            [{ venue: "NSE", symbol: "TCS" }],
            [seed("NSE", "TCS"), seed("NSE", "INFY"), seed("BSE", "TCS")],
        );
        expect(plan.toInsert.map((s) => `${s.venue}:${s.symbol}`)).toEqual(["NSE:INFY", "BSE:TCS"]);
    });

    it("is empty when registry matches config (idempotency core)", () => {
        const existing = [
            { venue: "NSE", symbol: "TCS" },
            { venue: "NSE", symbol: "INFY" },
        ];
        expect(computeSeedPlan(existing, [seed("NSE", "TCS"), seed("NSE", "INFY")]).toInsert).toEqual([]);
    });

    it("same symbol on two venues is two instruments, duplicate config throws", () => {
        const plan = computeSeedPlan([], [seed("NSE", "TCS"), seed("BSE", "TCS")]);
        expect(plan.toInsert).toHaveLength(2);
        expect(() => computeSeedPlan([], [seed("NSE", "TCS"), seed("NSE", "TCS")])).toThrow(/duplicate/);
    });
});

describe("calendar seed rows", () => {
    it("one exception row per kernel holiday, holiday-flagged, sorted", () => {
        const rows = nseCalendarSeedRows();
        expect(rows).toHaveLength(NSE_HOLIDAYS.size);
        expect(rows.every((r) => r.isHoliday && r.venue === "NSE")).toBe(true);
        expect([...rows.map((r) => r.calDate)]).toEqual([...NSE_HOLIDAYS].sort());
    });
});

describe("isSessionOpenAt — differential vs kernel isMarketOpen, every day of 2026", () => {
    it("agrees with the kernel at open-1, open, midday, close, close+1 for all 365 days", () => {
        const rows = nseCalendarSeedRows();
        const probes = ["03:44", "03:45", "06:00", "10:00", "10:01"]; // UTC == 09:14/09:15/11:30/15:30/15:31 IST
        let checked = 0;
        for (let day = 0; day < 365; day++) {
            const base = new Date(Date.UTC(2026, 0, 1 + day));
            for (const probe of probes) {
                const [h = 0, m = 0] = probe.split(":").map(Number);
                const at = new Date(base.getTime() + (h * 60 + m) * 60_000);
                const domain = isSessionOpenAt(at, NSE_SESSION, rows);
                const kernel = isMarketOpen(at);
                if (domain !== kernel) {
                    throw new Error(`divergence at ${at.toISOString()}: domain=${domain} kernel=${kernel}`);
                }
                checked++;
            }
        }
        expect(checked).toBe(365 * 5);
    });

    it("special-session exception rows override defaults (Muhurat-style)", () => {
        // a Saturday with a special evening session 18:15-19:15 local
        const rows = [
            { venue: "NSE", calDate: "2026-11-07", isHoliday: false, sessionOpenMinute: 18 * 60 + 15, sessionCloseMinute: 19 * 60 + 15 },
        ];
        const during = new Date("2026-11-07T13:00:00.000Z"); // 18:30 IST — but Saturday stays closed by weekday rule
        expect(isSessionOpenAt(during, NSE_SESSION, rows)).toBe(false);
        // ...on a weekday exception it works
        const weekdayRows = [
            { venue: "NSE", calDate: "2026-11-09", isHoliday: false, sessionOpenMinute: 18 * 60 + 15, sessionCloseMinute: 19 * 60 + 15 },
        ];
        expect(isSessionOpenAt(new Date("2026-11-09T13:00:00.000Z"), NSE_SESSION, weekdayRows)).toBe(true);
        expect(isSessionOpenAt(new Date("2026-11-09T05:00:00.000Z"), NSE_SESSION, weekdayRows)).toBe(false);
    });
});
