// Application health.
//
// READY must mean the autonomous loop can actually do its job. Reporting READY
// while the market-data feed is down would make the health endpoint worse than
// having none, because it would suppress exactly the alert that matters.

export const HEALTH = {
    STARTING: "STARTING",
    RECOVERING: "RECOVERING",
    READY: "READY",
    DEGRADED: "DEGRADED",   // alive and safe, but not fully operational
    HALTED: "HALTED",       // deliberately not trading
    FAILED: "FAILED",       // a critical dependency is gone
};

// Order matters: the first matching rule wins, worst first.
export const deriveHealth = ({
    bootStage, dependencies, orchestratorPhase, session, connection, halted,
}) => {
    if (!dependencies.database) return HEALTH.FAILED;
    if (bootStage === "failed") return HEALTH.FAILED;
    if (halted) return HEALTH.HALTED;
    if (bootStage !== "complete") {
        return bootStage === "recovering" ? HEALTH.RECOVERING : HEALTH.STARTING;
    }
    if (orchestratorPhase !== "RUNNING") return HEALTH.DEGRADED;
    if (!dependencies.redis) return HEALTH.DEGRADED;

    // Outside market hours a disconnected feed is expected, not degraded.
    const marketHoursRequireData = session === "OPEN" || session === "CLOSING";
    if (marketHoursRequireData && !connection.trusted) return HEALTH.DEGRADED;

    return HEALTH.READY;
};

export const isSafeToTrade = (status) => status === HEALTH.READY;
