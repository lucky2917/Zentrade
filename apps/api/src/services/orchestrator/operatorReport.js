// Operator report.
//
// One structured answer to "is the brain alive and what is it doing". It reads
// state; it changes nothing, and it is safe to call at any time.

export const buildOperatorReport = async ({
    runtime, bootstrap, connection, newsStore, engine, reconciler, userId, clock = () => new Date(),
}) => {
    const now = clock();
    const health = runtime?.health?.() ?? null;
    const orchestrator = health?.orchestrator ?? null;

    const openOrders = engine ? await engine.openOrders(userId) : [];
    const ambiguous = openOrders.filter((o) => o.state === "AMBIGUOUS");
    const positions = (await runtime?.sourcePorts?.loadPositions?.()) ?? [];

    const connectionHealth = connection?.health?.(now.getTime()) ?? null;

    return {
        generatedAt: now.toISOString(),

        // IS THE BRAIN ALIVE?
        alive: Boolean(health && orchestrator?.phase === "RUNNING"),
        mode: health?.mode ?? "UNKNOWN",
        liveExecutionEnabled: health?.liveExecutionEnabled ?? false,
        phase: orchestrator?.phase ?? "STOPPED",
        session: orchestrator?.session ?? null,
        halted: orchestrator?.halted ?? false,

        // IS FYERS CONNECTED? IS DATA FRESH?
        marketData: {
            state: connectionHealth?.state ?? "UNKNOWN",
            trusted: connectionHealth?.trusted ?? false,
            dataAgeMs: connectionHealth?.dataAgeMs ?? null,
            lastTickAt: connectionHealth?.lastTickAt ?? null,
            reconnectAttempts: connectionHealth?.reconnectAttempts ?? 0,
        },

        // WHAT IS IT WATCHING?
        watching: {
            contexts: orchestrator?.contexts ?? 0,
            positions: positions.length,
            symbols: positions.map((p) => p.symbol),
        },

        // WHAT POSITIONS EXIST, AND WHY?
        positions: positions.map((p) => ({
            symbol: p.symbol,
            quantity: p.quantity,
            entryPricePaise: p.entryPricePaise,
            currentPricePaise: p.currentPricePaise,
            unrealisedPnlPaise: p.unrealisedPnlPaise,
            stale: p.stale,
            hasThesis: p.hasThesis,
            thesisId: p.thesisId,
            holdingSeconds: p.holdingSeconds,
        })),

        // WHAT ORDERS EXIST? ANY AMBIGUOUS?
        orders: {
            open: openOrders.length,
            ambiguous: ambiguous.length,
            ambiguousIds: ambiguous.map((o) => o.id),
            blockingNewExposure: ambiguous.length > 0,
            byState: openOrders.reduce((acc, o) => {
                acc[o.state] = (acc[o.state] ?? 0) + 1; return acc;
            }, {}),
        },

        // WHEN AND WHY DID THE AI LAST REASON?
        reasoning: {
            invocations: orchestrator?.metrics?.reasoningInvocations ?? 0,
            avoided: orchestrator?.metrics?.reasoningAvoided ?? 0,
            lastDecisionAt: orchestrator?.metrics?.lastDecisionAt ?? null,
            lastExecutionAt: orchestrator?.metrics?.lastExecutionAt ?? null,
            riskRejections: orchestrator?.metrics?.riskRejections ?? 0,
            executions: orchestrator?.metrics?.executions ?? 0,
        },

        // WHAT ANOMALIES AND NEWS?
        intelligence: {
            anomaliesDetected: orchestrator?.metrics?.anomaliesDetected ?? 0,
            marketWideAnomalies: orchestrator?.metrics?.marketWideAnomalies ?? 0,
            newsEventsReceived: orchestrator?.metrics?.newsEventsReceived ?? 0,
        },

        // IS THE NEWS SOURCE HEALTHY?
        newsSource: newsStore?.health?.() ?? null,

        // IS THE QUEUE HEALTHY?
        queue: orchestrator?.queue ?? null,

        // IS THE SCHEDULER HEALTHY?
        scheduler: {
            running: orchestrator?.scheduler?.running ?? false,
            jobs: (orchestrator?.scheduler?.jobs ?? []).map((j) => ({
                name: j.name, runs: j.runs, failures: j.failures,
                skipped: j.skipped, lastError: j.lastError, overrunning: j.overrunning,
            })),
            failingJobs: (orchestrator?.scheduler?.jobs ?? [])
                .filter((j) => j.lastError).map((j) => j.name),
        },

        venue: health?.venue ?? null,
        runtimeCounters: health?.runtime ?? null,
        boot: bootstrap?.summary?.() ?? null,
    };
};

// Compact human-readable rendering for a log line or a terminal.
export const renderOperatorReport = (report) => {
    const lines = [
        `brain        ${report.alive ? "ALIVE" : "NOT RUNNING"}  (${report.phase}, ${report.mode})`,
        `session      ${report.session}${report.halted ? "  [HALTED]" : ""}`,
        `market data  ${report.marketData.state}  trusted=${report.marketData.trusted}  age=${report.marketData.dataAgeMs ?? "n/a"}ms`,
        `watching     ${report.watching.positions} position(s), ${report.watching.contexts} context(s)`,
        `orders       ${report.orders.open} open, ${report.orders.ambiguous} ambiguous${report.orders.blockingNewExposure ? "  [BLOCKING NEW EXPOSURE]" : ""}`,
        `reasoning    ${report.reasoning.invocations} calls, ${report.reasoning.avoided} avoided, ${report.reasoning.riskRejections} risk rejections`,
        `intelligence ${report.intelligence.anomaliesDetected} anomalies, ${report.intelligence.marketWideAnomalies} market-wide, ${report.intelligence.newsEventsReceived} news`,
        `queue        depth ${report.queue?.depth ?? "n/a"} / ${report.queue?.capacity ?? "n/a"}`,
        `scheduler    ${report.scheduler.running ? "running" : "stopped"}, ${report.scheduler.failingJobs.length} failing job(s)`,
        `live money   ${report.liveExecutionEnabled ? "ENABLED" : "DISABLED"}`,
    ];
    return lines.join("\n");
};
