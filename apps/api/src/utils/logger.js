import { createLogger } from "@zentrade/observability";

/**
 * The api's logger — thin delegate over @zentrade/observability (M6).
 * Same five channels every call site has always used. LOG_FORMAT=json
 * switches to OTel-shaped JSON lines; LOG_SAMPLE_RATE (0..1) samples
 * INFO-class chatter. TRADE lines are never sampled — every execution logs.
 * The active correlation id is attached automatically.
 */

const base = createLogger({
    format: process.env.LOG_FORMAT === "json" ? "json" : "pretty",
    sampleRate: process.env.LOG_SAMPLE_RATE !== undefined ? Number(process.env.LOG_SAMPLE_RATE) : 1,
    sampleExemptChannels: ["TRADE"],
});

const logger = {
    info: (context, message, data) => base.log("INFO", "INFO", context, message, data),
    warn: (context, message, data) => base.log("WARN", "WARN", context, message, data),
    error: (context, message, data) => base.log("ERROR", "ERROR", context, message, data),
    trade: (context, message, data) => base.log("INFO", "TRADE", context, message, data),
    market: (context, message, data) => base.log("INFO", "MARKET", context, message, data),
};

export default logger;
