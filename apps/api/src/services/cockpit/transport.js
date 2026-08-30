import jwt from "jsonwebtoken";
import logger from "../../utils/logger.js";

// Streaming narration to the cockpit over the socket that already exists.
//
// No second socket server, no second scheduler, no polling. The narrator emits,
// this forwards, the browser renders.
//
// Two things make a refresh safe:
//
//   1. Every event carries a monotonic sequence number, so a reconnecting
//      client says what it already has and receives only what it does not.
//   2. The backlog is replayed from the narrator's ring buffer before the live
//      subscription starts, and events are held until the replay finishes, so
//      the client cannot receive an event twice or receive them out of order.

export const COCKPIT_ROOM = "cockpit";
export const MAX_REPLAY = 500;

// The socket carries reasoning and positions, so it is gated by the same JWT
// the HTTP routes use. Not a new authentication system: the same secret, the
// same claims, the same blocklist semantics minus the Redis round trip, which
// the HTTP snapshot this client also calls already performs.
export const identify = (socket) => {
    const raw = socket.handshake?.headers?.cookie ?? "";
    const fromCookie = raw.split(";")
        .map((part) => part.trim())
        .find((part) => part.startsWith("token="))
        ?.slice("token=".length);
    const fromAuth = socket.handshake?.auth?.token ?? null;
    const token = fromCookie ?? fromAuth;
    if (!token) return null;
    try {
        const decoded = jwt.verify(decodeURIComponent(token), process.env.JWT_SECRET);
        return decoded?.userId ?? null;
    } catch {
        return null;
    }
};

export const attachCockpit = (io, narrator) => {
    // One subscription for the process, fanned out to the room. A per-socket
    // subscription would re-run the narrator's fan-out for every viewer.
    narrator.subscribe((event) => {
        io.to(COCKPIT_ROOM).emit("cockpit:event", event);
    });

    io.on("connection", (socket) => {
        socket.on("cockpit:hello", (payload = {}, ack) => {
            const userId = identify(socket);
            if (!userId) {
                socket.emit("cockpit:denied", { reason: "authentication required" });
                if (typeof ack === "function") ack({ ok: false });
                return;
            }

            const since = Number.isFinite(payload?.since) ? payload.since : 0;
            // Replay BEFORE joining the room. Joining first would interleave
            // live events with the backlog and deliver them out of order.
            const backlog = narrator.since(since, MAX_REPLAY);
            socket.emit("cockpit:backlog", {
                events: backlog,
                seq: narrator.seq,
                oldestSeq: narrator.log.length ? narrator.log[0].seq : narrator.seq,
                // True when the client was away long enough that the ring
                // buffer rolled past it: the UI must reload rather than assume
                // it has an unbroken history.
                gap: since > 0 && narrator.log.length > 0
                    && narrator.log[0].seq > since + 1,
            });
            socket.join(COCKPIT_ROOM);

            logger.info("Cockpit", "viewer attached",
                        { socket: socket.id, since, replayed: backlog.length });
            if (typeof ack === "function") ack({ ok: true, seq: narrator.seq });
        });

        socket.on("cockpit:bye", () => socket.leave(COCKPIT_ROOM));
    });
};
