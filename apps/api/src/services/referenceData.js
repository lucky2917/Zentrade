import { computeSeedPlan, nseCalendarSeedRows } from "@zentrade/domain-reference";
import { createInstrumentResolver } from "@zentrade/adapter-postgres";
import { REF_INSTRUMENT_ADDED } from "@zentrade/contracts";
import { pool } from "../config/db.js";
import { STOCKS } from "../config/stocks.js";
import { INDICES } from "./fyers/smartWall.js";
import { enqueueEvent } from "./eventBackbone.js";
import logger from "../utils/logger.js";

/**
 * Reference-data seeder (M5). Runs at boot, after migrations:
 *  - upserts the instrument universe from config (200 NSE equities + indices)
 *  - emits ref.instrument.added.v1 through the outbox, in the SAME
 *    transaction as each insert (the outbox doing its actual job)
 *  - upserts NSE holiday exception rows from the kernel's single source
 * Idempotent: a second boot inserts nothing and emits nothing.
 */

const NSE_TICK_SIZE = 0.05;

// SENSEX lives on BSE (see smartWall FYERS_INDEX_SYMBOLS)
const INDEX_VENUES = { NIFTY50: "NSE", BANKNIFTY: "NSE", SENSEX: "BSE" };

const desiredInstruments = () => [
    ...STOCKS.map((s) => ({
        venue: "NSE",
        symbol: s.symbol,
        name: s.name,
        assetClass: "equity",
        currency: "INR",
        tickSize: NSE_TICK_SIZE,
        lotSize: 1,
        metadata: { sector: s.sector, yahooSymbol: s.yahooSymbol, sectorIndex: s.sectorIndex },
    })),
    ...INDICES.map((i) => ({
        venue: INDEX_VENUES[i.symbol] ?? "NSE",
        symbol: i.symbol,
        name: i.name,
        assetClass: "index",
        currency: "INR",
        tickSize: null,
        lotSize: null,
        metadata: { yahooSymbol: i.yahooSymbol },
    })),
];

export const seedReferenceData = async () => {
    const { rows: existing } = await pool.query("SELECT venue, symbol FROM instruments");
    const plan = computeSeedPlan(existing, desiredInstruments());

    let inserted = 0;
    for (const seed of plan.toInsert) {
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            const { rows } = await client.query(
                `INSERT INTO instruments (venue, symbol, name, asset_class, currency, tick_size, lot_size, metadata)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                 ON CONFLICT (venue, symbol) DO NOTHING
                 RETURNING id`,
                [seed.venue, seed.symbol, seed.name, seed.assetClass, seed.currency, seed.tickSize, seed.lotSize, JSON.stringify(seed.metadata)]
            );
            if (rows.length > 0) {
                await enqueueEvent(
                    {
                        type: REF_INSTRUMENT_ADDED.type,
                        v: REF_INSTRUMENT_ADDED.v,
                        payload: {
                            instrumentId: rows[0].id,
                            venue: seed.venue,
                            symbol: seed.symbol,
                            name: seed.name,
                            assetClass: seed.assetClass,
                            currency: seed.currency,
                        },
                    },
                    client
                );
                inserted++;
            }
            await client.query("COMMIT");
        } catch (err) {
            await client.query("ROLLBACK").catch(() => {});
            throw err;
        } finally {
            client.release();
        }
    }

    const calendarRows = nseCalendarSeedRows();
    for (const row of calendarRows) {
        await pool.query(
            `INSERT INTO trading_calendars (venue, cal_date, is_holiday, label)
             VALUES ($1, $2, TRUE, 'nse_holiday')
             ON CONFLICT (venue, cal_date) DO NOTHING`,
            [row.venue, row.calDate]
        );
    }

    logger.info("ReferenceData", `Seed complete: ${inserted} instruments added, ${calendarRows.length} calendar exceptions ensured`);
    return { inserted, calendarRows: calendarRows.length };
};

export const instrumentResolver = createInstrumentResolver(pool);
