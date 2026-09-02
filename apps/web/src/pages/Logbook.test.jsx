import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup, within } from "@testing-library/react";
import Logbook from "./Logbook.jsx";

// The logbook page shows the persisted session record and nothing else.
//
// Three properties matter. It renders every kind of record the backend stores,
// not only the ones that became trades. It shows what the system actually
// wrote, verbatim, and marks a missing value as unknown instead of printing a
// plausible substitute. And journal text is content, never markup.

vi.mock("../services/api.js", () => ({ default: { get: vi.fn() } }));
import api from "../services/api.js";

const XSS = `<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script>`;

const log = {
    sessionDate: "2026-09-02",
    availableDates: ["2026-09-02", "2026-09-01"],
    summary: { session_date: "2026-09-02", realised_pnl_paise: "-587460" },
    sessions: [
        { session_date: "2026-09-02", opening_cash_paise: "99392540",
          closing_cash_paise: "89422940", opening_equity_paise: "99392540",
          closing_equity_paise: "99386540", realised_pnl_paise: "-587460",
          unrealised_pnl_paise: "-4000", costs_paise: "2000", orders_placed: 1,
          positions_opened: 1, positions_closed: 0, decisions_made: 22 },
        { session_date: "2026-09-01", opening_cash_paise: "99482240",
          closing_cash_paise: "99392540", opening_equity_paise: "99482240",
          closing_equity_paise: "99392540", realised_pnl_paise: "0",
          unrealised_pnl_paise: "0", costs_paise: "4000", orders_placed: 3,
          positions_opened: 2, positions_closed: 1, decisions_made: 370 },
    ],
    counts: { decisions: 2, modelCalls: 1, marketEvents: 1, orders: 1, fills: 1,
              theses: 1, reassessments: 1, agentEvents: 1 },
    returned: { decisions: 2, modelCalls: 1, marketEvents: 1, orders: 1, fills: 1,
                theses: 1, reassessments: 1, agentEvents: 1 },
    truncated: [],
    decisions: [{
        decisionId: "d-1", correlationId: "c-1", symbol: "NAUKRI", route: "CANDIDATE",
        action: "BUY", confidence: "HIGH",
        trigger: { type: "screen", severity: "CRITICAL", reason: "volume 8.2x median" },
        evidence: [
            { tier: "FACT", source: "volume", value: 8.2,
              statement: "last minute traded 8.2x its 60-bar median volume" },
            { tier: "INFERENCE", source: "mtf", value: null,
              statement: "1m UP, 5m UP, 15m UP" },
        ],
        thesis: "Participation confirms the breakout.",
        supporting: ["volume confirms"], contradicting: ["extended from VWAP"],
        counterThesis: "Late entry into a spent move.",
        alternatives: ["wait for a pullback"],
        whatWouldChange: ["a 1m close back below VWAP"],
        challengeVerdict: "THESIS_HOLDS",
        synthesis: { proposedAction: "BUY", riskReward: { ratio: 2 }, edge: null,
                     setupType: "momentum", horizon: "INTRADAY",
                     stopPaise: 136000, targetPaise: 137650, entryGates: ["hold VWAP"] },
        risk: { decision: "ALLOW", code: "CLEARS_COSTS", reason: "expected move clears costs" },
        executed: true, blockedReason: null, pricePaise: 136590, quantity: 366,
        at: "2026-09-02T04:20:00.000Z",
    }, {
        decisionId: "d-2", correlationId: "c-2", symbol: "IFCI", route: "CANDIDATE",
        action: "HOLD", confidence: "LOW",
        trigger: { type: "screen", severity: null, reason: XSS },
        evidence: [], thesis: XSS, supporting: [], contradicting: [],
        counterThesis: null, alternatives: [], whatWouldChange: [],
        challengeVerdict: null, synthesis: {}, risk: null,
        executed: false, blockedReason: null, pricePaise: null, quantity: null,
        at: "2026-09-02T04:10:00.000Z",
    }],
    modelCalls: [{ decisionId: "d-1", symbol: "NAUKRI", agent: "senior_thesis_formation",
                   model: "openai/gpt-oss-120b", status: "failed", latencyMs: 0,
                   promptTokens: null, completionTokens: null,
                   error: "Groq API error 429", at: "2026-09-02T04:19:00.000Z" }],
    marketEvents: [{ key: "k1", type: "VOLUME_SPIKE", severity: "CRITICAL", symbol: "DPABHUSHAN",
                     reason: "volume 9.9x the 59-bar median", observed: { ratio: 9.9 },
                     state: "HANDLED", attempts: 0, lastError: null,
                     at: "2026-09-02T04:05:00.000Z", handledAt: "2026-09-02T04:05:30.000Z" }],
    orders: [{ id: 11, symbol: "NAUKRI", type: "BUY", status: "FILLED", quantity: 366,
               filledQuantity: 366, pricePaise: 136590, at: "2026-09-02T04:20:05.000Z" }],
    fills: [{ orderId: 11, symbol: "NAUKRI", quantity: 366, pricePaise: 136590,
              at: "2026-09-02T04:20:06.000Z" }],
    theses: [{ id: "t-1", symbol: "NAUKRI", side: "BUY", setupType: "Volume-spike breakout",
               horizon: "INTRADAY", quantity: 366,
               rationale: "Participation confirms the breakout above VWAP.",
               invalidationConditions: ["a close back below VWAP"],
               entryPricePaise: 136590, stopPaise: 136000, targetPaise: 137650,
               openedAt: "2026-09-02T04:20:07.000Z", closedAt: null,
               at: "2026-09-02T04:20:07.000Z" }],
    reassessments: [{ symbol: "NAUKRI", action: "HOLD", confidence: "MEDIUM",
                      thesisStillValid: true, whatChanged: "drifted toward stop",
                      material: false,
                      reasoning: "The stock still holds above VWAP with volume intact, "
                        + "so the original breakout thesis has not been invalidated.",
                      risk: { decision: "ALLOW", reason: null }, executed: false,
                      currentPricePaise: 136400,
                      unrealisedPnlPaise: -4000, holdingSeconds: 900,
                      at: "2026-09-02T04:35:00.000Z" }],
    agentEvents: [{ kind: "AGENT_START", detail: { pid: 29239 },
                    at: "2026-09-02T04:00:00.000Z" }],
};

describe("logbook page", () => {
    beforeEach(() => { api.get.mockReset(); api.get.mockResolvedValue({ data: log }); });
    afterEach(() => { cleanup(); vi.clearAllTimers(); });

    it("shows every kind of record the session persisted", async () => {
        render(<Logbook />);
        await screen.findAllByText("NAUKRI");

        for (const kind of ["decision", "model call", "market", "order", "fill",
                            "thesis", "reassessment", "agent"]) {
            expect(screen.getAllByText(new RegExp(kind, "i")).length).toBeGreaterThan(0);
        }
        expect(screen.getByText("DPABHUSHAN")).toBeTruthy();
        expect(screen.getByText(/9\.9x the 59-bar median/)).toBeTruthy();
    });

    it("keeps the reasoning behind a decision that was never executed", async () => {
        render(<Logbook />);
        const ifci = await screen.findByText("IFCI");

        // The declined candidate is present as a row, not filtered out.
        expect(ifci).toBeTruthy();
        expect(screen.getAllByText(/HOLD/).length).toBeGreaterThan(0);
    });

    it("opens a decision and shows the full chain that produced it", async () => {
        render(<Logbook />);
        await screen.findAllByText("NAUKRI");
        const row = [...document.querySelectorAll(".lb-row.lb-decision")]
            .find((el) => el.textContent.includes("NAUKRI"));
        fireEvent.click(row.querySelector(".lb-head"));

        await waitFor(() => expect(
            screen.getByText("Participation confirms the breakout.")).toBeTruthy());
        expect(screen.getByText(/8\.2x its 60-bar median volume/)).toBeTruthy();
        expect(screen.getByText("Late entry into a spent move.")).toBeTruthy();
        expect(screen.getByText("a 1m close back below VWAP")).toBeTruthy();
        expect(screen.getByText("extended from VWAP")).toBeTruthy();
        expect(screen.getByText(/CLEARS_COSTS/)).toBeTruthy();
        expect(screen.getByText("FACT")).toBeTruthy();
        expect(screen.getByText("INFERENCE")).toBeTruthy();
    });

    it("counts the session, including model calls that failed", async () => {
        render(<Logbook />);
        await screen.findAllByText("NAUKRI");

        const header = document.querySelector(".lb-stats");
        expect(within(header).getByText("failed")).toBeTruthy();
        expect(within(header).getByText("2")).toBeTruthy();   // two decisions
    });

    it("filters by lane and by search text", async () => {
        render(<Logbook />);
        await screen.findByText("DPABHUSHAN");

        const lanes = document.querySelector(".lb-lanes");
        fireEvent.click(within(lanes).getByText(/Market/));
        await waitFor(() => expect(screen.queryByText("DPABHUSHAN")).toBeTruthy());
        expect(screen.queryByText("IFCI")).toBeNull();

        fireEvent.click(within(lanes).getByText(/Everything/));
        fireEvent.change(document.querySelector(".lb-search"), { target: { value: "ifci" } });
        await waitFor(() => expect(screen.queryByText("DPABHUSHAN")).toBeNull());
        expect(screen.getByText("IFCI")).toBeTruthy();
    });

    it("renders journal text as content, never as markup", async () => {
        render(<Logbook />);
        const ifci = await screen.findByText("IFCI");
        fireEvent.click(ifci.closest("button"));

        await waitFor(() => expect(screen.getAllByText(XSS).length).toBeGreaterThan(0));
        expect(document.querySelector("img[src=x]")).toBeNull();
        expect(window.__pwned).toBeUndefined();
    });

    it("says so when the session is empty instead of showing a broken frame", async () => {
        api.get.mockResolvedValue({ data: {
            sessionDate: "2026-09-02", availableDates: [], summary: null,
            sessions: [], counts: null, returned: {}, truncated: [],
            decisions: [], modelCalls: [], marketEvents: [], orders: [],
            fills: [], theses: [], reassessments: [], agentEvents: [] } });
        render(<Logbook />);
        await waitFor(() => expect(document.querySelector(".lb-empty")).toBeTruthy());
    });

    it("shows the session ledger, one stored row per trading day", async () => {
        render(<Logbook />);
        await screen.findAllByText("NAUKRI");

        const ledger = document.querySelector(".lb-ledger");
        expect(ledger).toBeTruthy();
        expect(within(ledger).getByText("2026-09-01")).toBeTruthy();
        // The day being read is marked in the ledger.
        expect(ledger.querySelector(".lb-tr-on td").textContent).toBe("2026-09-02");
        expect(within(ledger).getByText("370")).toBeTruthy();
    });

    it("counts what is stored, not what it happened to load", async () => {
        api.get.mockResolvedValue({ data: {
            ...log,
            counts: { ...log.counts, marketEvents: 1026 },
            returned: { ...log.returned, marketEvents: 500 },
            truncated: ["marketEvents"],
        } });
        render(<Logbook />);
        await screen.findAllByText("NAUKRI");

        const tally = document.querySelector(".lb-tally");
        // The real size of the day, and an admission that it was cut short.
        expect(within(tally).getByText("1,026")).toBeTruthy();
        expect(within(tally).getByText(/showing 500/)).toBeTruthy();
        expect(within(tally).getByText(/larger than one read/)).toBeTruthy();
    });

    it("says plainly when the whole session is on the page", async () => {
        render(<Logbook />);
        await screen.findAllByText("NAUKRI");
        expect(document.querySelector(".lb-tally").textContent)
            .toMatch(/Every stored row for this session is on this page/);
    });

    it("requests the whole session rather than a first page", async () => {
        render(<Logbook />);
        await screen.findAllByText("NAUKRI");
        expect(api.get.mock.calls[0][1].params.limit).toBe(5000);
    });

    it("says when it opened on an earlier session than today", async () => {
        api.get.mockResolvedValue({ data: { ...log, today: "2026-09-03" } });
        render(<Logbook />);
        await screen.findAllByText("NAUKRI");
        expect(document.querySelector(".lb-stale").textContent)
            .toMatch(/nothing stored yet for 2026-09-03/);
    });

    it("shows no stale notice when reading the current session", async () => {
        api.get.mockResolvedValue({ data: { ...log, today: "2026-09-02" } });
        render(<Logbook />);
        await screen.findAllByText("NAUKRI");
        expect(document.querySelector(".lb-stale")).toBeNull();
    });

    // Every stored record opens, not only decisions. The reasoning behind a
    // position already held is the longest prose the system keeps, and it used to
    // be truncated to a headline.
    it("opens a reassessment and shows its full reasoning", async () => {
        render(<Logbook />);
        await screen.findAllByText("NAUKRI");
        const row = [...document.querySelectorAll(".lb-row.lb-reassessment")][0];
        fireEvent.click(row.querySelector(".lb-head"));

        await waitFor(() => expect(
            within(row).getByText(/original breakout thesis has not been invalidated/))
            .toBeTruthy());
        expect(row.querySelector(".lb-body").textContent).toMatch(/still holds/);
    });

    it("opens a thesis and shows why the position exists", async () => {
        render(<Logbook />);
        await screen.findAllByText("NAUKRI");
        const row = [...document.querySelectorAll(".lb-row.lb-thesis")][0];
        fireEvent.click(row.querySelector(".lb-head"));

        await waitFor(() => expect(
            within(row).getByText(/Participation confirms the breakout/)).toBeTruthy());
        expect(within(row).getByText("a close back below VWAP")).toBeTruthy();
    });

    it("opens a market event and shows what it measured", async () => {
        render(<Logbook />);
        await screen.findAllByText("DPABHUSHAN");
        const row = [...document.querySelectorAll(".lb-row.lb-market_event")][0];
        fireEvent.click(row.querySelector(".lb-head"));

        await waitFor(() => expect(within(row).getByText("Ratio")).toBeTruthy());
        expect(within(row).getByText("9.9")).toBeTruthy();
    });

    it("shows a decision the model calls it paid for", async () => {
        render(<Logbook />);
        await screen.findAllByText("NAUKRI");
        const row = [...document.querySelectorAll(".lb-row.lb-decision")]
            .find((el) => el.textContent.includes("NAUKRI"));
        fireEvent.click(row.querySelector(".lb-head"));

        // The failed formation call is linked to d-1 and must appear with it.
        await waitFor(() => expect(within(row).getByText(/What it cost/)).toBeTruthy());
        expect(within(row).getByText(/senior thesis formation/)).toBeTruthy();
        expect(within(row).getByText(/Groq API error 429/)).toBeTruthy();
    });

    it("shows the funnel and what the reasoning cost", async () => {
        render(<Logbook />);
        await screen.findAllByText("NAUKRI");
        const funnel = document.querySelector(".lb-funnel");
        expect(within(funnel).getByText("market events")).toBeTruthy();
        expect(within(funnel).getByText("executed")).toBeTruthy();
        expect(within(funnel).getByText("tokens spent")).toBeTruthy();
        expect(within(funnel).getByText("calls failed")).toBeTruthy();
    });

    it("reports an unavailable logbook rather than rendering nothing", async () => {
        api.get.mockRejectedValue({ response: { status: 503 } });
        render(<Logbook />);
        await screen.findByText(/Logbook unavailable/);
    });
});
