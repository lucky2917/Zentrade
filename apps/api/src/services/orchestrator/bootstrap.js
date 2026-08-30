import { HEALTH, deriveHealth } from "./health.js";
import { CONNECTION } from "./connectionState.js";
import { permitsNewExposure, SOURCE } from "./freshness.js";

// Ordered application startup.
//
// Each stage is explicit and recorded, so a failure names the stage rather than
// producing a stack trace from an unknown point in boot. The governing rule:
// a failed critical dependency must never report READY, and a failed optional
// dependency must leave the process alive but unable to add exposure.

export const STAGES = [
    "config", "database", "redis", "recovery", "reconciliation",
    "session", "fyers-auth", "market-data", "symbols", "orchestrator",
];

export const CRITICAL = new Set(["config", "database", "recovery"]);

export class Bootstrap {
    constructor({ steps, logger = null, clock = () => new Date() } = {}) {
        this.steps = steps;
        this.logger = logger;
        this.clock = clock;
        this.stage = "pending";
        this.results = [];
        this.dependencies = { database: false, redis: false, fyers: false, marketData: false };
        this.failure = null;
    }

    async run() {
        for (const stage of STAGES) {
            const step = this.steps[stage];
            if (!step) { this.results.push({ stage, skipped: true }); continue; }
            this.stage = stage === "recovery" ? "recovering" : stage;
            const started = Date.now();
            try {
                const value = await step();
                this.results.push({ stage, ok: true, ms: Date.now() - started, value });
                this.markDependency(stage, true);
                this.logger?.info?.("Bootstrap", `stage ${stage} ok`, { ms: Date.now() - started });
            } catch (err) {
                this.results.push({ stage, ok: false, ms: Date.now() - started, error: err.message });
                this.markDependency(stage, false);
                this.logger?.error?.("Bootstrap", `stage ${stage} failed`, { error: err.message });

                if (CRITICAL.has(stage)) {
                    // A critical dependency cannot be degraded around.
                    this.stage = "failed";
                    this.failure = { stage, error: err.message };
                    return { ok: false, stage, error: err.message };
                }
                // Everything else is survivable: the process stays alive in a
                // state that cannot add exposure.
                this.logger?.warn?.("Bootstrap",
                    `continuing in degraded mode after ${stage}`, { error: err.message });
            }
        }
        this.stage = "complete";
        return { ok: true, stages: this.results };
    }

    markDependency(stage, ok) {
        if (stage === "database") this.dependencies.database = ok;
        if (stage === "redis") this.dependencies.redis = ok;
        if (stage === "fyers-auth") this.dependencies.fyers = ok;
        if (stage === "market-data") this.dependencies.marketData = ok;
    }

    summary() {
        return {
            stage: this.stage, failure: this.failure,
            dependencies: { ...this.dependencies },
            stages: this.results.map(({ stage, ok, ms, skipped, error }) =>
                ({ stage, ok, ms, skipped, error })),
        };
    }
}

// The single health view the process exposes.
export const buildHealth = ({ bootstrap, orchestrator, connection }) => {
    const orchestratorHealth = orchestrator?.health?.() ?? { phase: "STOPPED" };
    const connectionHealth = connection?.health?.() ?? {
        state: CONNECTION.DISCONNECTED, trusted: false, dataAgeMs: null,
    };
    const session = orchestratorHealth.session ?? "CLOSED";

    const status = deriveHealth({
        bootStage: bootstrap?.stage ?? "pending",
        dependencies: bootstrap?.dependencies ?? { database: false, redis: false },
        orchestratorPhase: orchestratorHealth.phase,
        session,
        connection: connectionHealth,
        halted: orchestratorHealth.halted ?? false,
    });

    const exposure = permitsNewExposure({
        connectionTrusted: connectionHealth.trusted,
        websocketAgeMs: connectionHealth.dataAgeMs,
    });

    return {
        status,
        newExposurePermitted: status === HEALTH.READY && exposure.permitted,
        exposureBlockedBecause: exposure.permitted ? null : exposure.reason,
        boot: bootstrap?.summary?.() ?? null,
        session,
        connection: connectionHealth,
        orchestrator: orchestratorHealth,
        freshnessSource: SOURCE.WEBSOCKET,
    };
};
