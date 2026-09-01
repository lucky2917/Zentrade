import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import jwt from "jsonwebtoken";
import { buildCockpitRouter } from "../routes/cockpit.js";
import { identify, attachCockpit, COCKPIT_ROOM } from "../services/cockpit/transport.js";
import { Narrator, KIND } from "../services/cockpit/narrator.js";

process.env.JWT_SECRET = process.env.JWT_SECRET
    ?? "cockpit-test-secret-that-is-long-enough-32";

// The cockpit observes. It cannot act.
//
// A read-only guarantee that rests on nobody adding a handler is not a
// guarantee, so it is checked two ways: the router is inspected for mutating
// verbs, and the source is inspected for any import that could reach execution.

describe("the cockpit cannot act on the market", () => {
    const router = buildCockpitRouter({ runtime: () => null, health: () => null, userId: 1 });

    it("defines no mutating route", () => {
        const methods = router.stack
            .filter((layer) => layer.route)
            .flatMap((layer) => Object.keys(layer.route.methods));
        expect(methods.length).toBeGreaterThan(0);
        expect([...new Set(methods)]).toEqual(["get"]);
    });

    it("every route requires authentication", () => {
        for (const layer of router.stack.filter((l) => l.route)) {
            const names = layer.route.stack.map((h) => h.name);
            expect({ path: layer.route.path, guarded: names.includes("auth") })
                .toEqual({ path: layer.route.path, guarded: true });
        }
    });

    // The structural half: there is no path from this code to execution, so no
    // future handler can accidentally acquire one without the import showing up
    // here first.
    it("imports nothing that can place, cancel or amend an order", () => {
        const files = [
            "src/routes/cockpit.js",
            "src/services/cockpit/narrator.js",
            "src/services/cockpit/state.js",
            "src/services/cockpit/transport.js",
            "src/services/cockpit/reasoningNarration.js",
        ];
        const forbidden = [
            /from ".*tradingEngine\.js"/, /from ".*paperVenue\.js"/,
            /from ".*execution\/bookkeeper\.js"/, /from ".*riskGate\.js"/,
            /submitOrder|applyFill|executeBuy|executeSell|cancelOrder/,
        ];
        for (const file of files) {
            const source = readFileSync(join(process.cwd(), file), "utf8");
            for (const pattern of forbidden) {
                expect({ file, matched: pattern.test(source) })
                    .toEqual({ file, matched: false });
            }
        }
    });

    // state.js reads orders and positions; reading is the point. It must not
    // write them.
    it("reads order and position state without writing it", () => {
        const source = readFileSync(
            join(process.cwd(), "src/services/cockpit/state.js"), "utf8");
        expect(source).toMatch(/SELECT/);
        expect(source).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
    });
});

describe("the live stream is gated by the existing session", () => {
    const socketWith = (cookie) => ({ id: "s1", handshake: { headers: { cookie }, auth: {} } });

    it("identifies a viewer from the same cookie the API uses", () => {
        const token = jwt.sign({ userId: 42 }, process.env.JWT_SECRET);
        expect(identify(socketWith(`token=${token}; other=1`))).toBe(42);
    });

    it("refuses a missing, malformed or foreign token", () => {
        expect(identify(socketWith(""))).toBeNull();
        // The connection gate in index.js admits a socket only on a valid
        // cookie, so a credential offered any other way must not be honoured
        // here either: two layers, one answer.
        expect(identify({ handshake: { headers: {},
            auth: { token: jwt.sign({ userId: 42 }, process.env.JWT_SECRET) } } })).toBeNull();
        expect(identify(socketWith("token=garbage"))).toBeNull();
        expect(identify(socketWith(
            `token=${jwt.sign({ userId: 1 }, "a-different-secret-entirely-32ch")}`))).toBeNull();
    });

    const fakeIo = () => {
        const handlers = {};
        const emitted = [];
        return {
            emitted,
            to: () => ({ emit: (event, payload) => emitted.push({ event, payload }) }),
            on: (name, fn) => { handlers[name] = fn; },
            connect(socket) { handlers.connection(socket); return socket; },
        };
    };

    const fakeSocket = (cookie) => {
        const listeners = {};
        const sent = [];
        return {
            id: "s1", sent, joined: [],
            handshake: { headers: { cookie }, auth: {} },
            on: (name, fn) => { listeners[name] = fn; },
            emit: (name, payload) => sent.push({ name, payload }),
            join(room) { this.joined.push(room); },
            leave: vi.fn(),
            fire: (name, payload, ack) => listeners[name]?.(payload, ack),
        };
    };

    it("denies an unauthenticated viewer and never joins it to the room", () => {
        const narrator = new Narrator();
        const io = fakeIo();
        attachCockpit(io, narrator);
        const socket = fakeSocket("");
        io.connect(socket);

        socket.fire("cockpit:hello", { since: 0 });
        expect(socket.sent[0].name).toBe("cockpit:denied");
        expect(socket.joined).toEqual([]);
    });

    it("replays the backlog before joining, so nothing arrives out of order", () => {
        const narrator = new Narrator();
        narrator.emit(KIND.MARKET_EVENT, { symbol: "A" });
        narrator.emit(KIND.MARKET_EVENT, { symbol: "B" });

        const io = fakeIo();
        attachCockpit(io, narrator);
        const token = jwt.sign({ userId: 1 }, process.env.JWT_SECRET);
        const socket = fakeSocket(`token=${token}`);
        io.connect(socket);

        const order = [];
        socket.fire("cockpit:hello", { since: 0 }, () => order.push("ack"));

        expect(socket.sent[0].name).toBe("cockpit:backlog");
        expect(socket.sent[0].payload.events.map((e) => e.symbol)).toEqual(["A", "B"]);
        expect(socket.joined).toEqual([COCKPIT_ROOM]);
    });

    it("sends only what the reconnecting client is missing", () => {
        const narrator = new Narrator();
        narrator.emit(KIND.MARKET_EVENT, { symbol: "A" });
        narrator.emit(KIND.MARKET_EVENT, { symbol: "B" });
        narrator.emit(KIND.MARKET_EVENT, { symbol: "C" });

        const io = fakeIo();
        attachCockpit(io, narrator);
        const token = jwt.sign({ userId: 1 }, process.env.JWT_SECRET);
        const socket = fakeSocket(`token=${token}`);
        io.connect(socket);
        socket.fire("cockpit:hello", { since: 2 });

        expect(socket.sent[0].payload.events.map((e) => e.symbol)).toEqual(["C"]);
    });

    // A client away long enough for the ring to roll past it has a hole in its
    // history and must reload rather than assume continuity.
    it("tells a client whose history has a hole in it", () => {
        const narrator = new Narrator({ capacity: 3 });
        for (let i = 0; i < 10; i += 1) narrator.emit(KIND.MARKET_EVENT, { i });

        const io = fakeIo();
        attachCockpit(io, narrator);
        const token = jwt.sign({ userId: 1 }, process.env.JWT_SECRET);
        const socket = fakeSocket(`token=${token}`);
        io.connect(socket);
        socket.fire("cockpit:hello", { since: 2 });

        expect(socket.sent[0].payload.gap).toBe(true);
    });

    it("fans live events to the room, once", () => {
        const narrator = new Narrator();
        const io = fakeIo();
        attachCockpit(io, narrator);
        narrator.emit(KIND.DECISION, { action: "HOLD" });

        expect(io.emitted).toHaveLength(1);
        expect(io.emitted[0].event).toBe("cockpit:event");
        expect(io.emitted[0].payload.action).toBe("HOLD");
    });
});
