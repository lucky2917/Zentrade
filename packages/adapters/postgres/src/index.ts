/**
 * @zentrade/adapter-postgres — SQL implementations of domain ports.
 * Rules: connections are injected (this package never reads env or opens
 * pools); every query is parameterized; one adapter per port.
 */

export {
    createInstrumentResolver,
    type InstrumentResolver,
    type ResolvedInstrument,
    type QueryablePool,
} from "./instrumentResolver.js";
