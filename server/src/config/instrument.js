import * as Sentry from "@sentry/node";

// Must be imported before express so Sentry can instrument it.
// No-op unless SENTRY_DSN is set.
if (process.env.SENTRY_DSN) {
    Sentry.init({
        dsn: process.env.SENTRY_DSN,
        environment: process.env.NODE_ENV || "development",
        // errors only — no performance tracing
        tracesSampleRate: 0,
    });
}

export const sentryEnabled = Boolean(process.env.SENTRY_DSN);
export { Sentry };
