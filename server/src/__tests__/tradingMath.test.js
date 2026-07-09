import { describe, it, expect } from "vitest";

// Pure math extracted from tradingEngine.js — tested without a database.

const BROKERAGE_PAISE = 2000;
const BUY_SPREAD = 1.001;
const SELL_SPREAD = 0.999;
const INTRADAY_LEVERAGE = 5;

// Mirrors executeBuy margin calculation (M6 fix: brokerage outside leverage)
const calcBuyMargin = (price, qty, isIntraday) => {
    const executionPricePaise = Math.round(price * BUY_SPREAD * 100);
    const stockCostPaise = executionPricePaise * qty;
    return isIntraday
        ? Math.ceil(stockCostPaise / INTRADAY_LEVERAGE) + BROKERAGE_PAISE
        : stockCostPaise + BROKERAGE_PAISE;
};

// Mirrors executeSell credit calculation
const calcSellCredit = (price, qty, avgPricePaise, marginUsedPaise, isIntraday) => {
    const executionPricePaise = Math.round(price * SELL_SPREAD * 100);
    const grossProceedsPaise = executionPricePaise * qty;
    const pnlPaise = (executionPricePaise - avgPricePaise) * qty;
    if (isIntraday) {
        return marginUsedPaise + pnlPaise - BROKERAGE_PAISE;
    }
    return grossProceedsPaise - BROKERAGE_PAISE;
};

// Mirrors weighted-average portfolio upsert (used in ON CONFLICT DO UPDATE)
const weightedAvg = (oldQty, oldAvg, newQty, newAvg) =>
    Math.round((oldQty * oldAvg + newQty * newAvg) / (oldQty + newQty));

describe("Buy margin calculation (M6)", () => {
    it("intraday: brokerage charged in full, not split by leverage", () => {
        const margin = calcBuyMargin(100, 10, true);
        const stockCost = Math.round(100 * BUY_SPREAD * 100) * 10;
        expect(margin).toBe(Math.ceil(stockCost / 5) + BROKERAGE_PAISE);
    });

    it("delivery: full cost + brokerage", () => {
        const margin = calcBuyMargin(100, 10, false);
        const stockCost = Math.round(100 * BUY_SPREAD * 100) * 10;
        expect(margin).toBe(stockCost + BROKERAGE_PAISE);
    });

    it("intraday margin is ~20% of stock cost (5x leverage)", () => {
        const stockCostPaise = Math.round(1000 * BUY_SPREAD * 100) * 1;
        const margin = calcBuyMargin(1000, 1, true);
        // margin should be roughly stockCost/5 + brokerage
        expect(margin).toBeCloseTo(stockCostPaise / 5 + BROKERAGE_PAISE, -1);
    });
});

describe("Sell credit calculation (H1)", () => {
    it("intraday profit: credit exceeds margin posted", () => {
        // buy 10 shares at ₹100, sell at ₹110
        const avgPricePaise = Math.round(100 * BUY_SPREAD * 100);
        const marginUsedPaise = Math.ceil((avgPricePaise * 10) / 5) + BROKERAGE_PAISE;
        const credit = calcSellCredit(110, 10, avgPricePaise, marginUsedPaise, true);
        expect(credit).toBeGreaterThan(marginUsedPaise);
    });

    it("intraday deep loss: credit is negative (H1 fix — no longer floored to 0)", () => {
        // buy 10 at ₹100, sell at ₹50 — margin can't cover the loss
        const avgPricePaise = Math.round(100 * BUY_SPREAD * 100);
        const marginUsedPaise = Math.ceil((avgPricePaise * 10) / 5) + BROKERAGE_PAISE;
        const credit = calcSellCredit(50, 10, avgPricePaise, marginUsedPaise, true);
        expect(credit).toBeLessThan(0);
    });

    it("delivery: gross proceeds minus brokerage", () => {
        const credit = calcSellCredit(200, 5, 18000, 0, false);
        const executionPricePaise = Math.round(200 * SELL_SPREAD * 100);
        expect(credit).toBe(executionPricePaise * 5 - BROKERAGE_PAISE);
    });
});

describe("Weighted average (H2 ON CONFLICT math)", () => {
    it("simple average when quantities are equal", () => {
        expect(weightedAvg(5, 100, 5, 200)).toBe(150);
    });

    it("weighted toward larger position", () => {
        const avg = weightedAvg(10, 100, 2, 200);
        // (10*100 + 2*200) / 12 = 1400/12 = 116.67 → rounds to 117
        expect(avg).toBe(117);
    });

    it("unchanged when adding at same price", () => {
        expect(weightedAvg(10, 150, 5, 150)).toBe(150);
    });
});

describe("PnL calculation (H3)", () => {
    it("profitable intraday sell PnL", () => {
        const executionPricePaise = Math.round(110 * SELL_SPREAD * 100);
        const avgPricePaise = 10050; // bought at ₹100.50
        const qty = 10;
        const pnl = (executionPricePaise - avgPricePaise) * qty;
        expect(pnl).toBeGreaterThan(0);
    });

    it("losing delivery sell PnL is negative", () => {
        const executionPricePaise = Math.round(80 * SELL_SPREAD * 100);
        const avgPricePaise = 10050;
        const qty = 5;
        const pnl = (executionPricePaise - avgPricePaise) * qty;
        expect(pnl).toBeLessThan(0);
    });
});
