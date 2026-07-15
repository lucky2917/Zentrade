import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import DecisionDetail from "./DecisionDetail.jsx";

/**
 * M10 component fixtures. Three properties under test:
 *  1. FIDELITY   — the page shows journal strings verbatim, nothing invented
 *  2. XSS SAFETY — hostile journal content renders inert (text, not markup)
 *  3. CITATIONS  — every claim's refs are visible and wired to evidence
 */

vi.mock("../services/api.js", () => ({ default: { get: vi.fn() } }));
import api from "../services/api.js";

const XSS = `<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script>`;

const chainFixture = {
    decision: {
        decisionId: "d1",
        requestId: "r1",
        instrument: { instrumentId: "i1", venue: "NSE", symbol: "RELIANCE", currency: "INR" },
        action: "BUY",
        mode: "INTRADAY",
        confidence: "MEDIUM",
        entryMinor: 152050,
        targetMinor: 153850,
        stopMinor: 151400,
        synthesizerVersion: "v4.1.0",
        correlationId: "corr-1",
        createdAt: "2026-07-15T10:00:00.000Z",
    },
    rationale: {
        traderNote: `Gap-up held above VWAP ${XSS}`,
        reasoning: ["Setup above OR high", "Sentiment supportive"],
        consensus: "majority",
        macroScore: 1,
    },
    request: {
        requestId: "r1",
        requestedBy: "api",
        correlationId: "corr-1",
        contextSnapshot: { price: 1518.4, inputsHash: "a".repeat(64), marketOpen: true },
        regime: { taxonomy: "none", label: "unlabeled" },
        createdAt: "2026-07-15T10:00:00.000Z",
    },
    agentRuns: [
        {
            runId: "run1",
            agentName: "technical",
            agentVersion: "v4.1.0",
            modelId: "llama-3.3-70b-versatile",
            inputHash: "b".repeat(64),
            output: { signal: "BULLISH", confidence: "HIGH", keyPoints: [{ point: `RSI 61 momentum ${XSS}`, refs: ["ind:rsi14"] }] },
            status: "ok",
            citationReport: { status: "ok", uncitedCount: 0, unknownRefs: [] },
            latencyMs: 812,
            promptTokens: 900,
            completionTokens: 120,
            costUsd: 0.000626,
            createdAt: "2026-07-15T10:00:01.000Z",
        },
        {
            runId: "run2",
            agentName: "sentiment",
            agentVersion: "v4.1.0",
            modelId: "llama-3.1-8b-instant",
            inputHash: "c".repeat(64),
            output: { sentiment: "NEUTRAL", keyPoints: [{ point: "uncited claim", refs: ["ghost:ref"] }] },
            status: "invalid",
            citationReport: { status: "invalid", uncitedCount: 0, unknownRefs: ["ghost:ref"] },
            latencyMs: 300,
            promptTokens: 200,
            completionTokens: 40,
            costUsd: 0.00002,
            createdAt: "2026-07-15T10:00:02.000Z",
        },
    ],
    evidence: [
        {
            evidenceId: "e1",
            ref: "ind:rsi14",
            kind: "indicator",
            sourceRef: "fyers:candles:D:365",
            content: { rsi14: 61.2 },
            weight: null,
            createdAt: "2026-07-15T10:00:00.000Z",
        },
        {
            evidenceId: "e2",
            ref: "news:1",
            kind: "news",
            sourceRef: "finnhub:company-news",
            content: { headline: `Reliance rallies ${XSS}`, source: "wire" },
            weight: null,
            createdAt: "2026-07-15T10:00:00.000Z",
        },
    ],
    myOrders: [
        { orderId: 7, side: "BUY", quantity: 3, priceMinor: 151992, totalValueMinor: 455976, brokerageMinor: 2000, pnlMinor: null, mode: "DELIVERY", createdAt: "2026-07-15T10:05:00.000Z" },
    ],
};

const renderPage = () =>
    render(
        <MemoryRouter initialEntries={["/decision/d1"]}>
            <Routes>
                <Route path="/decision/:id" element={<DecisionDetail />} />
            </Routes>
        </MemoryRouter>,
    );

beforeEach(() => {
    api.get.mockReset();
    delete window.__pwned;
});

// vitest runs with globals:false, so RTL's automatic cleanup never registers —
// without this, DOM piles up across tests and id lookups hit stale nodes
afterEach(cleanup);

describe("DecisionDetail — journal fidelity", () => {
    it("renders decision, rationale, runs, evidence and linked trades verbatim", async () => {
        api.get.mockResolvedValue({ data: chainFixture });
        renderPage();

        await waitFor(() => expect(screen.getByText("RELIANCE")).toBeDefined());
        expect(api.get).toHaveBeenCalledWith("/decisions/d1");

        // decision header: exact journal values, formatted-not-recomputed levels
        expect(screen.getByText("BUY")).toBeDefined();
        expect(screen.getByText(/₹1,520\.50/)).toBeDefined(); // 152050 minor
        expect(screen.getByText(/pipeline v4\.1\.0/)).toBeDefined();

        // rationale strings appear exactly as stored
        expect(screen.getByText("Setup above OR high")).toBeDefined();
        expect(screen.getByText(/consensus: majority/)).toBeDefined();
        expect(screen.getByText(/regime: none:unlabeled/)).toBeDefined();

        // runs: model ids, statuses, verdicts, costs — verbatim
        expect(screen.getByText("llama-3.3-70b-versatile")).toBeDefined();
        expect(screen.getAllByText("invalid").length).toBeGreaterThan(0);
        expect(screen.getByText("$0.000626")).toBeDefined();

        // evidence content shown as stored JSON
        expect(screen.getByText(/"rsi14": 61\.2/)).toBeDefined();
        expect(screen.getByText("fyers:candles:D:365")).toBeDefined();

        // linked trade
        expect(screen.getByText(/BUY 3 @ ₹1,519\.92/)).toBeDefined();

        // nothing invented: no totals/summaries the journal doesn't contain
        expect(screen.queryByText(/total cost/i)).toBeNull();
        expect(screen.queryByText(/summary/i)).toBeNull();
    });

    it("renders a 404 state without inventing content", async () => {
        api.get.mockRejectedValue({ response: { status: 404 } });
        renderPage();
        await waitFor(() => expect(screen.getByText("Decision not found")).toBeDefined());
    });
});

describe("DecisionDetail — XSS safety", () => {
    it("hostile journal content renders as inert text, never as markup", async () => {
        api.get.mockResolvedValue({ data: chainFixture });
        const { container } = renderPage();
        await waitFor(() => expect(screen.getAllByText("RELIANCE").length).toBeGreaterThan(0));

        // the payload strings are VISIBLE as text (fidelity)…
        expect(screen.getAllByText((t) => t.includes("Gap-up held above VWAP <img")).length).toBeGreaterThan(0);

        // …but never became elements, and never executed
        expect(container.querySelector("img[src='x']")).toBeNull();
        expect(container.querySelector("script")).toBeNull();
        expect(window.__pwned).toBeUndefined();
    });
});

describe("DecisionDetail — citation visibility", () => {
    it("claims show their refs; known refs jump to evidence, unknown refs are flagged", async () => {
        api.get.mockResolvedValue({ data: chainFixture });
        const { container } = renderPage();
        await waitFor(() => expect(screen.getAllByText("RELIANCE").length).toBeGreaterThan(0));

        // known ref pill exists and targets the evidence card
        const refPill = screen.getAllByText("ind:rsi14").find((el) => el.tagName === "BUTTON");
        expect(refPill).toBeDefined();
        const target = container.querySelector("#evidence-ind\\:rsi14");
        expect(target).not.toBeNull();
        target.scrollIntoView = vi.fn();
        fireEvent.click(refPill);
        expect(target.scrollIntoView).toHaveBeenCalled();
        expect(target.classList.contains("xai-flash")).toBe(true);

        // the invalid run's unknown ref is visibly flagged as not-in-bundle
        const ghost = screen.getByText("ghost:ref");
        expect(ghost.className).toContain("xai-ref-unknown");
    });
});
