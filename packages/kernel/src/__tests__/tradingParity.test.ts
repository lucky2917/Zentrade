import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { Money } from "../index.js";

/**
 * Bit-parity proof (roadmap M3 verify): Money reproduces the trading engine's
 * paise arithmetic exactly. The "expected" side below re-states the live
 * formulas from apps/api tradingEngine.js in plain JS numbers; the "actual"
 * side computes the same with Money. They must agree to the paise — including
 * on the production trade verified during M1.
 */

const BROKERAGE_PAISE = 2000;
const INTRADAY_LEVERAGE = 5;

const engineBuyNumbers = (executionPricePaise: number, quantity: number, intraday: boolean) => {
    const stockCostPaise = executionPricePaise * quantity;
    const marginRequired = intraday
        ? Math.ceil(stockCostPaise / INTRADAY_LEVERAGE) + BROKERAGE_PAISE
        : stockCostPaise + BROKERAGE_PAISE;
    return { stockCostPaise, marginRequired };
};

const engineBuyMoney = (executionPricePaise: number, quantity: number, intraday: boolean) => {
    const execution = Money.fromMinor(executionPricePaise, "INR");
    const brokerage = Money.fromMinor(BROKERAGE_PAISE, "INR");
    const stockCost = execution.multiply(quantity);
    const margin = intraday
        ? stockCost.divide(INTRADAY_LEVERAGE, "CEIL").add(brokerage)
        : stockCost.add(brokerage);
    return { stockCost, margin };
};

describe("trading-engine parity", () => {
    it("reproduces the M1 production trade to the paise (price 1500, qty 5)", () => {
        // Verified live in M1: exec 150150, cost 750750, DELIVERY debit 752750
        const executionPricePaise = 150150;
        const delivery = engineBuyMoney(executionPricePaise, 5, false);
        expect(delivery.stockCost.toMinorNumber()).toBe(750750);
        expect(delivery.margin.toMinorNumber()).toBe(752750);

        const intraday = engineBuyMoney(executionPricePaise, 5, true);
        expect(intraday.margin.toMinorNumber()).toBe(Math.ceil(750750 / 5) + 2000); // 152150
    });

    it("BUY margin matches the number formulas across the whole trade space", () => {
        fc.assert(
            fc.property(
                fc.integer({ min: 1, max: 10_000_000 }), // exec price in paise (up to ₹1L/share)
                fc.integer({ min: 1, max: 10_000 }), // MAX_QUANTITY
                fc.boolean(),
                (price, qty, intraday) => {
                    const expected = engineBuyNumbers(price, qty, intraday);
                    const actual = engineBuyMoney(price, qty, intraday);
                    expect(actual.stockCost.toMinorNumber()).toBe(expected.stockCostPaise);
                    expect(actual.margin.toMinorNumber()).toBe(expected.marginRequired);
                },
            ),
            { numRuns: 2_000 },
        );
    });

    it("SELL credit and realized PnL match (delivery: gross - brokerage; pnl exact)", () => {
        fc.assert(
            fc.property(
                fc.integer({ min: 1, max: 10_000_000 }), // sell exec paise
                fc.integer({ min: 1, max: 10_000_000 }), // avg buy paise
                fc.integer({ min: 1, max: 10_000 }),
                (sellPrice, avgPrice, qty) => {
                    // engine: pnl = (exec - avg) * qty ; credit = exec*qty - brokerage
                    const expectedPnl = (sellPrice - avgPrice) * qty;
                    const expectedCredit = sellPrice * qty - BROKERAGE_PAISE;

                    const pnl = Money.fromMinor(sellPrice, "INR")
                        .subtract(Money.fromMinor(avgPrice, "INR"))
                        .multiply(qty);
                    const credit = Money.fromMinor(sellPrice, "INR")
                        .multiply(qty)
                        .subtract(Money.fromMinor(BROKERAGE_PAISE, "INR"));

                    expect(pnl.toMinorNumber()).toBe(expectedPnl);
                    expect(credit.toMinorNumber()).toBe(expectedCredit);
                },
            ),
            { numRuns: 2_000 },
        );
    });

    it("negative credits flow through (leveraged losses reduce balance, by design)", () => {
        const credit = Money.fromMinor(100_000, "INR") // margin returned
            .add(Money.fromMinor(-150_000, "INR")) // losing pnl
            .subtract(Money.fromMinor(BROKERAGE_PAISE, "INR"));
        expect(credit.toMinorNumber()).toBe(-52_000);
        expect(credit.isNegative()).toBe(true);
    });

    it("0.1% spread as an exact ratio matches the engine's rounded float within its own convention", () => {
        // engine: Math.round(price * 1.001 * 100) on float rupees.
        // Money expresses it exactly: paise * 1001 / 1000, HALF_UP.
        // For the production fixture both agree:
        const ltpPaise = 150_000; // ₹1500.00
        const viaMoney = Money.fromMinor(ltpPaise, "INR").applyRatio(1001, 1000, "HALF_UP");
        expect(viaMoney.toMinorNumber()).toBe(150150);
        expect(Math.round(1500 * 1.001 * 100)).toBe(150150);
    });
});
