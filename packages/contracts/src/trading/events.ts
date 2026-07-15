import { z } from "zod";
import { defineEvent } from "../envelope/envelope.js";
import { OrderSide } from "../common/enums.js";
import { Venue } from "../common/instrument.js";

/**
 * trade.executed v1 — a paper trade settled (M9).
 * Emitted transactionally with the order insert. `decisionId` links the
 * trade to the journal decision that motivated it (null for unassisted
 * trades) — the join key M11's outcome labeler and M16's reflection use.
 * Carries no user identity: account attribution stays in the Trading
 * context's own tables.
 */
export const TradeExecutedPayloadV1 = z.strictObject({
    orderId: z.int().positive(),
    venue: Venue,
    symbol: z.string().min(1).max(32),
    instrumentId: z.uuid().nullable(),
    side: OrderSide,
    quantity: z.int().positive(),
    executionPriceMinor: z.int().positive(),
    mode: z.enum(["INTRADAY", "DELIVERY"]),
    decisionId: z.uuid().nullable(),
    pnlMinor: z.int().nullable(),
});
export type TradeExecutedPayloadV1 = z.infer<typeof TradeExecutedPayloadV1>;

export const TradeExecutedV1 = defineEvent("trade.executed", 1, TradeExecutedPayloadV1);
export const TRADE_EXECUTED = { type: "trade.executed", v: 1 } as const;
