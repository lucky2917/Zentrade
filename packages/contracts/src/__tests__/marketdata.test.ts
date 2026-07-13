import { describe, it, expect } from "vitest";
import { MarketTick, Candle, CandleResolution } from "../index.js";
import fixtures from "./fixtures/sanitised-ticks.json";

describe("MarketTick", () => {
    it("parses a real equity tick from the SmartWall sanitizer unmodified", () => {
        const parsed = MarketTick.parse(fixtures.stock);
        expect(parsed).toEqual(fixtures.stock);
    });

    it("parses a real index tick (no session block) unmodified", () => {
        const parsed = MarketTick.parse(fixtures.index);
        expect(parsed).toEqual(fixtures.index);
    });

    it("rejects unknown keys (anti-corruption: vendor fields must not leak through)", () => {
        expect(MarketTick.safeParse({ ...fixtures.stock, fyers_internal: 1 }).success).toBe(false);
    });

    it("rejects non-positive prices and missing symbol", () => {
        expect(MarketTick.safeParse({ ...fixtures.stock, price: 0 }).success).toBe(false);
        expect(MarketTick.safeParse({ ...fixtures.stock, price: -5 }).success).toBe(false);
        const { symbol: _symbol, ...noSymbol } = fixtures.stock;
        expect(MarketTick.safeParse(noSymbol).success).toBe(false);
    });

    it("rejects non-integer or non-positive timestamps", () => {
        expect(MarketTick.safeParse({ ...fixtures.stock, timestamp: 1.5 }).success).toBe(false);
        expect(MarketTick.safeParse({ ...fixtures.stock, timestamp: 0 }).success).toBe(false);
    });
});

describe("Candle", () => {
    const good = { time: 1783900800, open: 100, high: 105.5, low: 99.25, close: 104, volume: 12345 };

    it("parses a well-formed bar", () => {
        expect(Candle.parse(good)).toEqual(good);
    });

    it("rejects high < low (dirty vendor row dies at the boundary)", () => {
        expect(Candle.safeParse({ ...good, high: 98 }).success).toBe(false);
    });

    it("rejects unknown keys, zero prices and negative volume", () => {
        expect(Candle.safeParse({ ...good, vendorFlag: true }).success).toBe(false);
        expect(Candle.safeParse({ ...good, close: 0 }).success).toBe(false);
        expect(Candle.safeParse({ ...good, volume: -1 }).success).toBe(false);
    });

    it("resolution vocabulary is the canonical set", () => {
        expect(CandleResolution.options).toEqual(["1m", "5m", "15m", "30m", "60m", "1d", "1w", "1mo"]);
    });
});
