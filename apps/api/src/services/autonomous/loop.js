import { runMonitorCycle } from "./monitor.js";
import { requiresReasoning, routeOf, ROUTE } from "./events.js";
import { reassessPosition } from "./reassess.js";
import { evaluate as evaluateRisk, DECISION } from "./riskGate.js";

// The position loop.
//
// One cycle: observe every open position cheaply, decide whether anything
// warrants thought, think only about what does, put every resulting intent
// through the risk gate, and journal all of it.
//
// The loop is a pure function of its inputs and its injected ports. Nothing in
// here reads a clock, opens a socket or talks to a database directly, which is
// what lets the whole autonomous path run deterministically in a test.

export const ACTION_TO_INTENT = {
    EXIT: "SELL",
    REDUCE: "SELL",
    ADD: "BUY",
    HOLD: null,
};

// A reassessment that yields HOLD produces no order. Anything else becomes an
// intent that the risk gate must approve before it can reach execution.
export const intentFrom = (decision, position) => {
    const side = ACTION_TO_INTENT[decision.action];
    if (!side) return null;

    const quantity = decision.action === "REDUCE"
        ? Math.max(1, Math.floor(position.quantity / 2))
        : position.quantity;

    return {
        action: decision.action,
        side,
        symbol: position.symbol,
        quantity: decision.action === "ADD" ? Math.max(1, position.quantity) : quantity,
        pricePaise: position.currentPricePaise,
        referencePricePaise: position.currentPricePaise,
        correlationId: position.correlationId,
        clientOrderId: `${position.correlationId}:${decision.action}:${position.symbol}`,
    };
};

export const runLoopCycle = async ({
    positions, portfolio, riskContext, previousBySymbol = new Map(),
    now = new Date(), ports = {},
}) => {
    const {
        recordEvent = async () => null,
        loadThesis = async () => null,
        callModel = null,
        recordReassessment = async () => null,
        execute = null,
        journal = async () => null,
        logger = null,
    } = ports;

    const cycle = {
        at: now.toISOString(),
        eventsEmitted: 0, eventsDeduped: 0, reasoningInvocations: 0,
        intents: 0, riskRejections: 0, executions: 0,
        events: [], decisions: [],
    };

    const events = runMonitorCycle({ positions, portfolio, previousBySymbol, now });
    const bySymbol = new Map(positions.map((p) => [p.symbol, p]));

    for (const event of events) {
        // Persisting first is what makes deduplication work across restarts:
        // a key already present means this condition has been handled.
        const stored = await recordEvent(event);
        if (stored === null) { cycle.eventsDeduped += 1; continue; }
        cycle.eventsEmitted += 1;
        cycle.events.push({ type: event.type, symbol: event.symbol, severity: event.severity,
                            route: routeOf(event) });

        if (!requiresReasoning(event)) continue;

        const position = bySymbol.get(event.symbol);
        if (!position) continue;
        const thesis = await loadThesis(position);
        if (!thesis) continue;

        cycle.reasoningInvocations += 1;
        const decision = await reassessPosition({
            position, thesis, event, portfolio, callModel,
        });

        const intent = intentFrom(decision, position);
        let risk = null;
        let executed = false;

        if (intent) {
            cycle.intents += 1;
            risk = evaluateRisk(intent, { ...riskContext, portfolio,
                                          nowMs: now.getTime(), stale: position.stale });
            if (risk.decision === DECISION.REJECT) {
                cycle.riskRejections += 1;
                logger?.warn?.("AutonomousLoop",
                    `risk rejected ${intent.action} ${intent.symbol}: ${risk.code}`);
            } else if (execute) {
                await execute(intent);
                executed = true;
                cycle.executions += 1;
            }
        }

        await recordReassessment({
            thesisId: thesis.id, eventId: stored?.id ?? null,
            correlationId: position.correlationId ?? event.correlationId,
            action: decision.action, confidence: decision.confidence,
            thesisStillValid: decision.thesisStillValid, whatChanged: decision.whatChanged,
            material: decision.material, reasoning: decision.reasoning,
            evidence: decision.evidence,
            unrealisedPnlPaise: position.unrealisedPnlPaise ?? 0,
            currentPricePaise: position.currentPricePaise ?? 0,
            holdingSeconds: position.holdingSeconds ?? 0,
            riskDecision: risk?.decision ?? null, riskReason: risk?.reason ?? null,
            executed,
        });

        await journal({
            correlationId: position.correlationId, symbol: position.symbol,
            trigger: event.type, decision, risk, executed,
        });

        cycle.decisions.push({
            symbol: position.symbol, trigger: event.type, action: decision.action,
            fallback: decision.fallback === true,
            risk: risk?.decision ?? null, riskCode: risk?.code ?? null, executed,
        });
    }

    return cycle;
};
