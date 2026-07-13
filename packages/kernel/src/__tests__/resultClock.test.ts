import { describe, it, expect } from "vitest";
import { ok, err, isOk, isErr, map, mapErr, andThen, unwrapOr, fixedClock, systemClock } from "../index.js";

describe("Result", () => {
    it("constructors and guards discriminate correctly", () => {
        const good = ok(42);
        const bad = err("nope");
        expect(isOk(good) && good.value).toBe(42);
        expect(isErr(bad) && bad.error).toBe("nope");
        expect(isOk(bad)).toBe(false);
    });

    it("map/andThen transform success and pass errors through untouched", () => {
        expect(map(ok(2), (n) => n * 3)).toEqual(ok(6));
        expect(map(err("e"), (n: number) => n * 3)).toEqual(err("e"));
        expect(andThen(ok(2), (n) => (n > 1 ? ok(n) : err("small")))).toEqual(ok(2));
        expect(andThen(ok(0), (n) => (n > 1 ? ok(n) : err("small")))).toEqual(err("small"));
        expect(mapErr(err("e"), (e) => `${e}!`)).toEqual(err("e!"));
    });

    it("unwrapOr falls back only on error", () => {
        expect(unwrapOr(ok(1), 9)).toBe(1);
        expect(unwrapOr(err("x"), 9)).toBe(9);
    });
});

describe("Clock", () => {
    it("fixedClock always returns the pinned instant and is immune to mutation", () => {
        const clock = fixedClock("2026-07-13T10:00:00.000Z");
        const a = clock.now();
        a.setFullYear(1999); // mutate the returned Date
        expect(clock.now().toISOString()).toBe("2026-07-13T10:00:00.000Z");
    });

    it("systemClock tracks real time", () => {
        const before = Date.now();
        const t = systemClock.now().getTime();
        expect(t).toBeGreaterThanOrEqual(before);
        expect(t).toBeLessThanOrEqual(Date.now());
    });
});
