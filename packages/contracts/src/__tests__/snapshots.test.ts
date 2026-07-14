import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
    MarketTick,
    Candle,
    EventEnvelopeBase,
    InstrumentRef,
    VenueSymbolRef,
    AssetClass,
    OrderSide,
    Stance,
    Confidence,
    RegimeTag,
    MdCandleClosedPayloadV1,
    RefInstrumentAddedPayloadV1,
} from "../index.js";

/**
 * Breaking-change tripwire: the JSON-Schema of every exported contract is
 * frozen as a committed golden file. Any schema change fails CI until the
 * golden is regenerated on purpose (vitest -u) and reviewed in the diff.
 */
const goldens: Record<string, z.ZodType> = {
    MarketTick,
    Candle,
    EventEnvelopeBase,
    InstrumentRef,
    VenueSymbolRef,
    AssetClass,
    OrderSide,
    Stance,
    Confidence,
    RegimeTag,
    MdCandleClosedPayloadV1,
    RefInstrumentAddedPayloadV1,
};

describe("JSON-Schema goldens", () => {
    for (const [name, schema] of Object.entries(goldens)) {
        it(`${name} matches its committed golden`, async () => {
            const jsonSchema = z.toJSONSchema(schema, { io: "output" });
            await expect(JSON.stringify(jsonSchema, null, 2) + "\n").toMatchFileSnapshot(
                `./golden/${name}.schema.json`,
            );
        });
    }
});
