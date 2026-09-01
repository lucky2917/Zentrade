import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup, waitFor, act } from "@testing-library/react";
import useCockpit from "./useCockpit.js";

// The live connection.
//
// A refresh must not lose the session, a reconnect must not render an event
// twice, and a burst must not stall the browser.

const handlers = {};
const emitted = [];
const socket = {
    on: (name, fn) => { handlers[name] = fn; },
    emit: (name, payload) => emitted.push({ name, payload }),
    close: vi.fn(),
};
vi.mock("socket.io-client", () => ({ io: () => socket }));

const get = vi.fn();
vi.mock("../services/api.js", () => ({ default: { get: (...a) => get(...a) } }));

const Probe = ({ onState }) => {
    const state = useCockpit();
    onState(state);
    return null;
};

const snapshotBody = (seq, events) => ({
    data: { at: "2026-08-31T04:30:00.000Z", mode: "PAPER",
            narration: { seq, events, brain: "IDLE", counters: {} },
            world: {}, positions: [], openOrders: [], todaysOrders: [] } });

const event = (seq) => ({ seq, at: "2026-08-31T04:30:00.000Z",
                          kind: "MARKET_EVENT", category: "MARKET", symbol: `S${seq}` });

beforeEach(() => {
    for (const key of Object.keys(handlers)) delete handlers[key];
    emitted.length = 0;
    get.mockReset();
    globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
    globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
});
afterEach(cleanup);

describe("a refresh rebuilds the whole screen", () => {
    it("loads the snapshot, then resumes streaming from its sequence", async () => {
        get.mockResolvedValue(snapshotBody(3, [event(1), event(2), event(3)]));
        let state;
        render(<Probe onState={(s) => { state = s; }} />);

        await waitFor(() => expect(state.snapshot).toBeTruthy());
        expect(state.events.map((e) => e.seq)).toEqual([1, 2, 3]);

        await act(async () => { handlers.connect?.(); });
        // It tells the server exactly what it already has.
        expect(emitted.find((e) => e.name === "cockpit:hello").payload)
            .toEqual({ since: 3 });
    });

    it("surfaces an unauthenticated session instead of an empty screen", async () => {
        get.mockRejectedValue({ response: { status: 401 } });
        let state;
        render(<Probe onState={(s) => { state = s; }} />);
        await waitFor(() => expect(state.error).toMatch(/Sign in/));
    });
});

describe("no event is ever rendered twice", () => {
    it("discards a replayed backlog it already holds", async () => {
        get.mockResolvedValue(snapshotBody(3, [event(1), event(2), event(3)]));
        let state;
        render(<Probe onState={(s) => { state = s; }} />);
        await waitFor(() => expect(state.snapshot).toBeTruthy());
        await act(async () => { handlers.connect?.(); });

        // The server replays from 2 — an overlap the client must absorb.
        await act(async () => {
            handlers["cockpit:backlog"]({ events: [event(2), event(3), event(4)] });
            await new Promise((r) => setTimeout(r, 10));
        });

        expect(state.events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    });

    it("ignores a live event that arrives out of order", async () => {
        get.mockResolvedValue(snapshotBody(5, [event(5)]));
        let state;
        render(<Probe onState={(s) => { state = s; }} />);
        await waitFor(() => expect(state.snapshot).toBeTruthy());
        await act(async () => { handlers.connect?.(); });

        await act(async () => {
            handlers["cockpit:event"](event(3));
            handlers["cockpit:event"](event(6));
            await new Promise((r) => setTimeout(r, 10));
        });

        expect(state.events.map((e) => e.seq)).toEqual([5, 6]);
    });

    // A client away long enough for the ring to roll has a hole in its history.
    it("reloads rather than stitching over a gap", async () => {
        get.mockResolvedValue(snapshotBody(3, [event(3)]));
        let state;
        render(<Probe onState={(s) => { state = s; }} />);
        await waitFor(() => expect(state.snapshot).toBeTruthy());
        await act(async () => { handlers.connect?.(); });
        const before = get.mock.calls.length;

        await act(async () => {
            handlers["cockpit:backlog"]({ gap: true, events: [event(90)] });
            await new Promise((r) => setTimeout(r, 10));
        });

        expect(get.mock.calls.length).toBeGreaterThan(before);
        expect(state.events.map((e) => e.seq)).not.toContain(90);
    });
});

describe("a burst does not stall the browser", () => {
    it("coalesces many events into one render pass", async () => {
        get.mockResolvedValue(snapshotBody(0, []));
        let renders = 0;
        let state;
        render(<Probe onState={(s) => { renders += 1; state = s; }} />);
        await waitFor(() => expect(state.snapshot).toBeTruthy());
        await act(async () => { handlers.connect?.(); });

        const before = renders;
        await act(async () => {
            for (let i = 1; i <= 200; i += 1) handlers["cockpit:event"](event(i));
            await new Promise((r) => setTimeout(r, 20));
        });

        expect(state.events).toHaveLength(200);
        // Two hundred events must not cost two hundred renders.
        expect(renders - before).toBeLessThan(20);
    });

    it("bounds what it holds so a long session cannot grow without limit", async () => {
        get.mockResolvedValue(snapshotBody(0, []));
        let state;
        render(<Probe onState={(s) => { state = s; }} />);
        await waitFor(() => expect(state.snapshot).toBeTruthy());
        await act(async () => { handlers.connect?.(); });

        await act(async () => {
            for (let i = 1; i <= 900; i += 1) handlers["cockpit:event"](event(i));
            await new Promise((r) => setTimeout(r, 30));
        });

        expect(state.events.length).toBeLessThanOrEqual(600);
        expect(state.events.at(-1).seq).toBe(900);
    });
});

describe("access", () => {
    it("reports a denied stream rather than looking connected", async () => {
        get.mockResolvedValue(snapshotBody(0, []));
        let state;
        render(<Probe onState={(s) => { state = s; }} />);
        await waitFor(() => expect(state.snapshot).toBeTruthy());
        await act(async () => {
            handlers.connect?.();
            handlers["cockpit:denied"]({ reason: "authentication required" });
        });
        expect(state.connected).toBe(false);
        expect(state.error).toBe("authentication required");
    });
});

// The money on screen has to keep up.
//
// Two ways it used to fall behind. The refresh looked only at the LAST event in
// a flushed batch, so a FILL followed by an observation in the same batch left
// the cash and positions a trade out of date. And nothing emitted an event when
// a price moved, so unrealised P&L and equity froze between fills — which on a
// screen someone is watching reads as a broken number, not a quiet market.

describe("account state keeps up with the market", () => {
    const withAccount = (equityPaise, seq = 10) => ({
        data: { at: "2026-08-31T04:30:00.000Z", mode: "PAPER",
                account: { equityPaise, unrealisedPnlPaise: equityPaise - 100_000_000 },
                positions: [], openOrders: [], todaysOrders: [] } });

    const start = async (state) => {
        get.mockResolvedValueOnce(snapshotBody(5, []));
        render(<Probe onState={(s) => { state.current = s; }} />);
        await waitFor(() => expect(state.current.snapshot).toBeTruthy());
        await act(async () => { handlers.connect?.(); });
        return state;
    };

    it("refreshes on a FILL that is not the last event in its batch", async () => {
        const state = { current: null };
        await start(state);
        get.mockResolvedValueOnce(withAccount(101_000_000));

        // A fill and an observation arrive together and flush as one batch.
        await act(async () => {
            handlers["cockpit:event"]({ seq: 6, kind: "FILL", at: "2026-08-31T04:31:00.000Z" });
            handlers["cockpit:event"]({ seq: 7, kind: "MARKET_OBSERVATION",
                                        at: "2026-08-31T04:31:01.000Z" });
            await new Promise((r) => setTimeout(r, 10));
        });

        await waitFor(() => expect(state.current.snapshot.account.equityPaise)
            .toBe(101_000_000));
    });

    // Nothing announces a price move, so the observation pass is what keeps
    // unrealised P&L and equity honest.
    it("refreshes on an observation pass, so P&L does not freeze", async () => {
        const state = { current: null };
        await start(state);
        get.mockResolvedValueOnce(withAccount(100_400_000));

        await act(async () => {
            handlers["cockpit:event"]({ seq: 6, kind: "MARKET_OBSERVATION",
                                        at: "2026-08-31T04:31:00.000Z" });
            await new Promise((r) => setTimeout(r, 10));
        });

        await waitFor(() => expect(state.current.snapshot.account.unrealisedPnlPaise)
            .toBe(400_000));
    });

    it("does not refetch for an event that changes nothing", async () => {
        const state = { current: null };
        await start(state);
        const before = get.mock.calls.length;

        await act(async () => {
            handlers["cockpit:event"]({ seq: 6, kind: "MATERIALITY",
                                        at: "2026-08-31T04:31:00.000Z" });
            await new Promise((r) => setTimeout(r, 10));
        });
        expect(get.mock.calls.length).toBe(before);
    });

    it("keeps the live narration when it refreshes the state around it", async () => {
        const state = { current: null };
        await start(state);
        get.mockResolvedValueOnce(withAccount(101_000_000));

        await act(async () => {
            handlers["cockpit:event"]({ seq: 6, kind: "FILL", at: "2026-08-31T04:31:00.000Z" });
            await new Promise((r) => setTimeout(r, 10));
        });

        await waitFor(() => expect(state.current.snapshot.account).toBeTruthy());
        // The refresh asked for one narration event; the stream's history stands.
        expect(state.current.snapshot.narration.seq).toBe(5);
        expect(state.current.events.map((e) => e.seq)).toContain(6);
    });
});
