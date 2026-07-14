import { currentCorrelationId } from "./correlation.js";

/**
 * Structured logger.
 *  - pretty format: the colored single-line console output the api has always
 *    had (kept byte-compatible so Render logs don't change shape by surprise)
 *  - json format: one JSON object per line with OTel-log-data-model-shaped
 *    fields (timestamp/severityText/body/attributes) so a real collector is
 *    a sink swap, not a rewrite
 *  - sampling: LOG_SAMPLE_RATE (0..1) drops a fraction of info-class lines;
 *    warn/error always pass
 *  - the active correlation id is attached automatically in both formats
 */

export type Severity = "INFO" | "WARN" | "ERROR";

export interface LogRecord {
    timestamp: string;
    severityText: Severity;
    /** display channel: INFO/WARN/ERROR or a custom one like TRADE/MARKET */
    channel: string;
    context: string;
    body: string;
    correlationId?: string;
    attributes?: Record<string, unknown>;
}

export type Sink = (line: string, record: LogRecord) => void;

export interface LoggerOptions {
    format?: "pretty" | "json";
    /** 0..1 — fraction of info-class records kept; warn/error always kept */
    sampleRate?: number;
    /** channels never sampled even at INFO severity (e.g. TRADE) */
    sampleExemptChannels?: string[];
    sink?: Sink;
    /** injectable for deterministic sampling tests */
    random?: () => number;
}

const COLORS: Record<string, string> = {
    reset: "\x1b[0m",
    red: "\x1b[31m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    blue: "\x1b[34m",
    magenta: "\x1b[35m",
    cyan: "\x1b[36m",
    gray: "\x1b[90m",
};

const CHANNEL_COLOR: Record<string, string> = {
    INFO: COLORS.green!,
    WARN: COLORS.yellow!,
    ERROR: COLORS.red!,
    TRADE: COLORS.magenta!,
    MARKET: COLORS.blue!,
};

const prettyLine = (r: LogRecord): string => {
    const color = CHANNEL_COLOR[r.channel] ?? COLORS.green!;
    const dataStr = r.attributes && Object.keys(r.attributes).length > 0 ? ` ${JSON.stringify(r.attributes)}` : "";
    const corr = r.correlationId ? ` ${COLORS.gray}(${r.correlationId})${COLORS.reset}` : "";
    return `${COLORS.gray}[${r.timestamp}]${COLORS.reset} ${color}${r.channel}${COLORS.reset} ${COLORS.cyan}[${r.context}]${COLORS.reset} ${r.body}${dataStr}${corr}`;
};

const jsonLine = (r: LogRecord): string => JSON.stringify(r);

const defaultSink: Sink = (line, record) => {
    if (record.severityText === "ERROR") console.error(line);
    else if (record.severityText === "WARN") console.warn(line);
    else console.log(line);
};

export const createLogger = (options: LoggerOptions = {}) => {
    const format = options.format ?? "pretty";
    const sampleRate = options.sampleRate ?? 1;
    const exempt = new Set(options.sampleExemptChannels ?? []);
    const sink = options.sink ?? defaultSink;
    const random = options.random ?? Math.random;
    const render = format === "json" ? jsonLine : prettyLine;

    const log = (
        severity: Severity,
        channel: string,
        context: string,
        body: string,
        attributes?: Record<string, unknown>,
    ): void => {
        if (severity === "INFO" && sampleRate < 1 && !exempt.has(channel) && random() >= sampleRate) return;

        const record: LogRecord = {
            timestamp: new Date().toISOString(),
            severityText: severity,
            channel,
            context,
            body,
        };
        const correlationId = currentCorrelationId();
        if (correlationId) record.correlationId = correlationId;
        if (attributes !== undefined) record.attributes = attributes;

        sink(render(record), record);
    };

    return {
        log,
        info: (context: string, body: string, attributes?: Record<string, unknown>) =>
            log("INFO", "INFO", context, body, attributes),
        warn: (context: string, body: string, attributes?: Record<string, unknown>) =>
            log("WARN", "WARN", context, body, attributes),
        error: (context: string, body: string, attributes?: Record<string, unknown>) =>
            log("ERROR", "ERROR", context, body, attributes),
    };
};

export type Logger = ReturnType<typeof createLogger>;
