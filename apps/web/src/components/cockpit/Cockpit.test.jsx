import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import { StatusBar, StandbyBanner } from "./StatusBar.jsx";
import ReasoningStream from "./ReasoningStream.jsx";
import { CurrentThought, Positions, OrderLifecycle, SystemHealth, MarketWorld, Account }
    from "./Panels.jsx";

import { rupees, percent, duration, clockTime, text, UNKNOWN } from "./format.js";

// The cockpit's rendering contract.
//
// Two things are tested harder than anything else: that a value the system does
// not have renders as UNKNOWN rather than as a plausible number, and that a
// quiet market renders as quiet rather than as activity.

afterEach(cleanup);

const event = (over = {}) => ({
    seq: 1, at: "2026-08-31T04:30:00.000Z", kind: "DECISION",
    category: "REASONING", ...over,
});

describe("absent values are shown as absent", () => {
    it("never turns a missing number into a real-looking one", () => {
        for (const value of [null, undefined, NaN, "not a number"]) {
            expect(rupees(value)).toBe(UNKNOWN);
            expect(percent(value)).toBe(UNKNOWN);
            expect(duration(value)).toBe(UNKNOWN);
        }
        expect(clockTime(null)).toBe(UNKNOWN);
        expect(clockTime("garbage")).toBe(UNKNOWN);
    });

    it("formats real values in rupees from integer paise", () => {
        expect(rupees(142_500)).toBe("₹1,425.00");
        expect(rupees(0)).toBe("₹0.00");
    });

    it("reports UNKNOWN confidence rather than inventing one", () => {
        render(<ReasoningStream events={[event({
            kind: "DECISION", action: "HOLD", confidence: undefined,
            confidenceBasis: [] })]} showObservations />);
        expect(screen.getByText(/confidence UNKNOWN/)).toBeTruthy();
    });
});

describe("a quiet market looks quiet", () => {
    it("says it is waiting rather than showing motion", () => {
        render(<StandbyBanner
            snapshot={{ world: { session: "OPEN" }, narration: { brain: "IDLE" },
                        health: { connection: { trusted: true } } }}
            events={[]} />);
        expect(screen.getByText(/WAITING FOR MATERIAL CHANGE/)).toBeTruthy();
    });

    it("says the market is closed when it is", () => {
        render(<StandbyBanner
            snapshot={{ world: { session: "CLOSED" }, narration: { brain: "IDLE" } }}
            events={[]} />);
        expect(screen.getByText(/MARKET CLOSED/)).toBeTruthy();
    });

    it("makes a stale feed impossible to miss", () => {
        render(<StandbyBanner
            snapshot={{ world: { session: "OPEN" }, narration: { brain: "IDLE" },
                        health: { connection: { trusted: false } } }}
            events={[]} />);
        expect(screen.getByText(/FEED STALE/)).toBeTruthy();
    });

    // A stopped trader must never render as an armed one.
    it("makes a stopped trader impossible to miss", () => {
        render(<StandbyBanner events={[]} snapshot={{
            agentRunning: false, agentReason: "the agent is not running",
            world: { session: "OPEN" }, narration: { brain: "IDLE" } }} />);
        expect(screen.getByText(/TRADER NOT RUNNING/)).toBeTruthy();
        expect(screen.getByText(/npm run agent/)).toBeTruthy();
    });

    it("reports risk as STOPPED, not ARMED, when the trader is down", () => {
        render(<StatusBar events={[]} connected snapshot={{
            agentRunning: false, world: { session: "OPEN" },
            narration: { brain: "IDLE", counters: {} },
            health: { connection: { state: "CONNECTED", trusted: true },
                      newExposurePermitted: true } }} />);
        // Brain, fast plane and risk all read STOPPED; none reads ARMED.
        expect(screen.getAllByText("STOPPED").length).toBeGreaterThanOrEqual(2);
        expect(screen.queryByText("ARMED")).toBeNull();
    });

    it("makes a halt impossible to miss", () => {
        render(<StandbyBanner
            snapshot={{ world: { session: "OPEN", halted: true }, narration: {} }}
            events={[]} />);
        expect(screen.getByText(/HALTED/)).toBeTruthy();
    });

    it("explains an empty stream instead of showing a blank panel", () => {
        render(<ReasoningStream events={[]} showObservations={false} />);
        expect(screen.getByText(/No reasoning yet this session/)).toBeTruthy();
        expect(screen.getByText(/quiet screen is a quiet market/)).toBeTruthy();
    });

    it("reports the trader as not reasoning when it is not", () => {
        render(<CurrentThought narration={{ brain: "IDLE", currentThought: null }} />);
        expect(screen.getByText(/Observing — not reasoning/)).toBeTruthy();
    });
});

describe("the status bar cannot imply real money", () => {
    const snapshot = {
        world: { session: "OPEN", queueDepth: 2 },
        narration: { brain: "THINKING", counters: { reasoningCalls: 4 } },
        health: { connection: { state: "CONNECTED", trusted: true },
                  newExposurePermitted: true },
        runtime: { fastPlane: { mode: "shadow" } },
    };

    it("always shows PAPER MODE", () => {
        render(<StatusBar snapshot={snapshot} events={[]} connected />);
        expect(screen.getByText("PAPER MODE")).toBeTruthy();
    });

    it("reports the real session, feed, brain and risk state", () => {
        render(<StatusBar snapshot={snapshot} events={[]} connected />);
        expect(screen.getByText("OPEN")).toBeTruthy();
        expect(screen.getByText("CONNECTED")).toBeTruthy();
        expect(screen.getByText("THINKING")).toBeTruthy();
        expect(screen.getByText("ARMED")).toBeTruthy();
        expect(screen.getByText("SHADOW")).toBeTruthy();
    });

    it("shows a stale feed as STALE even while the socket is connected", () => {
        render(<StatusBar events={[]} connected snapshot={{
            ...snapshot,
            health: { connection: { state: "CONNECTED", trusted: false } } }} />);
        expect(screen.getByText("STALE")).toBeTruthy();
    });

    it("shows RECONNECTING when the stream drops", () => {
        render(<StatusBar snapshot={snapshot} events={[]} connected={false} />);
        expect(screen.getByText("RECONNECTING")).toBeTruthy();
    });
});

describe("the reasoning stream renders the real artifacts", () => {
    const sequence = [
        event({ seq: 1, kind: "MARKET_EVENT", symbol: "RELIANCE", severity: "WARNING",
                type: "PRICE_JUMP", reason: "moved 2.40% within 60s" }),
        event({ seq: 2, kind: "MATERIALITY", material: true,
                verdict: "reasoning required", because: "WARNING on a position route" }),
        event({ seq: 3, kind: "REASONING_STARTED", symbol: "RELIANCE",
                trigger: "PRICE_JUMP", because: "moved 2.40% within 60s", route: "POSITION" }),
        event({ seq: 4, kind: "WHAT_I_KNOW", symbol: "RELIANCE", regime: "TREND_UP",
                evidence: [
                    { tier: "FACT", statement: "price 1425", source: "tick", value: null },
                    { tier: "OBSERVATION", statement: "volume 3.7x baseline",
                      source: "anomaly", value: "3.7" }] }),
        event({ seq: 5, kind: "THESIS_FORMED", symbol: "RELIANCE",
                thesis: "continuation above VWAP", setup: "vwap_reclaim",
                supportingEvidence: ["holding above VWAP"],
                contradictingEvidence: ["volume fading"],
                invalidationConditions: ["close below VWAP"] }),
        event({ seq: 6, kind: "THESIS_CHALLENGED", symbol: "RELIANCE",
                verdict: "THESIS_WEAK", strongestObjection: "breadth does not confirm",
                counterThesis: "low-liquidity drift that mean-reverts" }),
        event({ seq: 7, kind: "ALTERNATIVES", alternatives: ["index beta", "one large order"] }),
        event({ seq: 8, kind: "WHAT_WOULD_CHANGE_MY_MIND",
                conditions: ["VWAP reclaimed on rising volume"] }),
        event({ seq: 9, kind: "SYNTHESIS", riskReward: { ratio: 2.4 },
                edge: { verdict: "INSUFFICIENT" }, costHurdleBps: 73.55,
                reasons: ["edge below the cost hurdle"] }),
        event({ seq: 10, kind: "DECISION", action: "HOLD", confidence: "LOW",
                confidenceBasis: ["challenge judged the thesis weak"] }),
        event({ seq: 11, kind: "RISK_DECISION", decision: "ALLOW", reason: "within limits" }),
    ];

    it("renders every stage of a real decision", () => {
        render(<ReasoningStream events={sequence} showObservations />);
        for (const title of ["MARKET CHANGE", "MATERIALITY CHECK",
                             "SENIOR TRADER AWAKENED", "THE FACTS",
                             "THE THESIS", "THE CHALLENGE",
                             "ALTERNATIVE EXPLANATIONS", "WHAT WOULD CHANGE MY MIND?",
                             "THE SYNTHESIS", "FINAL ACTION", "RISK GATE"]) {
            expect(screen.getByText(title)).toBeTruthy();
        }
    });

    it("shows the counter-thesis and the contradicting evidence", () => {
        render(<ReasoningStream events={sequence} showObservations />);
        expect(screen.getByText("low-liquidity drift that mean-reverts")).toBeTruthy();
        expect(screen.getByText("volume fading")).toBeTruthy();
    });

    it("labels evidence with the tier the system assigned it", () => {
        render(<ReasoningStream events={sequence} showObservations />);
        expect(screen.getByText("FACT")).toBeTruthy();
        expect(screen.getByText("OBSERVATION")).toBeTruthy();
    });

    it("shows the cost hurdle beside the risk-reward", () => {
        render(<ReasoningStream events={sequence} showObservations />);
        expect(screen.getByText("73.55 bps")).toBeTruthy();
        expect(screen.getByText("2.40")).toBeTruthy();
    });

    it("hides the quiet observation heartbeat unless asked for", () => {
        const withHeartbeat = [...sequence,
            event({ seq: 12, kind: "MARKET_OBSERVATION", observed: 200, positions: 1 })];
        const { rerender } = render(
            <ReasoningStream events={withHeartbeat} showObservations={false} />);
        expect(screen.queryByText("MARKET OBSERVATION")).toBeNull();
        rerender(<ReasoningStream events={withHeartbeat} showObservations />);
        expect(screen.getByText("MARKET OBSERVATION")).toBeTruthy();
    });

    it("states plainly that a protective action consulted no model", () => {
        render(<ReasoningStream showObservations events={[event({
            seq: 20, kind: "PROTECTIVE_EVENT", symbol: "RELIANCE", kindLabel: "STOP",
            pricePaise: 97_000, levelPaise: 98_000,
            because: "a level the thesis pre-committed to was crossed" })]} />);
        expect(screen.getByText(/the thesis pre-committed to this/)).toBeTruthy();
    });

    it("states that the system does not trade on absent data", () => {
        render(<ReasoningStream showObservations events={[event({
            seq: 21, kind: "STALE_DATA", symbols: ["RELIANCE"], armed: 1 })]} />);
        expect(screen.getByText(/does not trade on absent data/)).toBeTruthy();
    });
});

describe("positions keep the original thesis separate from current belief", () => {
    it("flags a position that has no thesis at all", () => {
        render(<Positions positions={[{
            symbol: "RELIANCE", quantity: 10, entryPricePaise: 100_000,
            currentPricePaise: 98_000, unrealisedPnlPaise: -20_000,
            holdingSeconds: 600, hasThesis: false }]} />);
        expect(screen.getByText(/NO THESIS/)).toBeTruthy();
    });

    it("says flat rather than showing an empty table", () => {
        render(<Positions positions={[]} />);
        expect(screen.getByText(/Flat\. No open positions\./)).toBeTruthy();
    });
});

describe("the order lifecycle uses the real state machine", () => {
    it("marks the states an order has actually reached", () => {
        render(<OrderLifecycle openOrders={[{
            id: 1, symbol: "RELIANCE", side: "BUY", quantity: 10, filledQuantity: 4,
            pricePaise: 100_000, state: "PARTIALLY_FILLED" }]} todaysOrders={[]} />);
        const reached = document.querySelectorAll(".ck-lifecycle li.ck-reached");
        expect([...reached].map((li) => li.textContent))
            .toEqual(["NEW", "ACCEPTED", "WORKING", "PARTIALLY_FILLED"]);
    });

    it("shows a terminal state without a fake progress track", () => {
        render(<OrderLifecycle openOrders={[]} todaysOrders={[{
            id: 2, symbol: "TCS", side: "SELL", quantity: 5, filledQuantity: 0,
            pricePaise: 300_000, state: "REJECTED" }]} />);
        expect(screen.getByText(/terminal state/)).toBeTruthy();
        expect(document.querySelectorAll(".ck-lifecycle").length).toBe(0);
    });
});

describe("system health reports what is actually known", () => {
    it("shows UNKNOWN when there is no health payload at all", () => {
        render(<SystemHealth snapshot={{}} />);
        expect(screen.getByText(UNKNOWN)).toBeTruthy();
    });

    it("reports a connected but untrusted feed as stale", () => {
        render(<SystemHealth snapshot={{
            at: "2026-08-31T04:30:00.000Z",
            health: { connection: { state: "CONNECTED", trusted: false },
                      boot: { dependencies: { database: true, redis: true } } },
            runtime: { fastPlane: { mode: "off" }, reflex: { armedSymbols: 1 } } }} />);
        const row = screen.getByText("Fyers feed").closest("tr");
        expect(within(row).getByText("stale")).toBeTruthy();
    });
});

describe("the world panel", () => {
    it("says no observation has completed rather than showing an empty table", () => {
        render(<MarketWorld world={{ session: "PRE_MARKET", symbols: [] }} />);
        expect(screen.getByText(/No observation pass has completed/)).toBeTruthy();
    });
});

// ---- the persistent account -------------------------------------------------

const accountState = (over = {}) => ({
    mode: "PAPER", startingCapitalPaise: 100_000_000,
    openedAt: "2026-08-24T03:45:00.000Z",
    cashPaise: 98_320_400, marginUsedPaise: 1_675_600, positionValuePaise: 8_478_000,
    equityPaise: 101_200_000, realisedPnlPaise: 1_250_000, unrealisedPnlPaise: 54_000,
    costsPaise: 6_000, totalPnlPaise: 1_200_000, settledOrders: 6,
    openingAdjustmentPaise: 0,
    openingEquityPaise: 100_900_000, todayPnlPaise: 300_000,
    positions: [{ symbol: "OLAELEC", quantity: 2000, avgPricePaise: 4189,
                  lastPricePaise: 4216, priced: true }],
    fullyPriced: true,
    reconciliation: { ok: true, driftPaise: 0, checks: [
        { name: "ledger", ok: true }, { name: "no duplicate orders", ok: true }] },
    sessions: [{ session_date: "2026-08-31", opening_cash_paise: 98_320_400,
                 closing_cash_paise: 98_320_400, realised_pnl_paise: 0,
                 orders_placed: 1, decisions_made: 12 }],
    ...over,
});

describe("the persistent account", () => {
    it("shows equity, cash and both sides of P&L against the starting capital", () => {
        render(<Account account={accountState()} />);
        expect(screen.getByText("₹10,12,000.00")).toBeTruthy();          // equity
        expect(screen.getByText("₹9,83,204.00")).toBeTruthy();           // cash
        expect(screen.getByText("+₹12,500.00")).toBeTruthy();            // realised
        expect(screen.getByText("+₹540.00")).toBeTruthy();               // unrealised
        expect(screen.getByText(/opened at ₹10,00,000.00/)).toBeTruthy();
    });

    it("says the account did not reconcile rather than showing a tidy number", () => {
        render(<Account account={accountState({
            reconciliation: { ok: false, driftPaise: -5000, checks: [
                { name: "ledger", ok: false }] } })} />);
        expect(screen.getByText(/DID NOT RECONCILE: ledger/)).toBeTruthy();
        expect(screen.getByText(/drift −₹50.00/)).toBeTruthy();
    });

    it("flags an unpriced position instead of valuing it at nothing", () => {
        render(<Account account={accountState({ fullyPriced: false })} />);
        expect(screen.getByText("a position could not be priced")).toBeTruthy();
    });

    it("says how much of the realised P&L predates the record", () => {
        render(<Account account={accountState({ openingAdjustmentPaise: -89_700 })} />);
        expect(screen.getByText("−₹897.00 predates this record")).toBeTruthy();
    });

    it("does not colour an unknown figure as a gain", () => {
        const { container } = render(
            <Account account={accountState({ unrealisedPnlPaise: null })} />);
        const unknown = [...container.querySelectorAll(".ck-money-value")]
            .find((el) => el.textContent === UNKNOWN);
        expect(unknown).toBeTruthy();
        expect(unknown.className).toBe("ck-money-value");
    });

    it("reports an absent account as absent", () => {
        render(<Account account={null} />);
        expect(screen.getByText(`Account state ${UNKNOWN}.`)).toBeTruthy();
    });
});

// ---- values that are not what the renderer expected -------------------------
//
// Every field in the reasoning stream comes from a model response. A shape that
// drifts by one level — {condition: "..."} where a string was expected — does
// not print badly in React, it throws, and the whole cockpit goes white in
// front of whoever is watching.

describe("a value of the wrong shape never breaks the screen", () => {
    it("reads the sentence out of an object", () => {
        expect(text({ statement: "price reclaimed VWAP" })).toBe("price reclaimed VWAP");
        expect(text({ condition: "a close back under" })).toBe("a close back under");
        expect(text({ verdict: "CLEARS_COSTS", ratio: 1.8 })).toBe("CLEARS_COSTS");
    });

    it("joins a list of objects rather than rendering one", () => {
        expect(text([{ statement: "a" }, { statement: "b" }])).toBe("a; b");
    });

    it("falls back to UNKNOWN rather than printing an object", () => {
        expect(text({ nested: { deep: 1 } })).toBe(UNKNOWN);
        expect(text({})).toBe(UNKNOWN);
        expect(text(null)).toBe(UNKNOWN);
        expect(text("   ")).toBe(UNKNOWN);
    });

    it("renders a thesis whose lists arrived as objects", () => {
        render(<ReasoningStream showObservations events={[event({
            seq: 1, kind: "THESIS_FORMED", symbol: "TCS",
            thesis: { statement: "reclaimed VWAP on real volume" },
            setup: "vwap reclaim",
            supportingEvidence: [{ statement: "volume 3x baseline" }],
            contradictingEvidence: ["late in the session"],
            invalidationConditions: [{ condition: "a close back under VWAP" }],
        })]} />);
        expect(screen.getByText("reclaimed VWAP on real volume")).toBeTruthy();
        expect(screen.getByText("volume 3x baseline")).toBeTruthy();
        expect(screen.getByText("a close back under VWAP")).toBeTruthy();
    });
});

// ---- the phases of the trader's cycle are distinguishable -------------------

describe("each block says where in the cycle it belongs", () => {
    const stageOf = (over) => {
        const { container } = render(<ReasoningStream showObservations
            events={[event(over)]} />);
        return container.querySelector(".ck-stage")?.textContent;
    };

    it("labels observation, thinking, decision, risk, order, fill and position", () => {
        expect(stageOf({ kind: "MARKET_OBSERVATION" })).toBe("OBSERVING");
        expect(stageOf({ kind: "THESIS_FORMED" })).toBe("THINKING");
        expect(stageOf({ kind: "DECISION", action: "BUY", confidenceBasis: [] }))
            .toBe("DECISION");
        expect(stageOf({ kind: "RISK_DECISION", decision: "ALLOW" })).toBe("RISK");
        expect(stageOf({ kind: "ORDER_STATE_CHANGED", side: "BUY", state: "WORKING" }))
            .toBe("ORDER");
        expect(stageOf({ kind: "FILL", state: "FILLED", filledQuantity: 10, quantity: 10 }))
            .toBe("FILLED");
        expect(stageOf({ kind: "REASSESSMENT", action: "HOLD" })).toBe("POSITION");
        expect(stageOf({ kind: "PROTECTIVE_EVENT", crossing: "STOP" })).toBe("PROTECT");
    });

    it("shows a BUY decision as its own action, not as prose", () => {
        render(<ReasoningStream showObservations events={[event({
            kind: "DECISION", action: "BUY", confidence: "HIGH",
            quantity: 200, confidenceBasis: ["volume confirms"] })]} />);
        expect(screen.getByText("BUY")).toBeTruthy();
        expect(screen.getByText("confidence HIGH")).toBeTruthy();
        expect(screen.getByText("200 sh")).toBeTruthy();
    });

    it("does not render a failed protective exit as a successful one", () => {
        render(<ReasoningStream showObservations events={[event({
            kind: "PROTECTIVE_EVENT", symbol: "TCS", crossing: "STOP",
            pricePaise: 297_000, failed: true,
            because: "the protective exit could not be submitted" })]} />);
        expect(screen.getByText("PROTECTIVE EXIT FAILED")).toBeTruthy();
        expect(screen.getByText(/the level stays armed/)).toBeTruthy();
    });

    it("shows an idempotent repeat as a repeat, not as a new order", () => {
        render(<ReasoningStream showObservations events={[event({
            kind: "ORDER_STATE_CHANGED", side: "SELL", quantity: 10,
            state: "FILLED", duplicate: true })]} />);
        expect(screen.getByText("ORDER · ALREADY PLACED")).toBeTruthy();
        expect(screen.getByText(/nothing was sent twice/)).toBeTruthy();
    });

    // These had no renderer at all and were dropped from the stream in silence.
    it("renders the events that used to be invisible", () => {
        render(<ReasoningStream showObservations events={[
            event({ seq: 1, kind: "HALT", state: "HALTED", because: "operator request",
                    session: "HALTED" }),
            event({ seq: 2, kind: "PROTECTION", state: "UNPROTECTED", symbols: ["TCS"],
                    positions: [{ symbol: "TCS", reason: "no open thesis" }],
                    because: "these positions carry capital with no level protecting them" }),
            event({ seq: 3, kind: "POSITION_CHANGED", symbol: "TCS", quantity: 10,
                    entryPricePaise: 300_000, currentPricePaise: 306_000,
                    unrealisedPnlPaise: 60_000 }),
        ]} />);
        expect(screen.getByText("HALTED BY THE OPERATOR")).toBeTruthy();
        expect(screen.getByText("POSITIONS WITH NO PROTECTION")).toBeTruthy();
        expect(screen.getByText("TCS — no open thesis")).toBeTruthy();
        expect(screen.getByText("+₹600.00")).toBeTruthy();
    });
});

// ---- the account is the headline -------------------------------------------

describe("the account is readable at a glance", () => {
    it("leads with equity and today's P&L", () => {
        render(<Account account={accountState()} />);
        expect(screen.getByText("₹10,12,000.00")).toBeTruthy();   // equity
        expect(screen.getByText("+₹3,000.00")).toBeTruthy();      // today
        expect(screen.getByText(/from ₹10,09,000.00 at the open/)).toBeTruthy();
    });

    it("says so when the day has no opening figure yet", () => {
        render(<Account account={accountState({ todayPnlPaise: null,
                                                openingEquityPaise: null })} />);
        expect(screen.getByText("no opening figure recorded yet")).toBeTruthy();
    });

    it("shows previous sessions, so it is plainly not a fresh account", () => {
        render(<Account account={accountState({ sessions: [
            { session_date: "2026-09-01", opening_cash_paise: 98_320_400,
              closing_cash_paise: 98_320_400, realised_pnl_paise: 0,
              orders_placed: 1, decisions_made: 12 },
            { session_date: "2026-08-31", closing_cash_paise: 98_000_000,
              realised_pnl_paise: -50_000 },
            { session_date: "2026-08-28", closing_cash_paise: 98_050_000,
              realised_pnl_paise: 125_000 },
        ] })} />);
        expect(screen.getByText("Previous sessions")).toBeTruthy();
        expect(screen.getByText("2026-08-31")).toBeTruthy();
        expect(screen.getByText("−₹500.00")).toBeTruthy();
        expect(screen.getByText("+₹1,250.00")).toBeTruthy();
    });
});

// A candidate the analyser declined to reason about.
//
// It used to render as a completed pass — "BACK TO OBSERVING · null · no order"
// — which reads like a decision that concluded nothing, not like a symbol the
// trader deliberately did not spend a decision on.

describe("a skipped candidate reads as a skip", () => {
    it("says it was considered and not reasoned about, and why", () => {
        render(<ReasoningStream showObservations events={[event({
            kind: "REASONING_FINISHED", symbol: "TATASTEEL", action: null,
            executed: false, skipped: "reasoned about recently; nothing new to price",
        })]} />);
        expect(screen.getByText("CONSIDERED, NOT REASONED ABOUT")).toBeTruthy();
        expect(screen.getByText("reasoned about recently; nothing new to price")).toBeTruthy();
    });

    it("still renders a real completed pass as one", () => {
        render(<ReasoningStream showObservations events={[event({
            kind: "REASONING_FINISHED", symbol: "TATASTEEL", action: "HOLD",
            executed: false })]} />);
        expect(screen.getByText("BACK TO OBSERVING")).toBeTruthy();
        expect(screen.getByText("HOLD")).toBeTruthy();
        expect(screen.getByText("no order")).toBeTruthy();
    });
});
