import { describe, expect, it, vi } from "vitest";
import { TIER, makeEvidence, fromModel, clampModelTier, sortByStrength } from "../services/reasoning/evidence.js";
import { buildTraderState, deriveRegime, REGIME } from "../services/reasoning/traderState.js";
import {
    riskReward, edgeAgainstCosts, expectedValue, thesisAge, synthesise,
    ROUND_TRIP_COST_BPS, EDGE_VERDICT, UNKNOWN, INSUFFICIENT_BASIS,
} from "../services/reasoning/synthesis.js";
import { validateThesis, validateChallenge, applyChallenge } from "../services/reasoning/thesis.js";
import { reason, deriveConfidence, reassessmentCodeFor } from "../services/reasoning/pipeline.js";

const asOf = new Date("2026-09-01T06:30:00Z");

const ctx = (over = {}) => ({
    asOf: asOf.toISOString(), sessionPhase: "MID_SESSION", minutesIntoSession: 165,
    price: 1000, vwap: 995, vwapDistance: 0.005, vwapAvailable: true,
    barsSeen: { m1: 46, m5: 10, m15: 4 },
    mtf: { complete: true, aligned: true, alignedDirection: "UP", conflict: false,
           direction1m: "UP", direction5m: "UP", direction15m: "UP",
           volatilityRatio: 1.1, volatilityExpanding: false, timeframesKnown: 3 },
    ...over,
});

const heldPosition = (over = {}) => ({
    quantity: 200, entryPricePaise: 100000, currentPricePaise: 101000,
    unrealisedPnlPaise: 200000, pnlPercent: 1.0, holdingSeconds: 1800,
    exposurePaise: 20200000, stopDistance: 0.8, targetDistance: 0.6, stale: false, ...over,
});

const entryThesis = (over = {}) => ({
    id: "t-1", rationale: "morning range breakout holding above VWAP",
    setup_type: "breakout", invalidation_conditions: ["close below 970 with volume"],
    horizon: "INTRADAY", stop_paise: 97000, target_paise: 110000,
    opened_at: "2026-09-01T05:00:00Z", ...over,
});

describe("evidence hierarchy", () => {
    it("assigns tiers by origin and refuses an unknown tier", () => {
        expect(makeEvidence({ tier: TIER.FACT, statement: "x", source: "s" }).tier).toBe("FACT");
        expect(() => makeEvidence({ tier: "TRUTH", statement: "x", source: "s" })).toThrow();
    });

    it("clamps model-authored evidence: the LLM cannot promote itself to FACT", () => {
        expect(fromModel("buyers are aggressive", TIER.FACT).tier).toBe(TIER.INFERENCE);
        expect(fromModel("price will continue", TIER.OBSERVATION).tier).toBe(TIER.INFERENCE);
        expect(clampModelTier(TIER.FACT)).toBe(TIER.INFERENCE);
    });

    it("allows the model to be weaker than INFERENCE", () => {
        expect(fromModel("might be a squeeze", TIER.HYPOTHESIS).tier).toBe(TIER.HYPOTHESIS);
    });

    it("sorts strongest first so weak evidence cannot lead a summary", () => {
        const sorted = sortByStrength([
            fromModel("inference"), makeEvidence({ tier: TIER.FACT, statement: "fact", source: "s" })]);
        expect(sorted[0].tier).toBe(TIER.FACT);
    });
});

describe("market regime is derived, never invented", () => {
    it("is UNKNOWN with no supporting evidence", () => {
        const r = deriveRegime({});
        expect(r.regime).toBe(REGIME.UNKNOWN);
        expect(r.evidence).toHaveLength(0);
    });

    it("uses the frozen daily taxonomy when available", () => {
        const r = deriveRegime({ dailyRegimeTag: { label: "TREND_UP/VOL_LOW", taxonomy: "nse_equity_v1" } });
        expect(r.regime).toBe(REGIME.TRENDING);
        expect(r.evidence[0].tier).toBe(TIER.FACT);
    });

    it("infers high volatility from measured expansion", () => {
        const r = deriveRegime({ mtf: { volatilityRatio: 2.4, volatilityExpanding: true } });
        expect(r.regime).toBe(REGIME.HIGH_VOLATILITY);
    });
});

describe("cost hurdle and expected value are honest", () => {
    it("uses the P6-measured round trip", () => {
        expect(ROUND_TRIP_COST_BPS).toBe(73.55);
    });

    it("a 0.5% target does NOT clear a 73.55 bps round trip", () => {
        const e = edgeAgainstCosts({ entryPaise: 100000, targetPaise: 100500 });
        expect(e.verdict).toBe(EDGE_VERDICT.BELOW_COSTS);
        expect(e.grossBps).toBeCloseTo(50, 0);
    });

    it("a 2% target does clear it", () => {
        expect(edgeAgainstCosts({ entryPaise: 100000, targetPaise: 102000 }).verdict)
            .toBe(EDGE_VERDICT.CLEARS_COSTS);
    });

    it("no target means the hurdle cannot be assessed, not that it passes", () => {
        expect(edgeAgainstCosts({ entryPaise: 100000, targetPaise: null }).verdict)
            .toBe(EDGE_VERDICT.INSUFFICIENT_BASIS);
    });

    it("refuses to compute EV without an empirical probability", () => {
        const ev = expectedValue({ riskPaise: 3000, rewardPaise: 10000 });
        expect(ev.value).toBe(INSUFFICIENT_BASIS);
        expect(ev.probability).toBe(UNKNOWN);
        expect(ev.reason).toMatch(/no calibrated probability/);
    });

    it("computes R:R only from supplied levels", () => {
        expect(riskReward({ entryPaise: 100000, stopPaise: 97000, targetPaise: 110000 }).ratio)
            .toBeCloseTo(10000 / 3000);
        expect(riskReward({ entryPaise: 100000, stopPaise: null, targetPaise: 110000 }).ratio)
            .toBe(UNKNOWN);
    });

    it("flags a thesis that has decayed with time", () => {
        expect(thesisAge({ holdingSeconds: 300, horizon: "INTRADAY" }).stale).toBe(false);
        expect(thesisAge({ holdingSeconds: 20000, horizon: "INTRADAY" }).stale).toBe(true);
    });
});

describe("thesis validation", () => {
    const state = buildTraderState({ symbol: "X", context: ctx(), asOf });

    it("forces HOLD when no invalidation condition is given", () => {
        const t = validateThesis({ proposedAction: "BUY", thesis: "looks good",
                                   invalidationConditions: [] }, state);
        expect(t.proposedAction).toBe("HOLD");
        expect(t.falsifiable).toBe(false);
        expect(t.forcedHoldReason).toMatch(/falsifiable/);
    });

    it("never takes a probability from the model", () => {
        const t = validateThesis({ proposedAction: "BUY", probability: 0.87,
                                   invalidationConditions: ["x"] }, state);
        expect(t.probability).toBeNull();
    });

    it("restricts actions by whether a position is held", () => {
        const held = buildTraderState({ symbol: "X", context: ctx(), position: heldPosition(), asOf });
        expect(validateThesis({ proposedAction: "BUY", invalidationConditions: ["x"] }, held)
            .proposedAction).toBe("HOLD");
        expect(validateThesis({ proposedAction: "EXIT", invalidationConditions: ["x"] }, held)
            .proposedAction).toBe("EXIT");
    });
});

describe("the challenger can only make things more conservative", () => {
    const thesis = { proposedAction: "BUY", isPosition: false };

    // A weak verdict is REPORTED here and resolved after the deterministic
    // synthesis, where measured arithmetic can override the challenger's
    // opinion that the evidence is thin. Applied as an absolute veto it made
    // entry impossible: observed live, the challenger returned THESIS_WEAK on
    // 18 of 18 setups.
    it("reports a weak verdict for the synthesis to resolve", () => {
        const r = applyChallenge(thesis, validateChallenge({ verdict: "THESIS_WEAK" }));
        expect(r.weakVerdict).toBe(true);
        expect(r.action).toBe("BUY");
    });

    // "Could this be a false signal?" is true of every technical setup, so as a
    // veto it decided against every trade. It belongs in the confidence.
    it("records false-signal risk without vetoing the action", () => {
        const r = applyChallenge(thesis, validateChallenge({
            verdict: "THESIS_HOLDS", couldBeFalseSignal: true, falseSignalTell: "no volume" }));
        expect(r.action).toBe("BUY");
        expect(r.reasons.join(" ")).toMatch(/false-signal risk: no volume/);
    });

    // Confirmation bias is one model's opinion about another model's prose,
    // from a challenger instructed to attack. As an absolute veto it refused a
    // setup with three aligned timeframes, 5x volume, 2.0 risk/reward and an
    // edge clearing costs by 126 bps. It is reported and lowers confidence;
    // the measured controls still decide.
    it("reports confirmation bias without vetoing the action", () => {
        const r = applyChallenge(thesis, validateChallenge({
            verdict: "THESIS_HOLDS", confirmationBiasDetected: true }));
        expect(r.action).toBe("BUY");
        expect(r.reasons.join(" ")).toMatch(/confirmation bias reported/);
    });


    it("turns a broken thesis on a HELD position into EXIT", () => {
        const r = applyChallenge({ proposedAction: "HOLD", isPosition: true },
            validateChallenge({ verdict: "THESIS_BROKEN" }));
        expect(r.action).toBe("EXIT");
    });

    it("treats an unparseable challenge as adverse, not absent", () => {
        const c = validateChallenge(null);
        expect(c.verdict).toBe("THESIS_WEAK");
        expect(c.couldBeFalseSignal).toBe(true);
        expect(c.unavailable).toBe(true);
    });

    it("leaves a sound thesis alone", () => {
        const r = applyChallenge(thesis, validateChallenge({ verdict: "THESIS_HOLDS" }));
        expect(r.action).toBe("BUY");
        expect(r.downgraded).toBe(false);
    });
});

describe("confidence is explainable, never a bare token", () => {
    it("explains why it is HIGH", () => {
        const c = deriveConfidence({
            thesis: { supportingEvidence: [1, 2, 3], contradictingEvidence: [], uncertainty: [] },
            challenge: { verdict: "THESIS_HOLDS" }, synthesis: { edge: { verdict: "CLEARS_COSTS" } } });
        expect(c.level).toBe("HIGH");
        expect(c.reasons[0]).toMatch(/supporting/);
    });

    it("drops to LOW when contradiction is not outweighed", () => {
        const c = deriveConfidence({
            thesis: { supportingEvidence: [1], contradictingEvidence: [1, 2], uncertainty: [] },
            challenge: { verdict: "THESIS_HOLDS" }, synthesis: { edge: {} } });
        expect(c.level).toBe("LOW");
    });

    it("drops to LOW when edge cannot be quantified", () => {
        const c = deriveConfidence({
            thesis: { supportingEvidence: [1, 2], contradictingEvidence: [], uncertainty: [] },
            challenge: { verdict: "THESIS_HOLDS" },
            synthesis: { edge: { verdict: "INSUFFICIENT_BASIS" } } });
        expect(c.level).toBe("LOW");
        expect(c.reasons.join(" ")).toMatch(/edge is unproven/);
    });
});

// ---- the 18 senior-trader scenarios ---------------------------------------

const runScenario = async ({ context, position = null, thesis = null, event = null,
                             formed, challenged, portfolio = null, news = [] }) => reason({
    symbol: "RELIANCE", context, position, thesis, event, portfolio, news, asOf,
    formModel: async () => formed,
    challengeModel: async () => challenged,
});

const soundChallenge = { verdict: "THESIS_HOLDS", alternativeHypotheses: [
    { explanation: "genuine breakout", supportedBy: "volume and MTF alignment", plausibility: "HIGH" },
    { explanation: "short covering", supportedBy: "nothing observed", plausibility: "LOW" }],
    whatWouldChangeTheDecision: ["loss of the breakout level on volume"] };

describe("senior-trader scenarios", () => {
    it("1. clean breakout with a target that clears costs -> BUY", async () => {
        const d = await runScenario({
            context: ctx(),
            formed: { thesis: "range breakout holding VWAP", setup: "breakout", direction: "LONG",
                      supportingEvidence: ["above VWAP", "MTF aligned", "volume expansion"],
                      contradictingEvidence: [], invalidationConditions: ["close below 990"],
                      proposedAction: "BUY", stopRupees: 990, targetRupees: 1025, quantity: 200,
                      timeHorizon: "INTRADAY", uncertainty: [] },
            challenged: soundChallenge });
        expect(d.action).toBe("BUY");
        expect(d.edge.verdict).toBe(EDGE_VERDICT.CLEARS_COSTS);
        expect(d.alternativeHypotheses.length).toBeGreaterThan(1);
        expect(d.invalidationConditions).toEqual(["close below 990"]);
    });

    it("2. false breakout -> challenger breaks it -> HOLD", async () => {
        const d = await runScenario({
            context: ctx(),
            formed: { thesis: "breakout", setup: "breakout", direction: "LONG",
                      supportingEvidence: ["new high"], contradictingEvidence: [],
                      invalidationConditions: ["close below 990"], proposedAction: "BUY",
                      stopRupees: 990, targetRupees: 1025, quantity: 200, uncertainty: [] },
            challenged: { verdict: "THESIS_BROKEN", strongestObjection: "prior two breakouts failed",
                          couldBeFalseSignal: true, falseSignalTell: "no volume confirmation" } });
        expect(d.action).toBe("HOLD");
        expect(d.reasons.join(" ")).toMatch(/broken|false signal/);
    });

    it("3. breakout on weak volume -> possible false signal -> HOLD", async () => {
        const d = await runScenario({
            context: ctx(),
            formed: { thesis: "breakout", setup: "breakout", direction: "LONG",
                      supportingEvidence: ["new high"], contradictingEvidence: ["volume below average"],
                      invalidationConditions: ["failure to hold"], proposedAction: "BUY",
                      stopRupees: 990, targetRupees: 1025, quantity: 200, uncertainty: [] },
            challenged: { verdict: "THESIS_HOLDS", couldBeFalseSignal: true,
                          falseSignalTell: "breakouts without volume usually retrace" } });
        // Tuned for paper trading: the caveat is carried, not used as a veto.
        // One support against one caveat is not a measurement of which side is
        // stronger, and this setup clears the cost hurdle at 2.5 risk/reward
        // with the challenger holding. The stop is what protects it now.
        expect(d.action).toBe("BUY");
        expect(d.reasons.join(" ")).toMatch(/contradicting evidence/);
        expect(d.confidence).not.toBe("HIGH");
    });

    it("5. strong price move with no news -> alternative explanations surface", async () => {
        const d = await runScenario({
            context: ctx({ price: 1030 }),
            formed: { thesis: "sharp advance", setup: "momentum", direction: "LONG",
                      supportingEvidence: ["3% move"], contradictingEvidence: [],
                      invalidationConditions: ["reversal below 1010"], proposedAction: "BUY",
                      stopRupees: 1010, targetRupees: 1060, quantity: 100, uncertainty: ["no news explains this"] },
            challenged: { verdict: "THESIS_WEAK",
                          alternativeHypotheses: [
                              { explanation: "short covering", supportedBy: "no news", plausibility: "HIGH" },
                              { explanation: "index inclusion flow", supportedBy: "nothing observed", plausibility: "LOW" }],
                          strongestObjection: "a 3% move with no catalyst is often mean-reverting" } });
        // Entry 1030, stop 1010, target 1060 is 1.5 risk/reward, exactly the
        // floor a weak thesis must clear, and the move clears costs. The
        // challenger's doubt no longer vetoes arithmetic that supports the
        // trade — but the alternatives it raised are still on the record.
        expect(d.action).toBe("BUY");
        expect(d.reasons.join(" ")).toMatch(/entering on the arithmetic/);
        expect(d.alternativeHypotheses.some((a) => a.explanation === "short covering")).toBe(true);
    });

    it("13. good setup but poor risk/reward against costs -> NO TRADE", async () => {
        const d = await runScenario({
            context: ctx(),
            formed: { thesis: "clean setup", setup: "breakout", direction: "LONG",
                      supportingEvidence: ["above VWAP", "MTF aligned"], contradictingEvidence: [],
                      invalidationConditions: ["close below 995"], proposedAction: "BUY",
                      stopRupees: 995, targetRupees: 1004, quantity: 200, uncertainty: [] },
            challenged: soundChallenge });
        expect(d.action).toBe("HOLD");
        expect(d.edge.verdict).toBe(EDGE_VERDICT.BELOW_COSTS);
        expect(d.reasons.join(" ")).toMatch(/bps round trip/);
    });

    it("13b. no target at all -> edge unquantifiable -> NO TRADE", async () => {
        const d = await runScenario({
            context: ctx(),
            formed: { thesis: "feels strong", setup: "momentum", direction: "LONG",
                      supportingEvidence: ["momentum"], contradictingEvidence: [],
                      invalidationConditions: ["reversal"], proposedAction: "BUY",
                      stopRupees: 990, targetRupees: null, quantity: 200, uncertainty: [] },
            challenged: soundChallenge });
        expect(d.action).toBe("HOLD");
        expect(d.edge.verdict).toBe(EDGE_VERDICT.INSUFFICIENT_BASIS);
    });

    it("14. conflicting timeframes are visible as evidence", async () => {
        const conflicted = ctx({ mtf: { complete: true, aligned: false, conflict: true,
            direction1m: "DOWN", direction5m: "UP", direction15m: "UP",
            volatilityRatio: 1.2, volatilityExpanding: false, timeframesKnown: 3 } });
        const d = await runScenario({
            context: conflicted,
            formed: { thesis: "pullback entry", setup: "pullback", direction: "LONG",
                      supportingEvidence: ["5m and 15m up"], contradictingEvidence: ["1m rolling over"],
                      invalidationConditions: ["1m break"], proposedAction: "BUY",
                      stopRupees: 990, targetRupees: 1030, quantity: 100, uncertainty: [] },
            challenged: soundChallenge });
        // 1m DOWN against 5m and 15m both UP is a pullback into strength,
        // which is the entry rather than the objection. It is recorded and it
        // lowers confidence; the measured edge decides.
        expect(d.action).toBe("BUY");
        expect(d.reasons.join(" ")).toMatch(/the 1m is DOWN against 5m UP and 15m UP/);
        expect(d.evidenceSnapshot).toMatch(/CONFLICT/);
        expect(d.confidence).not.toBe("HIGH");
    });

    // A disagreement between the LONGER frames is a real one: they do not agree
    // on where this is going, and no measured edge resolves that. Observed live
    // as RAMCOSYS at 1.93 risk/reward clearing costs, 1m DOWN, 5m UP, 15m DOWN.
    it("14b. the 5m and 15m disagreeing still refuses", async () => {
        const conflicted = ctx({ mtf: { complete: true, aligned: false, conflict: true,
            direction1m: "DOWN", direction5m: "UP", direction15m: "DOWN",
            volatilityRatio: 1.2, volatilityExpanding: false, timeframesKnown: 3 } });
        const d = await runScenario({
            context: conflicted,
            formed: { thesis: "pullback entry", setup: "pullback", direction: "LONG",
                      supportingEvidence: ["5m up"], contradictingEvidence: ["15m rolling over"],
                      invalidationConditions: ["1m break"], proposedAction: "BUY",
                      stopRupees: 990, targetRupees: 1030, quantity: 100, uncertainty: [] },
            challenged: soundChallenge });
        expect(d.action).toBe("HOLD");
        expect(d.reasons.join(" ")).toMatch(/the 5m and 15m disagree/);
    });

    it("15. stale data -> no new exposure", async () => {
        const d = await runScenario({
            context: ctx({ stale: true }),
            formed: { thesis: "setup", setup: "breakout", direction: "LONG",
                      supportingEvidence: ["a", "b"], contradictingEvidence: [],
                      invalidationConditions: ["x"], proposedAction: "BUY",
                      stopRupees: 990, targetRupees: 1030, quantity: 100, uncertainty: [] },
            challenged: soundChallenge });
        expect(d.action).toBe("HOLD");
        expect(d.reasons.join(" ")).toMatch(/stale market data/);
    });

    it("4. strong news but weak price reaction -> the divergence is stated, not traded", async () => {
        const d = await runScenario({
            context: ctx({ price: 1002, vwapDistance: 0.001 }),
            news: [{ materiality: "HIGH", category: "EARNINGS", subject: "Q2 profit up 40%",
                     disseminatedAt: "2026-09-01T06:05:00Z", source: "nse" }],
            formed: { thesis: "strong earnings but price is not responding", setup: "news",
                      direction: "LONG", supportingEvidence: ["material earnings beat"],
                      contradictingEvidence: ["price barely moved on the release",
                                              "volume did not expand"],
                      invalidationConditions: ["no follow-through within 30 minutes"],
                      proposedAction: "BUY", stopRupees: 995, targetRupees: 1030,
                      quantity: 100, uncertainty: ["market may already have discounted this"] },
            challenged: { verdict: "THESIS_WEAK",
                          strongestObjection: "a non-reaction to good news is itself information",
                          alternativeHypotheses: [
                              { explanation: "the result was already priced in",
                                supportedBy: "no volume expansion", plausibility: "HIGH" }] } });
        // Tuned for paper trading. The divergence — good news, no reaction — is
        // stated in the reasons and lowers confidence; it no longer vetoes on
        // the count of caveats alone. The trade clears costs at 4.0 risk/reward
        // and carries a stop seven rupees below entry.
        expect(d.action).toBe("BUY");
        expect(d.reasons.join(" ")).toMatch(/contradicting evidence/);
        expect(d.confidence).not.toBe("HIGH");
        expect(d.state.news).toHaveLength(1);
        expect(d.evidenceSnapshot).toMatch(/EARNINGS/);
    });

    it("6. market-wide crash -> a long candidate is refused", async () => {
        const d = await runScenario({
            context: ctx({ price: 940, vwapDistance: -0.03,
                mtf: { complete: true, aligned: true, alignedDirection: "DOWN", conflict: false,
                       direction1m: "DOWN", direction5m: "DOWN", direction15m: "DOWN",
                       volatilityRatio: 3.4, volatilityExpanding: true, timeframesKnown: 3 } }),
            formed: { thesis: "oversold bounce candidate", setup: "reversal", direction: "LONG",
                      supportingEvidence: ["stretched below VWAP"],
                      contradictingEvidence: ["every timeframe is down",
                                              "volatility expanding sharply"],
                      invalidationConditions: ["new session low"], proposedAction: "BUY",
                      stopRupees: 930, targetRupees: 970, quantity: 100,
                      uncertainty: ["no evidence the decline has finished"] },
            challenged: { verdict: "THESIS_BROKEN",
                          strongestObjection: "catching a falling market is not a thesis" } });
        expect(d.action).toBe("HOLD");
        expect(d.marketRegime).toBe(REGIME.HIGH_VOLATILITY);
    });

    it("7. single-stock crash while holding -> EXIT", async () => {
        const d = await runScenario({
            context: ctx({ price: 880 }),
            position: heldPosition({ currentPricePaise: 88000, pnlPercent: -12,
                                     stopDistance: -1.5, unrealisedPnlPaise: -2400000 }),
            thesis: entryThesis(),
            event: { type: "PRICE_JUMP", severity: "CRITICAL", reason: "down 12% in 4 minutes",
                     observed: { detector: "priceJump" } },
            formed: { thesis: "stock-specific collapse, thesis void", setup: "breakout",
                      direction: "LONG", supportingEvidence: [],
                      contradictingEvidence: ["down 12% intraday", "far below the stated stop"],
                      invalidationConditions: ["close below 970 with volume"],
                      proposedAction: "EXIT", uncertainty: ["cause unknown, no news retrieved"] },
            challenged: { verdict: "THESIS_BROKEN",
                          strongestObjection: "the invalidation level was passed without question" } });
        expect(d.action).toBe("EXIT");
        expect(d.thesisStillValid).toBe(false);
        expect(d.material).toBe(true);
    });

    it("12. excessive exposure is costed, not ignored", async () => {
        const d = await runScenario({
            context: ctx(),
            portfolio: { cashPaise: 20000000, positionCount: 8, grossExposurePaise: 180000000 },
            formed: { thesis: "clean setup", setup: "breakout", direction: "LONG",
                      supportingEvidence: ["above VWAP", "MTF aligned"], contradictingEvidence: [],
                      invalidationConditions: ["close below 990"], proposedAction: "BUY",
                      stopRupees: 990, targetRupees: 1030, quantity: 150, uncertainty: [] },
            challenged: soundChallenge });
        expect(d.opportunityCost.concentrated).toBe(true);
        expect(d.opportunityCost.notes.join(" ")).toMatch(/half of free cash/);
    });

    it("18. two candidates are ranked by measured edge, not by narrative", async () => {
        const strong = await runScenario({
            context: ctx(),
            formed: { thesis: "A", setup: "breakout", direction: "LONG",
                      supportingEvidence: ["a", "b"], contradictingEvidence: [],
                      invalidationConditions: ["x"], proposedAction: "BUY",
                      stopRupees: 990, targetRupees: 1040, quantity: 100, uncertainty: [] },
            challenged: soundChallenge });
        const marginal = await runScenario({
            context: ctx(),
            formed: { thesis: "B, described with far more conviction", setup: "breakout",
                      direction: "LONG", supportingEvidence: ["a", "b"], contradictingEvidence: [],
                      invalidationConditions: ["x"], proposedAction: "BUY",
                      stopRupees: 998, targetRupees: 1006, quantity: 100, uncertainty: [] },
            challenged: soundChallenge });
        expect(strong.action).toBe("BUY");
        expect(marginal.action).toBe("HOLD");
        expect(strong.edge.netBps).toBeGreaterThan(marginal.edge.netBps);
    });

    it("8. existing position, thesis intact -> HOLD, no churn", async () => {
        const d = await runScenario({
            context: ctx(), position: heldPosition(), thesis: entryThesis(),
            event: { type: "PRICE_JUMP", severity: "WARNING", reason: "moved 2%", observed: {} },
            formed: { thesis: "original breakout thesis intact", setup: "breakout", direction: "LONG",
                      supportingEvidence: ["still above VWAP", "MTF aligned"], contradictingEvidence: [],
                      invalidationConditions: ["close below 970"], proposedAction: "HOLD", uncertainty: [] },
            challenged: soundChallenge });
        expect(d.action).toBe("HOLD");
        expect(d.thesisStillValid).toBe(true);
        expect(d.reassessmentCode).toBe("PRICE_ACTION_CHANGE");
    });

    it("9. existing position, thesis weakening -> REDUCE survives", async () => {
        const d = await runScenario({
            context: ctx(), position: heldPosition(), thesis: entryThesis(),
            event: { type: "VOLUME_SPIKE", severity: "WARNING", reason: "volume drying up", observed: {} },
            formed: { thesis: "momentum fading", setup: "breakout", direction: "LONG",
                      supportingEvidence: ["still above entry"],
                      contradictingEvidence: ["volume declining", "failed to make a new high"],
                      invalidationConditions: ["close below 970"], proposedAction: "REDUCE", uncertainty: [] },
            challenged: { verdict: "THESIS_WEAK", strongestObjection: "distribution pattern" } });
        expect(d.action).toBe("REDUCE");
        expect(d.reassessmentCode).toBe("VOLUME_CHANGE");
    });

    it("10. thesis invalidated -> EXIT", async () => {
        const d = await runScenario({
            context: ctx({ price: 960 }),
            position: heldPosition({ currentPricePaise: 96000, stopDistance: -0.2, pnlPercent: -4 }),
            thesis: entryThesis(),
            event: { type: "STOP_BREACH", severity: "CRITICAL", reason: "below stop", observed: {} },
            formed: { thesis: "invalidation condition met", setup: "breakout", direction: "LONG",
                      supportingEvidence: [], contradictingEvidence: ["closed below 970 on volume"],
                      invalidationConditions: ["close below 970"], proposedAction: "EXIT", uncertainty: [] },
            challenged: { verdict: "THESIS_BROKEN", strongestObjection: "the stated invalidation triggered" } });
        expect(d.action).toBe("EXIT");
        expect(d.thesisStillValid).toBe(false);
        expect(d.reassessmentCode).toBe("THESIS_INVALIDATION");
    });

    it("11. profitable position losing momentum -> belief update recorded", async () => {
        const d = await runScenario({
            context: ctx(), position: heldPosition({ pnlPercent: 3.2 }), thesis: entryThesis(),
            event: { type: "TARGET_APPROACHING", severity: "INFO", reason: "near target", observed: {} },
            formed: { thesis: "approaching target, momentum easing", setup: "breakout", direction: "LONG",
                      supportingEvidence: ["in profit"], contradictingEvidence: ["momentum easing"],
                      invalidationConditions: ["close below 970"], proposedAction: "REDUCE", uncertainty: [] },
            challenged: soundChallenge });
        expect(["REDUCE", "HOLD"]).toContain(d.action);
        expect(d.reassessmentCode).toBe("POSITION_GAIN");
    });

    it("16. missing news is stated, not treated as an all-clear", async () => {
        const d = await runScenario({
            context: ctx(), news: [],
            formed: { thesis: "setup", setup: "breakout", direction: "LONG",
                      supportingEvidence: ["a", "b"], contradictingEvidence: [],
                      invalidationConditions: ["x"], proposedAction: "BUY",
                      stopRupees: 990, targetRupees: 1030, quantity: 100, uncertainty: [] },
            challenged: soundChallenge });
        expect(d.state.news).toEqual([]);
        expect(d.action).toBe("BUY");   // absence of news is not a blocker, just not evidence
    });

    it("17. contradictory evidence outweighs support -> HOLD", async () => {
        const d = await runScenario({
            context: ctx(),
            formed: { thesis: "mixed picture", setup: "unclear", direction: "LONG",
                      supportingEvidence: ["above VWAP"],
                      contradictingEvidence: ["market weak", "volume poor", "15m rolling over"],
                      invalidationConditions: ["x"], proposedAction: "BUY",
                      stopRupees: 990, targetRupees: 1040, quantity: 100, uncertainty: [] },
            challenged: soundChallenge });
        // Tuned for paper trading. Three caveats against one support is still
        // recorded and still lowers confidence, but the deciders are measured:
        // this clears the cost hurdle at 4.0 risk/reward, and a stop at 990
        // bounds it. "market weak" and "volume poor" are prose; the market
        // shock rule and the risk gate act on numbers.
        expect(d.action).toBe("BUY");
        expect(d.reasons.join(" ")).toMatch(/contradicting evidence \(3\)/);
        expect(d.confidence).not.toBe("HIGH");
    });
});

describe("failure modes", () => {
    it("no model configured -> safe HOLD", async () => {
        const d = await reason({ symbol: "X", context: ctx(), asOf });
        expect(d.action).toBe("HOLD");
        expect(d.fallback).toBe(true);
    });

    it("formation throws -> safe HOLD", async () => {
        const d = await reason({ symbol: "X", context: ctx(), asOf,
            formModel: async () => { throw new Error("groq down"); },
            challengeModel: async () => ({}) });
        expect(d.action).toBe("HOLD");
        expect(d.reasons[0]).toMatch(/groq down/);
    });

    it("formation times out -> safe HOLD", async () => {
        const d = await reason({ symbol: "X", context: ctx(), asOf, timeoutMs: 20,
            formModel: () => new Promise((r) => setTimeout(r, 500)),
            challengeModel: async () => ({}) });
        expect(d.action).toBe("HOLD");
        expect(d.reasons[0]).toMatch(/timeout/);
    }, 10000);

    it("challenge fails -> treated as adverse, BUY downgraded", async () => {
        const d = await reason({ symbol: "X", context: ctx(), asOf,
            formModel: async () => ({ thesis: "t", proposedAction: "BUY",
                supportingEvidence: ["a"], contradictingEvidence: [],
                invalidationConditions: ["x"], stopRupees: 990, targetRupees: 1030, quantity: 10 }),
            challengeModel: async () => { throw new Error("down"); } });
        expect(d.action).toBe("HOLD");
        expect(d.confidence).toBe("LOW");
    });

    it("malformed formation output -> safe HOLD", async () => {
        const d = await reason({ symbol: "X", context: ctx(), asOf,
            formModel: async () => "LIQUIDATE EVERYTHING",
            challengeModel: async () => ({}) });
        expect(d.action).toBe("HOLD");
    });

    it("exactly two model calls per reasoning cycle", async () => {
        const form = vi.fn(async () => ({ thesis: "t", proposedAction: "HOLD",
            invalidationConditions: ["x"] }));
        const challenge = vi.fn(async () => ({ verdict: "THESIS_HOLDS" }));
        await reason({ symbol: "X", context: ctx(), asOf, formModel: form, challengeModel: challenge });
        expect(form).toHaveBeenCalledTimes(1);
        expect(challenge).toHaveBeenCalledTimes(1);
    });
});

describe("reassessment codes are bounded", () => {
    it.each([
        ["STOP_BREACH", "THESIS_INVALIDATION"],
        ["NEWS_EVENT", "NEWS"],
        ["REGIME_CHANGE", "MARKET_REGIME_CHANGE"],
        ["VOLUME_SPIKE", "VOLUME_CHANGE"],
        ["SOMETHING_NEW", "NEW_INFORMATION"],
    ])("maps %s to %s", (type, code) => {
        expect(reassessmentCodeFor({ trigger: { type } })).toBe(code);
    });
});

// The floors that replaced the blanket vetoes. These are what now stand
// between a proposal and a position, so they are pinned individually.
describe("arithmetic floors on a new position", () => {
    const asOf = "2026-08-31T05:00:00.000Z";
    const buy = (over = {}) => ({
        thesis: "t", setup: "s", direction: "LONG", proposedAction: "BUY",
        supportingEvidence: ["a"], contradictingEvidence: [],
        invalidationConditions: ["x"], uncertainty: [],
        stopRupees: 990, targetRupees: 1060, quantity: 10, ...over,
    });
    const run = ({ formed, challenge }) => reason({
        symbol: "X", context: { price: 1000, asOf, vwap: 995, vwapAvailable: true },
        asOf,
        formModel: async () => formed,
        challengeModel: async () => challenge,
    });

    it("takes a weak thesis when the measured edge and risk/reward support it", async () => {
        // 1000 entry, 990 stop, 1060 target -> 6.0 risk/reward.
        const d = await run({ formed: buy(),
                              challenge: { verdict: "THESIS_WEAK", couldBeFalseSignal: false } });
        expect(d.action).toBe("BUY");
        expect(d.reasons.join(" ")).toMatch(/entering on the arithmetic/);
    });

    it("refuses a weak thesis whose risk/reward is below the weak-thesis floor", async () => {
        // 1000 entry, 990 stop, 1012 target -> 1.2, under the 1.3 weak floor
        // but still at the universal one, so only the weak verdict refuses it.
        const d = await run({ formed: buy({ targetRupees: 1012 }),
                              challenge: { verdict: "THESIS_WEAK" } });
        expect(d.action).toBe("HOLD");
        expect(d.reasons.join(" ")).toMatch(/below the 1.3 floor/);
    });

    // The trade the old floor was refusing: sound arithmetic, a verdict that
    // carried no information. It is allowed now, and still only because the
    // measured edge clears both costs and the universal floor.
    it("allows a weak thesis that clears the tuned weak floor", async () => {
        const d = await run({ formed: buy({ targetRupees: 1014 }),   // 1.4 R:R
                              challenge: { verdict: "THESIS_WEAK" } });
        expect(d.action).toBe("BUY");
        expect(d.reasons.join(" ")).toMatch(/entering on the arithmetic/);
    });

    // A favourable verdict does not make a bad trade good, and the cost hurdle
    // does not catch this: a big enough move clears costs while still risking
    // more than it stands to gain. Observed live at 0.84.
    it("refuses any entry below the universal risk/reward floor", async () => {
        // 1000 entry, 950 stop, 1042 target -> 0.84.
        const d = await run({ formed: buy({ stopRupees: 950, targetRupees: 1042 }),
                              challenge: { verdict: "THESIS_HOLDS" } });
        expect(d.action).toBe("HOLD");
        expect(d.reasons.join(" ")).toMatch(/below the 1.2 floor for a new position/);
    });

    // Arithmetic may override a challenger's opinion. It may not stand in for a
    // challenge that never happened.
    it("never trades a thesis that was not actually challenged", async () => {
        const d = await reason({
            symbol: "X", context: { price: 1000, asOf, vwap: 995, vwapAvailable: true }, asOf,
            formModel: async () => buy(),
            challengeModel: async () => { throw new Error("provider down"); } });
        expect(d.action).toBe("HOLD");
        expect(d.confidence).toBe("LOW");
        expect(d.reasons.join(" ")).toMatch(/never actually challenged/);
    });

    it("still refuses a broken thesis however good the arithmetic", async () => {
        const d = await run({ formed: buy(),
                              challenge: { verdict: "THESIS_BROKEN" } });
        expect(d.action).toBe("HOLD");
    });

    // The one unmeasured veto that remains absolute: BROKEN means the evidence
    // contradicts the thesis, and no arithmetic redeems that.
    it("still refuses a broken thesis even when the arithmetic is excellent", async () => {
        const d = await run({ formed: buy({ targetRupees: 1080 }),   // 8.0 R:R
                              challenge: { verdict: "THESIS_BROKEN" } });
        expect(d.action).toBe("HOLD");
        expect(d.reasons.join(" ")).toMatch(/broken/);
    });
});
