import { describe, expect, it, beforeEach, vi } from "vitest";
import { setFeedTracker, feedIsTrusted } from "../services/fyers/feedStatus.js";
import { readable, list } from "../services/cockpit/reasoningNarration.js";

// REST is a backstop, not a second market-data path.
//
// Three pollers were fetching quotes and depth for the same 200 symbols the
// websocket was already streaming. The depth lane alone ran 20 calls every 15
// seconds — 80 a minute against a 180/minute ceiling and a 9,600/day depth
// budget, which it spends in two hours. Then "request limit reached" arrives
// and the backstop is gone exactly when it would be needed.

beforeEach(() => setFeedTracker(null));

describe("the feed registry", () => {
    it("treats an unknown feed as untrusted, so the backstop runs", () => {
        expect(feedIsTrusted()).toBe(false);
    });

    it("reports the tracker's answer without creating a second tracker", () => {
        setFeedTracker({ isTrusted: () => true });
        expect(feedIsTrusted()).toBe(true);
        setFeedTracker({ isTrusted: () => false });
        expect(feedIsTrusted()).toBe(false);
    });

    it("survives a tracker that throws rather than taking the poller down", () => {
        setFeedTracker({ isTrusted: () => { throw new Error("boom"); } });
        expect(feedIsTrusted()).toBe(false);
    });
});

describe("the pollers stand down while the socket is delivering", () => {
    const read = async (f) => {
        const { readFileSync } = await import("node:fs");
        const { join } = await import("node:path");
        return readFileSync(join(process.cwd(), f), "utf8");
    };

    it("the market worker and the slow lane both check the feed first", async () => {
        expect(await read("src/services/marketWorker.js")).toMatch(/if \(feedIsTrusted\(\)\) return;/);
        expect(await read("src/services/fyers/laneManager.js"))
            .toMatch(/if \(feedIsTrusted\(\)\) \{/);
    });

    // Depth is not on the socket, so skipping it would lose data rather than
    // save budget.
    it("depth and history still run regardless of the feed", async () => {
        const rest = await read("src/services/fyers/fyersREST.js");
        expect(rest).toMatch(/callEssential\(\(\) => fyers\.getMarketDepth/);
        expect(rest).toMatch(/callEssential\(\(\) => fyers\.getHistory/);
        expect(rest).toMatch(/call\(\(\) => fyers\.getQuotes/);
    });

    // The interval and the declared budget used to contradict each other.
    it("the depth interval fits the depth budget", async () => {
        const lanes = await read("src/services/fyers/laneManager.js");
        const interval = Number(lanes.match(/DEPTH_LANE_INTERVAL_MS = (\d+)/)[1]);
        const batch = Number(lanes.match(/DEPTH_BATCH_SIZE = (\d+)/)[1]);
        const { DEPTH_BUDGET } = await import("../services/fyers/rateLimiter.js");

        const cyclesPerSession = (375 * 60_000) / interval;
        const callsPerSession = cyclesPerSession * batch * 2;   // two batches a cycle
        expect(callsPerSession).toBeLessThanOrEqual(DEPTH_BUDGET);
    });

    it("a REST failure cannot escape into a cron callback", async () => {
        // These run on timers with no caller to catch them, so a single
        // ETIMEDOUT became an uncaught exception and exited the process.
        const rest = await read("src/services/fyers/fyersREST.js");
        expect(rest).toMatch(/try \{[\s\S]*getRateLimiter\(\)\.schedule[\s\S]*\} catch \(err\)/);
        expect(rest).toMatch(/return null;/);
    });

    it("the slow lane stops instead of grinding through every batch", async () => {
        const lanes = await read("src/services/fyers/laneManager.js");
        expect(lanes).toMatch(/MAX_CONSECUTIVE_FAILURES/);
        expect(lanes).toMatch(/consecutiveFailures \+= 1/);
    });
});

describe("the cockpit renders reasoning, not [object Object]", () => {
    it("reads an evidence record and keeps its tier", () => {
        expect(readable({ tier: "INFERENCE", statement: "buyers are aggressive",
                          source: "llm" }))
            .toBe("[INFERENCE] buyers are aggressive");
    });

    it("reads an alternative hypothesis with what supports it", () => {
        expect(readable({ explanation: "index-driven beta",
                          supportedBy: "market breadth", plausibility: "MEDIUM" }))
            .toBe("index-driven beta — supported by market breadth (MEDIUM)");
    });

    it("passes plain strings through untouched", () => {
        expect(readable("holding above VWAP")).toBe("holding above VWAP");
    });

    it("never produces [object Object] from anything", () => {
        const awkward = [{ nothing: "useful" }, {}, [], null, undefined, "", "  "];
        for (const item of awkward) {
            expect({ item, out: readable(item) }).not.toMatchObject({ out: "[object Object]" });
        }
        expect(list(awkward)).toEqual([]);
    });

    it("renders a mixed array the way the model actually produces it", () => {
        expect(list([
            { tier: "INFERENCE", statement: "price holding above VWAP" },
            { explanation: "short covering", supportedBy: "volume shape",
              plausibility: "LOW" },
            "breadth is flat",
            { unusable: true },
        ])).toEqual([
            "[INFERENCE] price holding above VWAP",
            "short covering — supported by volume shape (LOW)",
            "breadth is flat",
        ]);
    });
});
