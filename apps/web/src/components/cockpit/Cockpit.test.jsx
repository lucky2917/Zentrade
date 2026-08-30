import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import { StatusBar, StandbyBanner } from "./StatusBar.jsx";
import ReasoningStream from "./ReasoningStream.jsx";
import { CurrentThought, Positions, OrderLifecycle, SystemHealth, MarketWorld }
    from "./Panels.jsx";
import { rupees, percent, duration, clockTime, UNKNOWN } from "./format.js";

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
                             "SENIOR TRADER AWAKENED", "WHAT DO I KNOW?",
                             "INITIAL THESIS", "CHALLENGING THE THESIS",
                             "ALTERNATIVE EXPLANATIONS", "WHAT WOULD CHANGE MY MIND?",
                             "DETERMINISTIC SYNTHESIS", "DECISION", "RISK GATE"]) {
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
