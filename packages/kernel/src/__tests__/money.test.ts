import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { Money, CurrencyMismatchError, MoneyRangeError, roundDiv, CURRENCY_SCALES } from "../index.js";

const minorArb = fc.bigInt({ min: -(2n ** 62n), max: 2n ** 62n });
const inr = (n: bigint | number) => Money.fromMinor(n, "INR");

describe("Money — construction", () => {
    it("fromMinor accepts safe integers and bigints, rejects floats and unsafe numbers", () => {
        expect(inr(2000).minor).toBe(2000n);
        expect(Money.fromMinor(-5n, "INR").minor).toBe(-5n);
        expect(() => Money.fromMinor(1.5, "INR")).toThrow(MoneyRangeError);
        expect(() => Money.fromMinor(Number.MAX_SAFE_INTEGER + 2, "INR")).toThrow(MoneyRangeError);
    });

    it("fromDecimalString parses major units exactly per currency scale", () => {
        expect(Money.fromDecimalString("1500.50", "INR").minor).toBe(150050n);
        expect(Money.fromDecimalString("-0.01", "INR").minor).toBe(-1n);
        expect(Money.fromDecimalString("42", "JPY").minor).toBe(42n);
        expect(Money.fromDecimalString("0.00000001", "BTC").minor).toBe(1n);
        expect(() => Money.fromDecimalString("1.234", "INR")).toThrow(MoneyRangeError); // 3dp > scale 2
        expect(() => Money.fromDecimalString("1.5", "JPY")).toThrow(MoneyRangeError);
        expect(() => Money.fromDecimalString("1,500", "INR")).toThrow(MoneyRangeError);
        expect(() => Money.fromDecimalString("1e5", "INR")).toThrow(MoneyRangeError);
    });

    it("decimal string round-trips for every currency scale", () => {
        fc.assert(
            fc.property(minorArb, fc.constantFrom(...(Object.keys(CURRENCY_SCALES) as ("INR" | "JPY" | "BTC")[])), (m, ccy) => {
                const money = Money.fromMinor(m, ccy);
                const back = Money.fromDecimalString(money.toDecimalString(), ccy);
                expect(back.minor).toBe(m);
            }),
        );
    });
});

describe("Money — algebraic properties (no float ever leaks)", () => {
    it("addition is commutative and associative; subtract inverts add", () => {
        fc.assert(
            fc.property(minorArb, minorArb, minorArb, (a, b, c) => {
                const [A, B, C] = [inr(a), inr(b), inr(c)];
                expect(A.add(B).minor).toBe(B.add(A).minor);
                expect(A.add(B).add(C).minor).toBe(A.add(B.add(C)).minor);
                expect(A.add(B).subtract(B).minor).toBe(A.minor);
            }),
        );
    });

    it("multiply distributes over add; multiply by quantity equals repeated add", () => {
        fc.assert(
            fc.property(minorArb, minorArb, fc.integer({ min: 0, max: 200 }), (a, b, q) => {
                expect(inr(a).add(inr(b)).multiply(q).minor).toBe(inr(a).multiply(q).add(inr(b).multiply(q)).minor);
                let sum = Money.zero("INR");
                for (let i = 0; i < q; i++) sum = sum.add(inr(a));
                expect(inr(a).multiply(q).minor).toBe(sum.minor);
            }),
        );
    });

    it("cross-currency arithmetic always throws", () => {
        const usd = Money.fromMinor(100, "USD");
        expect(() => inr(100).add(usd)).toThrow(CurrencyMismatchError);
        expect(() => inr(100).subtract(usd)).toThrow(CurrencyMismatchError);
        expect(() => inr(100).compare(usd)).toThrow(CurrencyMismatchError);
        expect(inr(100).equals(usd)).toBe(false); // equals answers, never throws
    });

    it("results are always exact integers (the no-float invariant, by construction)", () => {
        fc.assert(
            fc.property(minorArb, fc.integer({ min: 1, max: 10_000 }), (a, d) => {
                const divided = inr(a).divide(d, "FLOOR");
                expect(typeof divided.minor).toBe("bigint");
                // FLOOR then *d never overshoots the original
                expect(divided.minor * BigInt(d) <= a).toBe(true);
            }),
        );
    });
});

describe("roundDiv — rounding-mode semantics", () => {
    it("matches Math.ceil / Math.floor / half-away-from-zero on a dense grid", () => {
        fc.assert(
            fc.property(fc.integer({ min: -100_000, max: 100_000 }), fc.integer({ min: 1, max: 500 }), (n, d) => {
                const exact = n / d;
                expect(roundDiv(BigInt(n), BigInt(d), "CEIL")).toBe(BigInt(Math.ceil(exact)));
                expect(roundDiv(BigInt(n), BigInt(d), "FLOOR")).toBe(BigInt(Math.floor(exact)));
                const halfUp = n >= 0 ? Math.floor(exact + 0.5) : -Math.floor(-exact + 0.5);
                expect(roundDiv(BigInt(n), BigInt(d), "HALF_UP")).toBe(BigInt(halfUp));
            }),
        );
    });

    it("CEIL >= exact >= FLOOR, differing by at most 1", () => {
        fc.assert(
            fc.property(minorArb, fc.bigInt({ min: 1n, max: 10_000n }), (n, d) => {
                const ceil = roundDiv(n, d, "CEIL");
                const floor = roundDiv(n, d, "FLOOR");
                expect(ceil - floor === 0n || ceil - floor === 1n).toBe(true);
                expect(ceil * d >= n).toBe(true);
                expect(floor * d <= n).toBe(true);
            }),
        );
    });

    it("negative denominators normalise; zero denominator throws", () => {
        expect(roundDiv(7n, -2n, "FLOOR")).toBe(-4n);
        expect(roundDiv(7n, -2n, "CEIL")).toBe(-3n);
        expect(() => roundDiv(1n, 0n, "CEIL")).toThrow(MoneyRangeError);
    });
});

describe("Money — presentation and range", () => {
    it("formats negatives, zero-scale and high-scale currencies", () => {
        expect(inr(-150050).toString()).toBe("INR -1500.50");
        expect(Money.fromMinor(42n, "JPY").toString()).toBe("JPY 42");
        expect(Money.fromMinor(1n, "BTC").toString()).toBe("BTC 0.00000001");
        expect(Money.zero("INR").toDecimalString()).toBe("0.00");
    });

    it("toMinorNumber throws beyond the safe range, toJSON never does", () => {
        const huge = Money.fromMinor(2n ** 60n, "INR");
        expect(() => huge.toMinorNumber()).toThrow(MoneyRangeError);
        expect(huge.toJSON()).toEqual({ currency: "INR", minor: (2n ** 60n).toString() });
        expect(inr(2000).toMinorNumber()).toBe(2000);
    });

    it("instances are frozen (immutability is structural)", () => {
        const m = inr(100);
        expect(Object.isFrozen(m)).toBe(true);
    });
});
