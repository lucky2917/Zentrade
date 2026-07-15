import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";

/**
 * Journal Read API + trade linkage (M9): true end-to-end — boots the real
 * server and drives it over HTTP. Real Postgres + real Redis required.
 */
const TEST_DB = process.env.TEST_DATABASE_URL;
const TEST_REDIS = process.env.TEST_REDIS_URL;

if (TEST_REDIS) process.env.REDIS_URL = TEST_REDIS;
if (TEST_DB) process.env.DATABASE_URL = TEST_DB;

const PORT = 5901;
const BASE = `http://localhost:${PORT}`;
const HASH = "c".repeat(64);

const evidence = () => [
    { ref: "price:live", kind: "price", sourceRef: "redis:stock-cache", content: { price: 1500 }, weight: null },
    { ref: "ind:rsi14", kind: "indicator", sourceRef: "fyers:candles:D:365", content: { rsi14: 52 }, weight: null },
];

const journalInput = (n) => ({
    symbol: "INFY",
    trigger: "test",
    contextSnapshot: { price: 1500 + n, changePercent: 0.1, priceTimestamp: 1783929474262, marketOpen: false, inputsHash: HASH },
    evidence: evidence(),
    runs: [
        {
            agentName: "technical",
            agentVersion: "v4.1.0",
            modelId: "llama-3.3-70b-versatile",
            inputHash: HASH,
            output: { signal: "BULLISH", keyPoints: [{ point: `p${n}`, refs: ["ind:rsi14"] }] },
            status: "ok",
            latencyMs: 100 + n,
            promptTokens: 10,
            completionTokens: 5,
            costUsd: 0.00001,
            citationReport: { status: "ok", uncitedCount: 0, unknownRefs: [] },
        },
    ],
    decision: {
        action: "BUY",
        mode: "DELIVERY",
        confidence: "MEDIUM",
        entryMinor: 150000 + n,
        targetMinor: 152000,
        stopMinor: 149000,
        rationale: { traderNote: `note ${n}`, reasoning: [`r${n}`], consensus: "majority", macroScore: 0 },
        synthesizerVersion: "v4.1.0",
    },
});

const signup = async (email) => {
    const res = await fetch(`${BASE}/api/auth/signup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password: "hunter2hunter2" }),
    });
    expect(res.status).toBe(201);
    return res.headers
        .getSetCookie()
        .map((c) => c.split(";")[0])
        .join("; ");
};

const get = (path, cookie) => fetch(`${BASE}${path}`, { headers: cookie ? { Cookie: cookie } : {} });

describe.skipIf(!TEST_DB || !TEST_REDIS)("journal read api + trade linkage (e2e)", () => {
    let pool, redis, journal, server;
    let cookieA, cookieB;
    let createdIds = [];

    beforeAll(async () => {
        ({ pool } = await import("../config/db.js"));
        redis = (await import("../config/redis.js")).default;
        const { runMigrations } = await import("../config/migrations.js");
        await runMigrations(pool);
        const { seedReferenceData } = await import("../services/referenceData.js");
        await seedReferenceData();
        journal = await import("../services/decisionJournal.js");

        server = spawn("node", ["src/index.js"], {
            env: {
                ...process.env,
                PORT: String(PORT),
                DATABASE_URL: TEST_DB,
                REDIS_URL: TEST_REDIS,
                JWT_SECRET: "journal-api-e2e-secret-0123456789abcdef",
                JOURNAL_ENABLED: "",
            },
            stdio: "ignore",
        });
        for (let i = 0; i < 30; i++) {
            try {
                const res = await fetch(`${BASE}/api/health`);
                if (res.ok) break;
            } catch { /* not up yet */ }
            await new Promise((r) => setTimeout(r, 500));
        }

        cookieA = await signup(`m9a-${Date.now()}@test.com`);
        cookieB = await signup(`m9b-${Date.now()}@test.com`);

        createdIds = [];
        for (let n = 0; n < 7; n++) {
            const { decisionId } = await journal.journalAnalysis(journalInput(n));
            createdIds.push(decisionId);
        }
    }, 40_000);

    afterAll(async () => {
        server?.kill();
        await pool.end();
        redis.disconnect();
    });

    it("authorization: journal endpoints refuse unauthenticated access", async () => {
        expect((await get("/api/decisions")).status).toBe(401);
        expect((await get(`/api/decisions/${createdIds[0]}`)).status).toBe(401);
    });

    it("keyset pagination: complete, duplicate-free, and stable under concurrent inserts", async () => {
        const page1 = await (await get("/api/decisions?instrument=INFY&limit=3", cookieA)).json();
        expect(page1.decisions).toHaveLength(3);
        expect(page1.hasMore).toBe(true);

        // a NEW decision lands mid-pagination — offset pagination would shift;
        // keyset must not repeat or skip anything already being paged
        const { decisionId: newest } = await journal.journalAnalysis(journalInput(99));

        const page2 = await (await get(`/api/decisions?instrument=INFY&limit=3&cursor=${page1.nextCursor}`, cookieA)).json();
        const page3 = await (await get(`/api/decisions?instrument=INFY&limit=3&cursor=${page2.nextCursor}`, cookieA)).json();

        const seen = [...page1.decisions, ...page2.decisions, ...page3.decisions].map((d) => d.decisionId);
        expect(new Set(seen).size).toBe(seen.length); // no duplicates
        for (const id of createdIds) expect(seen).toContain(id); // no gaps
        expect(seen).not.toContain(newest); // newer item never leaks into older pages

        // ordering is newest-first throughout
        const times = [...page1.decisions, ...page2.decisions, ...page3.decisions].map((d) => new Date(d.createdAt).getTime());
        expect([...times].sort((a, b) => b - a)).toEqual(times);
    });

    it("rejects malformed cursors and ids", async () => {
        expect((await get("/api/decisions?cursor=%%%garbage", cookieA)).status).toBe(400);
        expect((await get("/api/decisions/not-a-uuid", cookieA)).status).toBe(400);
        expect((await get("/api/decisions/3b241101-e2bb-4255-8caf-4136c566a962", cookieA)).status).toBe(404);
    });

    it("detail returns the chain verbatim — byte-equal to the stored rows", async () => {
        const id = createdIds[3];
        const body = await (await get(`/api/decisions/${id}`, cookieA)).json();

        const dbDecision = (await pool.query("SELECT * FROM decisions WHERE id = $1", [id])).rows[0];
        const dbRequest = (await pool.query("SELECT * FROM decision_requests WHERE id = $1", [dbDecision.request_id])).rows[0];
        const dbRuns = (await pool.query("SELECT * FROM agent_runs WHERE request_id = $1", [dbDecision.request_id])).rows;
        const dbEvidence = (await pool.query("SELECT * FROM evidence WHERE request_id = $1 ORDER BY ref", [dbDecision.request_id])).rows;

        expect(body.decision.entryMinor).toBe(Number(dbDecision.entry_minor));
        expect(body.rationale).toEqual(dbDecision.rationale); // verbatim JSONB
        expect(body.request.contextSnapshot).toEqual(dbRequest.context_snapshot);
        expect(body.request.regime).toEqual(dbRequest.regime);
        expect(body.agentRuns).toHaveLength(dbRuns.length);
        expect(body.agentRuns[0].inputHash).toBe(dbRuns[0].input_hash);
        expect(body.agentRuns[0].output).toEqual(dbRuns[0].output); // verbatim
        expect(body.evidence.map((e) => e.evidenceId)).toEqual(dbEvidence.map((e) => e.id));
        expect(body.evidence[0].content).toEqual(dbEvidence[0].content);
    });

    it("trade linkage: authorized decision-linked trade persists, events carry the ids", async () => {
        const id = createdIds[0];
        await redis.set("stock:INFY", JSON.stringify({ price: 1500, timestamp: Date.now() }));

        const res = await fetch(`${BASE}/api/trade/buy`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Cookie: cookieA },
            body: JSON.stringify({ symbol: "INFY", quantity: 2, mode: "DELIVERY", decisionId: id }),
        });
        expect(res.status).toBe(200);

        const { rows: [order] } = await pool.query("SELECT id, decision_id FROM orders WHERE decision_id = $1", [id]);
        expect(order.decision_id).toBe(id);

        const { rows: [event] } = await pool.query(
            "SELECT payload FROM outbox WHERE event_type = 'trade.executed' AND payload->'payload'->>'decisionId' = $1",
            [id]
        );
        expect(event.payload.payload).toMatchObject({
            orderId: order.id,
            symbol: "INFY",
            side: "BUY",
            quantity: 2,
            executionPriceMinor: 150150,
            decisionId: id,
        });
        expect(event.payload.payload.instrumentId).toMatch(/^[0-9a-f-]{36}$/);

        // the chain shows MY order to me, and nothing to another user
        const mineA = await (await get(`/api/decisions/${id}`, cookieA)).json();
        const mineB = await (await get(`/api/decisions/${id}`, cookieB)).json();
        expect(mineA.myOrders).toHaveLength(1);
        expect(mineA.myOrders[0].orderId).toBe(order.id);
        expect(mineB.myOrders).toHaveLength(0);
    });

    it("rejects linkage lies: bad uuid, unknown decision, wrong instrument", async () => {
        await redis.set("stock:INFY", JSON.stringify({ price: 1500, timestamp: Date.now() }));
        await redis.set("stock:TCS", JSON.stringify({ price: 4100, timestamp: Date.now() }));

        const attempt = (body) =>
            fetch(`${BASE}/api/trade/buy`, {
                method: "POST",
                headers: { "Content-Type": "application/json", Cookie: cookieA },
                body: JSON.stringify(body),
            });

        expect((await attempt({ symbol: "INFY", quantity: 1, mode: "DELIVERY", decisionId: "nope" })).status).toBe(400);
        expect(
            (await attempt({ symbol: "INFY", quantity: 1, mode: "DELIVERY", decisionId: "3b241101-e2bb-4255-8caf-4136c566a962" })).status
        ).toBe(400);
        // decision belongs to INFY — trading TCS with it must fail
        expect((await attempt({ symbol: "TCS", quantity: 1, mode: "DELIVERY", decisionId: createdIds[0] })).status).toBe(400);
    });

    it("read-only proof: paging and detail fetches mutate nothing", async () => {
        const counts = async () =>
            (await pool.query(
                `SELECT (SELECT COUNT(*) FROM decision_requests) AS req,
                        (SELECT COUNT(*) FROM agent_runs) AS runs,
                        (SELECT COUNT(*) FROM evidence) AS ev,
                        (SELECT COUNT(*) FROM decisions) AS dec,
                        (SELECT COUNT(*) FROM outbox) AS outbox,
                        (SELECT COUNT(*) FROM orders) AS orders`
            )).rows[0];

        const before = await counts();
        for (let i = 0; i < 5; i++) {
            await get("/api/decisions?instrument=INFY&limit=2", cookieA);
            await get(`/api/decisions/${createdIds[0]}`, cookieA);
        }
        expect(await counts()).toEqual(before);
    });
});
