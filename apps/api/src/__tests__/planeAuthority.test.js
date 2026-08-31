import { describe, expect, it, vi } from "vitest";
import { FastPlaneBridge, PLANE_MODE } from "../services/tick/fastPlane.js";
import { CROSSING, DIRECTION } from "../services/tick/reflex.js";

// Who is protecting the position right now.
//
// In LIVE the Go plane owns detection and the Node reflex stops dispatching, so
// exactly one actor reacts to a crossing. That is correct only while the plane
// is actually alive. `authoritative` was `mode === LIVE` and nothing else, so a
// plane that died left the local lane suppressed and the plane silent: no
// detector at all, and the only trace was an `alive: false` line in a heartbeat
// nobody blocks on.
//
// Falling back to the local lane is safe because both paths mint the same
// client order id for a protective exit, so the engine absorbs a second one.

const fakeRedis = (health) => ({
    get: vi.fn(async () => health),
    publish: vi.fn(async () => 1),
    hset: vi.fn(async () => 1),
    duplicate: vi.fn(),
    eval: vi.fn(async () => []),
});

describe("the plane is authoritative only while it is alive", () => {
    it("does not take authority before it has proved it is there", () => {
        const plane = new FastPlaneBridge({
            mode: PLANE_MODE.LIVE, client: fakeRedis(null) });
        // Nothing has been checked yet. The local lane keeps protecting.
        expect(plane.authoritative).toBe(false);
    });

    it("takes authority once the plane reports a heartbeat", async () => {
        const plane = new FastPlaneBridge({
            mode: PLANE_MODE.LIVE,
            client: fakeRedis(JSON.stringify({ symbols: 12, ticks: 400 })) });
        expect(await plane.checkAlive()).toBe(true);
        expect(plane.authoritative).toBe(true);
    });

    it("gives authority back when the heartbeat stops", async () => {
        const health = { value: JSON.stringify({ symbols: 12 }) };
        const plane = new FastPlaneBridge({
            mode: PLANE_MODE.LIVE,
            client: { ...fakeRedis(null), get: vi.fn(async () => health.value) } });
        await plane.checkAlive();
        expect(plane.authoritative).toBe(true);

        health.value = null;                       // the plane died
        expect(await plane.checkAlive()).toBe(false);
        expect(plane.authoritative).toBe(false);
    });

    it("treats an unreachable Redis as a plane that is not there", async () => {
        const plane = new FastPlaneBridge({
            mode: PLANE_MODE.LIVE,
            client: { ...fakeRedis(null), get: vi.fn(async () => { throw new Error("down"); }) } });
        expect(await plane.checkAlive()).toBe(false);
        expect(plane.authoritative).toBe(false);
    });

    it("never takes authority in shadow, however healthy it is", async () => {
        const plane = new FastPlaneBridge({
            mode: PLANE_MODE.SHADOW, client: fakeRedis(JSON.stringify({ symbols: 1 })) });
        await plane.checkAlive();
        expect(plane.alive).toBe(true);
        expect(plane.authoritative).toBe(false);
    });

    it("is never authoritative when it is off", async () => {
        const plane = new FastPlaneBridge({ mode: PLANE_MODE.OFF, client: fakeRedis(null) });
        expect(await plane.checkAlive()).toBe(false);
        expect(plane.authoritative).toBe(false);
    });
});

// The handover itself. A crossing detected while the plane was authoritative
// latches the local lane and is suppressed. If the plane then dies, that latch
// would keep the local lane from ever firing the level it had already seen.

describe("handing protection back to the local lane", () => {
    const makeRuntime = async (plane) => {
        const { AutonomousRuntime, MODE } = await import("../services/autonomous/runtime.js");
        return new AutonomousRuntime({
            engine: { openOrders: async () => [] }, reconciler: null,
            mode: MODE.PAPER, userId: 1, fastPlane: plane,
            ports: { loadPositions: async () => [],
                     positionFor: async () => ({ symbol: "RELIANCE", quantity: 100 }) },
        });
    };

    it("re-evaluates every armed level when the plane stops being authoritative",
       async () => {
        const health = { value: JSON.stringify({ symbols: 1 }) };
        const plane = new FastPlaneBridge({
            mode: PLANE_MODE.LIVE,
            client: { ...fakeRedis(null), get: vi.fn(async () => health.value) } });
        const runtime = await makeRuntime(plane);
        const submitted = [];
        runtime.venue.submit = async (intent) => {
            submitted.push(intent);
            return { order: { id: 1, state: "FILLED", symbol: "RELIANCE" }, duplicate: false };
        };

        await runtime.checkPlaneAuthority();
        expect(plane.authoritative).toBe(true);

        runtime.reflex.arm("RELIANCE", {
            thesisId: "t-1", direction: DIRECTION.LONG, stopPaise: 98_000,
            targetPaise: 108_000, quantity: 100, correlationId: "c-1",
        });

        // The stop breaks while the plane owns detection. The local lane sees
        // it, latches it, and does not act.
        runtime.reflex.onTick({ symbol: "RELIANCE", pricePaise: 97_000, at: 1 });
        expect(submitted).toHaveLength(0);
        expect(runtime.metrics.localCrossingsSuppressed).toBe(1);

        // The plane dies without having acted.
        health.value = null;
        await runtime.checkPlaneAuthority();
        expect(plane.authoritative).toBe(false);

        // The next tick must protect. Without clearing the latch it never would.
        runtime.reflex.onTick({ symbol: "RELIANCE", pricePaise: 96_900, at: 2 });
        await vi.waitFor(() => expect(submitted).toHaveLength(1));
        expect(submitted[0].side).toBe("SELL");
        expect(submitted[0].clientOrderId).toBe("t-1:PROTECT:STOP");
    });

    it("does not disturb the latches while authority is unchanged", async () => {
        const plane = new FastPlaneBridge({
            mode: PLANE_MODE.LIVE,
            client: { ...fakeRedis(null), get: vi.fn(async () => JSON.stringify({ ok: 1 })) } });
        const runtime = await makeRuntime(plane);
        await runtime.checkPlaneAuthority();
        const first = await runtime.checkPlaneAuthority();
        expect(first.changed).toBe(false);
        expect(runtime.metrics.planeAuthorityChanges).toBe(1);
    });
});
