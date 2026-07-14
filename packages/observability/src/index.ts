/**
 * @zentrade/observability — logging, correlation, metrics.
 *
 * Rules of this package (constitutional):
 *  1. Zero runtime dependencies; node built-ins only.
 *  2. Never logs payload bodies on its own — callers choose attributes
 *     (evidence may contain licensed text later; the logger must not leak it).
 *  3. JSON fields follow the OTel log data model shape so a collector is a
 *     sink swap.
 */

export { createLogger, type Logger, type LogRecord, type Severity, type Sink, type LoggerOptions } from "./logger.js";
export { runWithCorrelation, currentCorrelationId, ensureCorrelationId } from "./correlation.js";
export { createMetrics, metrics, type Metrics, type MetricsSnapshot } from "./metrics.js";
