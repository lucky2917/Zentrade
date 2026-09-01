// Deterministic synthesis.
//
// The model proposes; this decides whether the proposal survives arithmetic.
// Expected value, risk/reward and the cost hurdle are computed here, never by
// the LLM, and nothing is fabricated: where a quantity cannot be honestly
// derived it is reported as UNKNOWN or INSUFFICIENT_BASIS.

export const UNKNOWN = "UNKNOWN";
export const INSUFFICIENT_BASIS = "INSUFFICIENT_BASIS";

// P6 measured the full round trip at 73.55 bps: brokerage, STT, exchange
// charges, SEBI, stamp duty, GST, DP charges and slippage, every rate rounded
// up. That is the hurdle a real trade must clear.
//
// NOTE, stated because it matters: the JS paper engine charges only spread
// plus Rs 20 brokerage per side, which is LESS than this. Paper P&L therefore
// flatters reality, and decisions are made against the measured full cost
// rather than the cheaper simulated one.
export const ROUND_TRIP_COST_BPS = 73.55;

export const EDGE_VERDICT = {
    CLEARS_COSTS: "CLEARS_COSTS",
    BELOW_COSTS: "BELOW_COSTS",
    INSUFFICIENT_BASIS: "INSUFFICIENT_BASIS",
};

// Risk/reward from levels the model proposed. Requires all three; a missing
// level makes the ratio undefined rather than assumed.
export const riskReward = ({ entryPaise, stopPaise, targetPaise }) => {
    if (![entryPaise, stopPaise, targetPaise].every(Number.isFinite)) {
        return { ratio: UNKNOWN, riskPaise: UNKNOWN, rewardPaise: UNKNOWN,
                 reason: "entry, stop or target not supplied" };
    }
    const risk = Math.abs(entryPaise - stopPaise);
    const reward = Math.abs(targetPaise - entryPaise);
    if (risk === 0) {
        return { ratio: UNKNOWN, riskPaise: 0, rewardPaise: reward,
                 reason: "stop equals entry; risk is undefined" };
    }
    return { ratio: reward / risk, riskPaise: risk, rewardPaise: reward, reason: null };
};

// Gross expected move implied by the target, in basis points.
export const grossMoveBps = ({ entryPaise, targetPaise }) => {
    if (![entryPaise, targetPaise].every(Number.isFinite) || entryPaise <= 0) return UNKNOWN;
    return (Math.abs(targetPaise - entryPaise) / entryPaise) * 10_000;
};

// Does the proposed move clear the measured cost hurdle? This is arithmetic,
// not judgement, and it is the check that most setups fail.
export const edgeAgainstCosts = ({ entryPaise, targetPaise, costBps = ROUND_TRIP_COST_BPS }) => {
    const gross = grossMoveBps({ entryPaise, targetPaise });
    if (gross === UNKNOWN) {
        return { verdict: EDGE_VERDICT.INSUFFICIENT_BASIS, grossBps: UNKNOWN,
                 costBps, netBps: UNKNOWN,
                 reason: "no target supplied, so the gross move cannot be computed" };
    }
    const net = gross - costBps;
    return {
        verdict: net > 0 ? EDGE_VERDICT.CLEARS_COSTS : EDGE_VERDICT.BELOW_COSTS,
        grossBps: gross, costBps, netBps: net,
        reason: net > 0
            ? `target implies ${gross.toFixed(1)} bps against a ${costBps} bps round trip`
            : `target implies only ${gross.toFixed(1)} bps against a ${costBps} bps round trip`,
    };
};

// Expected value. Deliberately refuses to produce a number without an
// empirically supported probability, and today there is none: P6 promoted no
// model, so no calibrated probability exists for these setups.
export const expectedValue = ({ riskPaise, rewardPaise, probability = null }) => {
    if (probability === null || probability === undefined) {
        return {
            value: INSUFFICIENT_BASIS, probability: UNKNOWN,
            reason: "no calibrated probability exists for this setup; P6 promoted no model, " +
                    "and inventing one would be fabrication",
        };
    }
    if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
        return { value: INSUFFICIENT_BASIS, probability: UNKNOWN,
                 reason: "probability outside [0,1]" };
    }
    if (![riskPaise, rewardPaise].every(Number.isFinite)) {
        return { value: INSUFFICIENT_BASIS, probability,
                 reason: "risk or reward not quantified" };
    }
    return {
        value: probability * rewardPaise - (1 - probability) * riskPaise,
        probability, reason: null,
    };
};

// What deploying capital here costs elsewhere. Bounded and deterministic; no
// optimiser.
export const opportunityCost = ({ notionalPaise, portfolio, limits }) => {
    const notes = [];
    const cash = portfolio?.cashPaise ?? 0;
    if (Number.isFinite(notionalPaise) && cash > 0) {
        const share = notionalPaise / cash;
        notes.push(`uses ${(share * 100).toFixed(1)}% of available cash`);
        if (share > 0.5) notes.push("would concentrate more than half of free cash in one name");
    }
    const count = portfolio?.positionCount ?? 0;
    if (limits?.maxSymbols && count >= limits.maxSymbols * 0.8) {
        notes.push(`already holding ${count} of a maximum ${limits.maxSymbols} symbols`);
    }
    const existing = portfolio?.positions?.find((p) => p.symbol === portfolio?.symbol);
    if (existing) notes.push("adds to an existing position in the same symbol");
    return { notes, concentrated: notes.length > 0 };
};

// Time decay: a thesis can go stale without price touching invalidation.
export const thesisAge = ({ holdingSeconds, horizon }) => {
    if (!Number.isFinite(holdingSeconds)) return { stale: false, reason: "holding time unknown" };
    // One intraday session is 375 minutes. A thesis held most of a session
    // without resolving has decayed regardless of price.
    const limits = { INTRADAY: 375 * 60, SWING: 5 * 375 * 60, POSITIONAL: 20 * 375 * 60 };
    const limit = limits[horizon] ?? limits.INTRADAY;
    const fraction = holdingSeconds / limit;
    return {
        stale: fraction > 0.75,
        fraction,
        reason: fraction > 0.75
            ? `held ${Math.round(fraction * 100)}% of its ${horizon ?? "INTRADAY"} horizon without resolving`
            : null,
    };
};

// The final deterministic gate before the risk gate. It can only ever DOWNGRADE
// the model's proposal to HOLD; it never upgrades or invents an action.
export const synthesise = ({ proposal, traderState, limits = {} }) => {
    const reasons = [];
    let action = proposal.action;

    const entryPaise = traderState.symbolState.price !== null
        ? Math.round(traderState.symbolState.price * 100) : null;
    const rr = riskReward({
        entryPaise,
        stopPaise: proposal.stopPaise ?? null,
        targetPaise: proposal.targetPaise ?? null,
    });
    const edge = edgeAgainstCosts({ entryPaise, targetPaise: proposal.targetPaise ?? null });
    const ev = expectedValue({
        riskPaise: rr.riskPaise, rewardPaise: rr.rewardPaise,
        probability: proposal.probability ?? null,
    });

    const opening = ["BUY", "ADD"].includes(action);

    if (opening) {
        // How many bullet points the model wrote on each side is NOT a measure
        // of which side is stronger.
        //
        // This used to veto any entry where the contradicting list was as long
        // as the supporting one. Observed live: theses reading "contradicting
        // evidence (3) is not outweighed by support (3)" refused repeatedly,
        // and one carrying a 2.03 risk/reward that cleared the cost hurdle by
        // 226 bps was held on a 3-3 tie. A model that lists its caveats
        // honestly was penalised for the honesty, and the prompt asks it to
        // list them.
        //
        // It informs confidence instead, which deriveConfidence already lowers
        // for it, and it is recorded. The deciders are the measured ones: the
        // cost hurdle, the risk/reward floors, fresh-world revalidation and the
        // risk gate. A preponderance of contradiction with arithmetic that does
        // NOT clear still refuses below, on the arithmetic.
        const contradicting = proposal.contradictingEvidence?.length ?? 0;
        const supporting = proposal.supportingEvidence?.length ?? 0;
        if (contradicting > 0 && contradicting >= supporting) {
            reasons.push(`contradicting evidence (${contradicting}) is not outweighed `
                + `by support (${supporting})`);
        }

        // What the bullet counting was standing in for, stated properly.
        //
        // The timeframes disagreeing is measured data, not prose: it is the
        // one case the count was catching that genuinely should refuse, and
        // now it refuses on the measurement instead of on how many caveats the
        // model happened to type.
        // A conflict between the LONGER frames refuses; the one-minute bar
        // disagreeing does not.
        //
        // `conflict` is raised when any timeframe disagrees, and the shortest
        // one disagrees constantly — that is what an intraday pullback looks
        // like, and buying into 5m and 15m strength while the 1m dips is the
        // entry, not the objection. Refusing on it treated the best long setup
        // there is as a reason to stand aside.
        //
        // 5m against 15m is a real disagreement about where this is going, and
        // still refuses. Observed live: RAMCOSYS at 1.93 risk/reward clearing
        // costs, 1m DOWN, 5m UP, 15m DOWN — genuinely unresolved, correctly
        // held.
        const tf = traderState.symbolState?.mtf;
        const longerFramesDisagree = tf
            && tf.direction5m && tf.direction15m
            && tf.direction5m !== "FLAT" && tf.direction15m !== "FLAT"
            && tf.direction5m !== tf.direction15m;
        if (longerFramesDisagree) {
            action = "HOLD";
            reasons.push("no new exposure while the 5m and 15m disagree: "
                + `5m ${tf.direction5m}, 15m ${tf.direction15m}`);
        } else if (tf?.conflict) {
            reasons.push(`the 1m is ${tf.direction1m} against `
                + `5m ${tf.direction5m} and 15m ${tf.direction15m}`);
        }

        if (edge.verdict === EDGE_VERDICT.BELOW_COSTS) {
            action = "HOLD";
            reasons.push(`no trade: ${edge.reason}`);
        }
        if (edge.verdict === EDGE_VERDICT.INSUFFICIENT_BASIS) {
            action = "HOLD";
            reasons.push("no trade: the expected move cannot be quantified, so the cost hurdle cannot be cleared");
        }

        if (traderState.market.dataStale) {
            action = "HOLD";
            reasons.push("no new exposure on stale market data");
        }

        // A senior trader does not add exposure into a synchronised decline
        // because one chart looks good. This is arithmetic over the observed
        // universe, so the model cannot argue its way past it.
        if (traderState.market.shock && traderState.market.direction === "DOWN") {
            action = "HOLD";
            reasons.push(`no new long exposure into a market-wide decline: ${traderState.market.breadthBasis}`);
        }
        if (traderState.market.regime === "UNKNOWN" && rr.ratio === UNKNOWN) {
            reasons.push("regime unknown and risk/reward unquantified");
        }
    }

    const age = traderState.position
        ? thesisAge({ holdingSeconds: traderState.position.holdingSeconds,
                      horizon: traderState.originalThesis?.horizon })
        : { stale: false };

    return {
        action,
        downgraded: action !== proposal.action,
        riskReward: rr,
        edge,
        expectedValue: ev,
        opportunityCost: opportunityCost({
            notionalPaise: entryPaise && proposal.quantity ? entryPaise * proposal.quantity : null,
            portfolio: traderState.risk, limits,
        }),
        thesisAge: age,
        reasons,
    };
};
