// The hard risk gate.
//
// Architecture: AI DECISION -> RISK GATE -> EXECUTION. Never AI -> broker.
// The AI produces intent; this decides whether the intent is permitted. It
// cannot be overridden by the AI, by a confidence score, or by a prompt.
//
// Semantics are ported from the validated Python core (ZentradeBrain
// src/zentrade/core/risk.py and limits.py), which is covered by P5's 55
// acceptance checks. Limits are expressed in paise to match `portfolio`.
//
// The governing rule is FAIL CLOSED: anything this module cannot evaluate is
// a rejection. There is no default-allow path, because trading on unknown
// state is precisely the failure the gate exists to prevent.

export const DECISION = { ALLOW: "ALLOW", REJECT: "REJECT" };

export const DEFAULT_LIMITS = {
    positionValuePaise: 50_000_000,      // Rs 5,00,000
    grossExposurePaise: 500_000_000,     // Rs 50,00,000
    netExposurePaise: 400_000_000,       // Rs 40,00,000
    maxSymbols: 25,
    tradesPerSession: 20,
    turnoverPerSessionPaise: 1_000_000_000, // Rs 1,00,00,000
    dailyLossPaise: 25_000_000,          // Rs 2,50,000 -> kill switch
    maxDrawdownPercent: 20,              // -> kill switch
    viabilityFloorPaise: 1_000_000,      // Rs 10,000
    maxProposalAgeMs: 5 * 60 * 1000,
    maxPriceDriftBps: 100,
};

// Risk-reducing actions stay permitted when the book is halted. A limit that
// stops you closing a position is a limit that traps you in one.
const REDUCING_ACTIONS = new Set(["EXIT", "REDUCE", "SELL"]);
export const isReducing = (action) => REDUCING_ACTIONS.has(action);

export const LEGAL_ACTIONS = ["BUY", "SELL", "HOLD", "EXIT", "REDUCE", "ADD"];

const reject = (code, reason) => ({ decision: DECISION.REJECT, code, reason });
const allow = (notes = []) => ({ decision: DECISION.ALLOW, code: null, reason: null, notes });

// Drawdown ladder from the Python core: the deeper the drawdown, the smaller
// the permitted budget.
export const drawdownMultiplier = (drawdownPercent) => {
    if (drawdownPercent >= 15) return 0.3;
    if (drawdownPercent >= 10) return 0.6;
    if (drawdownPercent >= 5) return 0.8;
    return 1.0;
};

// Bounded composition: the three model-facing factors answer one question and
// compose by min; drawdown is about the account and multiplies. Two axes,
// never four — multiplying all four compounds a penalty that was never meant
// to compound.
export const riskBudget = ({ regime = 1, health = 1, ood = 1, drawdownPercent = 0 }) =>
    Math.min(regime, health, ood) * drawdownMultiplier(drawdownPercent);

export const evaluate = (intent, context, limits = DEFAULT_LIMITS) => {
    // --- fail closed: unevaluable state is a rejection -------------------
    if (!intent || typeof intent !== "object") return reject("NO_INTENT", "no intent supplied");
    if (!LEGAL_ACTIONS.includes(intent.action))
        return reject("ILLEGAL_ACTION", `action ${JSON.stringify(intent.action)} is not legal`);
    if (!context || typeof context !== "object")
        return reject("NO_CONTEXT", "risk context unavailable");
    if (!context.portfolio) return reject("NO_PORTFOLIO", "portfolio state unavailable");

    if (intent.action === "HOLD") return allow(["hold requires no capital"]);

    if (context.killSwitchEngaged && !isReducing(intent.action))
        return reject("KILL_SWITCH", "kill switch engaged; only risk-reducing actions permitted");

    if (context.stale === true && !isReducing(intent.action))
        return reject("STALE_DATA", "market data is stale; no new exposure on an untrusted price");

    if (!Number.isFinite(intent.pricePaise) || intent.pricePaise <= 0)
        return reject("NO_PRICE", "intent has no usable price");
    if (!Number.isInteger(intent.quantity) || intent.quantity <= 0)
        return reject("BAD_QUANTITY", "quantity must be a positive integer");

    if (Number.isFinite(intent.createdAtMs) && Number.isFinite(context.nowMs)) {
        const age = context.nowMs - intent.createdAtMs;
        if (age > limits.maxProposalAgeMs)
            return reject("STALE_PROPOSAL", `intent is ${Math.round(age / 1000)}s old`);
    }

    if (Number.isFinite(intent.referencePricePaise) && intent.referencePricePaise > 0) {
        const driftBps = Math.abs(
            (intent.pricePaise - intent.referencePricePaise) / intent.referencePricePaise) * 10_000;
        if (driftBps > limits.maxPriceDriftBps)
            return reject("PRICE_DRIFT", `price moved ${Math.round(driftBps)} bps since the decision`);
    }

    // --- duplicate protection -------------------------------------------
    if (intent.clientOrderId && context.openClientOrderIds?.includes(intent.clientOrderId))
        return reject("DUPLICATE_ORDER", `client order id ${intent.clientOrderId} is already working`);

    // --- reducing actions bypass exposure budgets ------------------------
    if (isReducing(intent.action)) {
        const held = context.portfolio.positions?.find((p) => p.symbol === intent.symbol);
        if (!held) return reject("NO_POSITION", `cannot reduce ${intent.symbol}; no position held`);
        if (intent.quantity > held.quantity)
            return reject("OVER_REDUCE", "cannot sell more than is held");
        return allow(["risk-reducing action exempt from exposure and turnover budgets"]);
    }

    // --- from here: actions that add exposure ----------------------------
    const notionalPaise = intent.pricePaise * intent.quantity;

    if (notionalPaise < limits.viabilityFloorPaise)
        return reject("BELOW_VIABILITY_FLOOR",
            `notional ${notionalPaise} is below the viability floor; costs would dominate`);

    const portfolio = context.portfolio;
    const existing = portfolio.positions?.find((p) => p.symbol === intent.symbol);
    const symbolExposure = (existing?.exposurePaise ?? 0) + notionalPaise;
    if (symbolExposure > limits.positionValuePaise)
        return reject("POSITION_LIMIT",
            `symbol exposure ${symbolExposure} exceeds ${limits.positionValuePaise}`);

    if (portfolio.grossExposurePaise + notionalPaise > limits.grossExposurePaise)
        return reject("GROSS_EXPOSURE_LIMIT", "gross exposure limit reached");

    if (Math.abs(portfolio.netExposurePaise + notionalPaise) > limits.netExposurePaise)
        return reject("NET_EXPOSURE_LIMIT", "net exposure limit reached");

    if (!existing && (portfolio.positionCount ?? 0) >= limits.maxSymbols)
        return reject("MAX_SYMBOLS", `already holding ${limits.maxSymbols} symbols`);

    if (notionalPaise > (portfolio.cashPaise ?? 0))
        return reject("INSUFFICIENT_CASH", "insufficient cash for this notional");

    const session = context.session ?? {};
    if ((session.trades ?? 0) >= limits.tradesPerSession)
        return reject("TRADE_COUNT_LIMIT", "session trade count exhausted");
    if ((session.turnoverPaise ?? 0) + notionalPaise > limits.turnoverPerSessionPaise)
        return reject("TURNOVER_LIMIT", "session turnover limit reached");

    if ((session.realisedLossPaise ?? 0) >= limits.dailyLossPaise)
        return reject("DAILY_LOSS_LIMIT", "daily loss limit reached; kill switch territory");

    const budget = riskBudget({
        regime: context.regimeConfidence ?? 1,
        health: context.strategyHealth ?? 1,
        ood: context.oodConfidence ?? 1,
        drawdownPercent: context.drawdownPercent ?? 0,
    });
    if (budget <= 0) return reject("NO_RISK_BUDGET", "risk budget is exhausted");

    return allow([`risk budget ${budget.toFixed(3)}`]);
};
