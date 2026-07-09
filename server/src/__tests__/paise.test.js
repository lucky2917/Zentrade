import { describe, it, expect } from "vitest";
import { toPaise, toRupees } from "../utils/paise.js";

describe("paise conversion", () => {
    it("converts rupees to integer paise with rounding", () => {
        expect(toPaise(100)).toBe(10000);
        expect(toPaise(1748.55)).toBe(174855);
        // classic float trap: 0.1 + 0.2
        expect(toPaise(0.1 + 0.2)).toBe(30);
    });

    it("round-trips paise to rupees", () => {
        expect(toRupees(174855)).toBe(1748.55);
        expect(toRupees(toPaise(99.99))).toBe(99.99);
    });
});
