import { pool } from "../config/db.js";
import redis from "../config/redis.js";
import { TRADE_EXECUTED } from "@zentrade/contracts";
import { enqueueEvent } from "./eventBackbone.js";
import { instrumentResolver } from "./referenceData.js";
import { toPaise } from "../utils/paise.js";
import { STOCK_MAP } from "../config/stocks.js";
import { isMarketOpen } from "../utils/marketHours.js";
import logger from "../utils/logger.js";
import {
    lockCash, applyCashDelta, readPositionForUpdate, addToPosition, reducePosition,
    insertCompletedOrder,
} from "./execution/bookkeeper.js";
// The money model lives in one module. These were redeclared here with the same
// values, which is a second definition waiting to drift from the first.
import {
    BROKERAGE_PAISE, BUY_SPREAD, SELL_SPREAD, remainingMarginPaise,
} from "./execution/ledger.js";

const MAX_QUANTITY = 10000;
const MAX_PRICE_AGE_MS = 15000;
const MAX_DELIVERY_PRICE_AGE_MS = 30 * 60 * 1000;
const MAX_CLOSED_DELIVERY_AGE_MS = 8 * 60 * 60 * 1000;
const INTRADAY_LEVERAGE = 5;

const validatePriceData = (priceData, symbol, mode = "INTRADAY") => {
    if (!priceData) {
        throw new Error("Price not available for " + symbol);
    }

    const parsed = JSON.parse(priceData);
    if (!parsed.price || !parsed.timestamp) {
        throw new Error("Invalid price data for " + symbol);
    }

    const age = Date.now() - parsed.timestamp;
    if (isMarketOpen()) {
        const maxAge = mode === "INTRADAY" ? MAX_PRICE_AGE_MS : MAX_DELIVERY_PRICE_AGE_MS;
        if (age > maxAge) throw new Error("Price data is stale. Please try again.");
    } else if (mode === "DELIVERY" && age > MAX_CLOSED_DELIVERY_AGE_MS) {
        throw new Error("Price data is stale. Please try again.");
    }

    return parsed;
};

/**
 * M9: announce a settled trade on the backbone, inside the engine's own
 * transaction. instrumentId is resolved best-effort (nullable in payload);
 * the ORDER ROW is the source of truth, the event is the announcement.
 */
const enqueueTradeExecuted = async (client, { orderId, symbol, side, quantity, executionPricePaise, mode, decisionId, pnlPaise = null }) => {
    const instrument = await instrumentResolver.bySymbol("NSE", symbol).catch(() => null);
    await enqueueEvent(
        {
            type: TRADE_EXECUTED.type,
            v: TRADE_EXECUTED.v,
            payload: {
                orderId,
                venue: "NSE",
                symbol,
                instrumentId: instrument?.instrumentId ?? null,
                side,
                quantity,
                executionPriceMinor: executionPricePaise,
                mode,
                decisionId,
                pnlMinor: pnlPaise,
            },
        },
        client
    );
};

const executeBuy = async (userId, symbol, quantity, mode = "INTRADAY", decisionId = null,
                          { clientOrderId = null, correlationId = null } = {}) => {
    if (!STOCK_MAP.has(symbol)) {
        throw new Error("Invalid stock symbol");
    }

    if (!Number.isInteger(quantity) || quantity <= 0) {
        throw new Error("Quantity must be a positive integer");
    }

    if (quantity > MAX_QUANTITY) {
        throw new Error("Maximum order quantity is " + MAX_QUANTITY);
    }

    if (mode !== "INTRADAY" && mode !== "DELIVERY") {
        throw new Error("Invalid order mode. Use INTRADAY or DELIVERY.");
    }

    const priceData = await redis.get(`stock:${symbol}`);
    const { price } = validatePriceData(priceData, symbol, mode);

    const executionPricePaise = Math.round(price * BUY_SPREAD * 100);
    const stockCostPaise = executionPricePaise * quantity;

    const isIntraday = mode === "INTRADAY";
    // M6 fix: brokerage charged in full, not split across leverage
    const marginRequired = isIntraday
        ? Math.ceil(stockCostPaise / INTRADAY_LEVERAGE) + BROKERAGE_PAISE
        : stockCostPaise + BROKERAGE_PAISE;

    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        // Lock user row first — establishes consistent lock order: users → portfolio
        const userResult = await lockCash(client, userId);

        if (userResult.rows.length === 0) {
            throw new Error("User not found");
        }

        const balancePaise = Number(userResult.rows[0].balance_paise);
        if (balancePaise < marginRequired) {
            throw new Error(
                isIntraday
                    ? `Insufficient margin. Need ₹${(marginRequired / 100).toFixed(2)} (5x leverage + brokerage)`
                    : "Insufficient balance"
            );
        }

        await applyCashDelta(client, userId, -marginRequired);

        // Atomic upsert: two concurrent first buys on one symbol would both see
        // no row and both insert.
        await addToPosition(client, {
            userId, symbol, mode, quantity,
            pricePaise: executionPricePaise, marginPaise: marginRequired,
        });

        // total_value_paise is gross stock cost; brokerage is separate.
        const order = await insertCompletedOrder(client, {
            userId, symbol, side: "BUY", quantity, pricePaise: executionPricePaise,
            totalValuePaise: stockCostPaise, brokeragePaise: BROKERAGE_PAISE, mode,
            decisionId, clientOrderId, correlationId,
        });

        await enqueueTradeExecuted(client, { orderId: order.id, symbol, side: "BUY", quantity, executionPricePaise, mode, decisionId });

        await client.query("COMMIT");

        logger.trade("TradingEngine", "BUY executed", {
            userId,
            symbol,
            quantity,
            mode,
            executionPrice: executionPricePaise / 100,
            ltp: price,
            spread: "0.1%",
            brokerage: "₹20",
            leverage: isIntraday ? "5x" : "1x",
            marginUsed: marginRequired / 100,
            stockCost: stockCostPaise / 100,
        });

        return {
            type: "BUY",
            symbol,
            quantity,
            mode,
            ltpPaise: toPaise(price),
            executionPricePaise,
            brokeragePaise: BROKERAGE_PAISE,
            stockCostPaise,
            marginRequiredPaise: marginRequired,
            leverage: isIntraday ? INTRADAY_LEVERAGE : 1,
        };
    } catch (err) {
        await client.query("ROLLBACK");
        throw err;
    } finally {
        client.release();
    }
};

const executeSell = async (userId, symbol, quantity, mode = "INTRADAY", decisionId = null,
                           { clientOrderId = null, correlationId = null } = {}) => {
    if (!STOCK_MAP.has(symbol)) {
        throw new Error("Invalid stock symbol");
    }

    if (!Number.isInteger(quantity) || quantity <= 0) {
        throw new Error("Quantity must be a positive integer");
    }

    if (quantity > MAX_QUANTITY) {
        throw new Error("Maximum order quantity is " + MAX_QUANTITY);
    }

    if (mode !== "INTRADAY" && mode !== "DELIVERY") {
        throw new Error("Invalid order mode. Use INTRADAY or DELIVERY.");
    }

    const priceData = await redis.get(`stock:${symbol}`);
    const { price } = validatePriceData(priceData, symbol, mode);

    const executionPricePaise = Math.round(price * SELL_SPREAD * 100);
    const grossProceedsPaise = executionPricePaise * quantity;
    const isIntraday = mode === "INTRADAY";

    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        // C2 fix: lock user row FIRST to match executeBuy's lock order (users → portfolio)
        const userLock = await client.query(
            "SELECT id FROM users WHERE id = $1 FOR UPDATE",
            [userId]
        );
        if (userLock.rows.length === 0) {
            throw new Error("User not found");
        }

        const holding = await readPositionForUpdate(client, { userId, symbol, mode });

        if (!holding || holding.quantity < quantity) {
            throw new Error("Insufficient holdings");
        }

        const holdingQty = holding.quantity;
        const avgPricePaise = holding.avgPricePaise;
        const totalMarginPaise = holding.marginUsedPaise;

        // H3: pnlPaise = realized profit/loss on the units sold
        const pnlPaise = (executionPricePaise - avgPricePaise) * quantity;

        let creditPaise;
        if (isIntraday) {
            const marginForSold = Math.round((quantity / holdingQty) * totalMarginPaise);
            creditPaise = marginForSold + pnlPaise - BROKERAGE_PAISE;
        } else {
            creditPaise = grossProceedsPaise - BROKERAGE_PAISE;
        }

        if (!isIntraday && creditPaise <= 0) {
            throw new Error("Trade value too small to cover brokerage");
        }

        // H1 fix: allow negative credit to flow through — balance can go negative
        // so leveraged losses are actually felt, not silently forgiven.
        // executeBuy already blocks new trades when balance < marginRequired.
        await applyCashDelta(client, userId, creditPaise);

        await reducePosition(client, {
            userId, symbol, mode, quantity, heldQuantity: holdingQty,
            remainingMarginPaise: remainingMarginPaise({
                quantity, heldQuantity: holdingQty, marginUsedPaise: totalMarginPaise }),
        });

        // total_value_paise is gross proceeds; pnl_paise is realised P&L.
        const order = await insertCompletedOrder(client, {
            userId, symbol, side: "SELL", quantity, pricePaise: executionPricePaise,
            totalValuePaise: grossProceedsPaise, brokeragePaise: BROKERAGE_PAISE, mode,
            pnlPaise, decisionId, clientOrderId, correlationId,
        });

        await enqueueTradeExecuted(client, { orderId: order.id, symbol, side: "SELL", quantity, executionPricePaise, mode, decisionId, pnlPaise });

        await client.query("COMMIT");

        logger.trade("TradingEngine", "SELL executed", {
            userId,
            symbol,
            quantity,
            mode,
            executionPrice: executionPricePaise / 100,
            ltp: price,
            spread: "0.1%",
            brokerage: "₹20",
            leverage: isIntraday ? "5x" : "1x",
            credited: creditPaise / 100,
            pnl: pnlPaise / 100,
        });

        return {
            type: "SELL",
            symbol,
            quantity,
            mode,
            ltpPaise: toPaise(price),
            executionPricePaise,
            brokeragePaise: BROKERAGE_PAISE,
            grossProceedsPaise,
            creditPaise,
            pnlPaise,
            leverage: isIntraday ? INTRADAY_LEVERAGE : 1,
        };
    } catch (err) {
        await client.query("ROLLBACK");
        throw err;
    } finally {
        client.release();
    }
};

export { executeBuy, executeSell, validatePriceData, INTRADAY_LEVERAGE, BROKERAGE_PAISE, BUY_SPREAD, SELL_SPREAD };
