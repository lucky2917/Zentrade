import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";

const TEST_DB = process.env.TEST_DATABASE_URL;
const TEST_REDIS = process.env.TEST_REDIS_URL;
const PORT = 5903;
const BASE = `http://127.0.0.1:${PORT}`;

// The cockpit against the real server.
//
// Everything here goes over HTTP to a process actually running index.js, so it
// proves the route is mounted, the guard is real, the snapshot has the shape the
// UI reads, and the browser cannot reach anything that acts.

const signup = async (email) => {
    const res = await fetch(`${BASE}/api/auth/signup`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password: "Cockpit!Test1", name: "cockpit" }),
    });
    const cookies = res.headers.getSetCookie?.() ?? [];
    return cookies.map((c) => c.split(";")[0]).join("; ");
};

describe.skipIf(!TEST_DB || !TEST_REDIS)("cockpit over the real server", () => {
    let server;
    let cookie;

    beforeAll(async () => {
        server = spawn("node", ["src/index.js"], {
            env: {
                ...process.env, PORT: String(PORT),
                DATABASE_URL: TEST_DB, REDIS_URL: TEST_REDIS, DB_SSL: "false",
                JWT_SECRET: "cockpit-e2e-secret-0123456789abcdefghij",
                ZENTRADE_AUTONOMOUS: "false",
            },
            stdio: "ignore",
        });
        for (let i = 0; i < 40; i += 1) {
            try {
                const res = await fetch(`${BASE}/api/health`);
                if (res.ok) break;
            } catch { /* not up yet */ }
            await new Promise((r) => setTimeout(r, 500));
        }
        cookie = await signup(`cockpit-${Date.now()}@test.com`);
    }, 45_000);

    afterAll(() => { server?.kill(); });

    it("refuses the snapshot without a session", async () => {
        const res = await fetch(`${BASE}/internal/cockpit/snapshot`);
        expect(res.status).toBe(401);
    });

    it("serves a snapshot with everything the cockpit renders", async () => {
        const res = await fetch(`${BASE}/internal/cockpit/snapshot`, {
            headers: { Cookie: cookie } });
        expect(res.status).toBe(200);
        const body = await res.json();

        // Paper mode is stated on every payload, so the UI cannot imply real
        // money by omission.
        expect(body.mode).toBe("PAPER");
        expect(body.liveExecutionEnabled).toBe(false);

        for (const key of ["narration", "world", "health", "positions",
                           "openOrders", "todaysOrders"]) {
            expect({ key, present: key in body }).toEqual({ key, present: true });
        }
        expect(body.narration).toHaveProperty("seq");
        expect(body.narration).toHaveProperty("brain");
        expect(Array.isArray(body.narration.events)).toBe(true);
        expect(body.world).toHaveProperty("session");
    });

    it("serves an incremental catch-up from a sequence", async () => {
        const res = await fetch(`${BASE}/internal/cockpit/events?since=0`, {
            headers: { Cookie: cookie } });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toHaveProperty("seq");
        expect(Array.isArray(body.events)).toBe(true);
    });

    it("reports no timeline for a symbol with no open thesis", async () => {
        const res = await fetch(`${BASE}/internal/cockpit/position/NOSUCHSYMBOL`, {
            headers: { Cookie: cookie } });
        expect(res.status).toBe(404);
    });

    // The read-only guarantee, checked against the running server rather than
    // against the source.
    it("has no mutating verb on any cockpit route", async () => {
        for (const path of ["/internal/cockpit/snapshot", "/internal/cockpit/events",
                            "/internal/cockpit/position/RELIANCE"]) {
            for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
                const res = await fetch(`${BASE}${path}`, {
                    method, headers: { Cookie: cookie, "Content-Type": "application/json" },
                    body: method === "DELETE" ? undefined : "{}",
                });
                // 404 (no such route) or 405. Never 2xx.
                expect({ path, method, ok: res.ok }).toEqual({ path, method, ok: false });
            }
        }
    });

    it("serves the cockpit page so a refresh on /trader works", async () => {
        const res = await fetch(`${BASE}/trader`);
        // Either the built app is mounted, or it is not built and the dev
        // server owns the route. A 500 would mean the mount is broken.
        expect([200, 404]).toContain(res.status);
        if (res.status === 200) {
            expect((await res.text()).toLowerCase()).toContain("<!doctype html");
        }
    });

    it("keeps the API routes working with the UI mounted", async () => {
        const res = await fetch(`${BASE}/api/health`);
        expect(res.ok).toBe(true);
    });
}, 60_000);
