import express from "express";
import auth from "../middleware/auth.js";
import { narrator } from "../services/cockpit/narrator.js";
import { buildSnapshot, readPositionTimeline } from "../services/cockpit/state.js";

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
