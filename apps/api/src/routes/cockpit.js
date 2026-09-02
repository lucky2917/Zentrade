import express from "express";
import auth from "../middleware/auth.js";
import { narrator } from "../services/cockpit/narrator.js";
import { buildSnapshot, readPositionTimeline, readAccount, readDecisions }
    from "../services/cockpit/state.js";
import { readLogbook } from "../services/cockpit/logbook.js";

// The cockpit's HTTP surface.
//
// READ ONLY, completely. There is no POST, PUT, PATCH or DELETE on this router
// and there is no code path from it to execution, risk or thesis state. The
// browser observes; it cannot act. That is enforced by a test, because a
// read-only guarantee that depends on nobody adding a handler is not one.

// Every dependency is an accessor, not a value. This router is built while the
// server module is still initialising, so anything read eagerly here is read
// before it exists.
export const buildCockpitRouter = ({ runtimeHealth = async () => null,
                                     health = () => null, userId }) => {
    const router = express.Router();
    const account = () => (typeof userId === "function" ? userId() : userId);

    router.get("/snapshot", auth, async (req, res) => {
        try {
            const limit = Math.min(Number(req.query.limit) || 300, 1000);
            res.json(await buildSnapshot({
                narrator, runtimeHealth: await runtimeHealth(), health: health(),
                userId: account(), limit }));
        } catch (err) {
            res.status(503).json({ error: "snapshot unavailable", detail: err.message });
        }
    });

    // Incremental catch-up for a client that has a sequence and only wants what
    // came after it.
    router.get("/events", auth, (req, res) => {
        const since = Number(req.query.since) || 0;
        const limit = Math.min(Number(req.query.limit) || 500, 1000);
        res.json({
            seq: narrator.seq,
            oldestSeq: narrator.log.length ? narrator.log[0].seq : narrator.seq,
            events: narrator.since(since, limit),
        });
    });

    // The persistent account, its reconciliation status and its session history.
    router.get("/account", auth, async (_req, res) => {
        try {
            const state = await readAccount(account());
            if (!state) return res.status(404).json({ error: "no paper account" });
            res.json(state);
        } catch (err) {
            res.status(503).json({ error: "account unavailable", detail: err.message });
        }
    });

    // The decision record. Survives restarts, which is the point of it.
    router.get("/decisions", auth, async (req, res) => {
        try {
            const symbol = typeof req.query.symbol === "string" ? req.query.symbol : null;
            res.json({ decisions: await readDecisions(account(), {
                limit: Number(req.query.limit) || 50, symbol }) });
        } catch (err) {
            res.status(503).json({ error: "decisions unavailable", detail: err.message });
        }
    });

    // The whole durable record of a session: decisions and the reasoning inside
    // them, the model calls they cost, the conditions that woke the trader, the
    // orders, fills, theses, reassessments and runtime events.
    router.get("/logbook", auth, async (req, res) => {
        try {
            const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date ?? "")
                ? req.query.date : null;
            res.json(await readLogbook({
                userId: account(), sessionDate: date,
                limit: Math.min(Number(req.query.limit) || 400, 1000),
            }));
        } catch (err) {
            res.status(503).json({ error: "logbook unavailable", detail: err.message });
        }
    });

    router.get("/position/:symbol", auth, async (req, res) => {
        try {
            const timeline = await readPositionTimeline(account(), req.params.symbol);
            if (!timeline) return res.status(404).json({ error: "no open thesis" });
            res.json(timeline);
        } catch (err) {
            res.status(503).json({ error: "timeline unavailable", detail: err.message });
        }
    });

    return router;
};
