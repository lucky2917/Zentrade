import { useCallback, useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";
import api from "../services/api.js";

// The cockpit's live connection.
//
// Three properties this hook exists to guarantee:
//
//   1. A refresh does not lose the session. The snapshot rebuilds the whole
//      screen, then live streaming resumes from the sequence it ended at.
//   2. No event is rendered twice. Every event carries a monotonic sequence;
//      anything at or below what we already hold is discarded, so a reconnect
//      that replays a backlog is harmless.
//   3. A burst does not stall the browser. Events are buffered and flushed on
//      an animation frame rather than causing a render each.
//
// It never generates an event of its own. If the backend is quiet, this is
// quiet, and the screen says the market is quiet.

const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || "/";

// Narration kinds that mean the money, the positions or the orders on screen
// are now out of date. MARKET_OBSERVATION is here because unrealised P&L moves
// with the price and nothing else announces it.
const CHANGES_STATE = new Set([
    "FILL", "ORDER_STATE_CHANGED", "POSITION_CHANGED", "REASSESSMENT",
    "RECOVERY", "MARKET_OBSERVATION", "PROTECTIVE_EVENT", "HALT",
]);
const MAX_EVENTS = 600;
const SNAPSHOT_RETRY_MS = 5000;

export const useCockpit = () => {
    const [snapshot, setSnapshot] = useState(null);
    const [events, setEvents] = useState([]);
    const [connected, setConnected] = useState(false);
    const [error, setError] = useState(null);

    const seqRef = useRef(0);
    const pendingRef = useRef([]);
    const frameRef = useRef(null);
    const socketRef = useRef(null);
    // The highest sequence the state refresh has already considered, so a batch
    // is examined once and every event in it is examined.
    const refreshedThroughRef = useRef(0);

    // Buffered so a burst of narration costs one render, not one per event.
    const flush = useCallback(() => {
        frameRef.current = null;
        const batch = pendingRef.current;
        if (!batch.length) return;
        pendingRef.current = [];
        setEvents((prev) => {
            const next = prev.concat(batch);
            return next.length > MAX_EVENTS ? next.slice(next.length - MAX_EVENTS) : next;
        });
    }, []);

    const ingest = useCallback((incoming) => {
        const fresh = [];
        for (const event of incoming) {
            // The dedup rule. Sequence is assigned by the narrator and is
            // monotonic for the life of the process.
            if (!event || event.seq <= seqRef.current) continue;
            seqRef.current = event.seq;
            fresh.push(event);
        }
        if (!fresh.length) return;
        pendingRef.current.push(...fresh);
        if (frameRef.current === null) {
            frameRef.current = requestAnimationFrame(flush);
        }
    }, [flush]);

    const loadSnapshot = useCallback(async () => {
        try {
            const { data } = await api.get("/internal/cockpit/snapshot", {
                baseURL: "/", params: { limit: 300 },
            });
            seqRef.current = 0;
            pendingRef.current = [];
            setSnapshot(data);
            setEvents(data.narration?.events ?? []);
            seqRef.current = data.narration?.seq ?? 0;
            // The snapshot IS the current state, so nothing already in it needs
            // refreshing on account of the events it arrived with.
            refreshedThroughRef.current = seqRef.current;
            setError(null);
            return data.narration?.seq ?? 0;
        } catch (err) {
            setError(err.response?.status === 401
                ? "Sign in to view the cockpit."
                : "Cockpit snapshot unavailable.");
            return null;
        }
    }, []);

    useEffect(() => {
        let cancelled = false;
        let retry = null;

        const start = async () => {
            const seq = await loadSnapshot();
            if (cancelled) return;
            if (seq === null) {
                retry = setTimeout(start, SNAPSHOT_RETRY_MS);
                return;
            }

            const socket = io(SOCKET_URL, { transports: ["polling"], withCredentials: true });
            socketRef.current = socket;

            const hello = () => socket.emit("cockpit:hello", { since: seqRef.current });

            socket.on("connect", () => { setConnected(true); hello(); });
            socket.on("disconnect", () => setConnected(false));
            socket.on("cockpit:denied", (payload) => {
                setConnected(false);
                setError(payload?.reason ?? "cockpit access denied");
            });
            socket.on("cockpit:backlog", (payload) => {
                // The ring buffer rolled past us while we were away, so the
                // history we hold has a hole in it. Reload rather than pretend.
                if (payload?.gap) { loadSnapshot(); return; }
                ingest(payload?.events ?? []);
            });
            socket.on("cockpit:event", (event) => ingest([event]));
        };

        start();
        return () => {
            cancelled = true;
            if (retry) clearTimeout(retry);
            if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
            socketRef.current?.close();
        };
    }, [loadSnapshot, ingest]);

    // The snapshot's slower-moving parts are refreshed when narration says
    // something changed them, not on a timer.
    //
    // Two things this has to get right.
    //
    // Every NEW event is examined, not just the last one. Events arrive in
    // flushed batches, so a FILL followed by an observation in the same batch
    // left the last event non-material and the cash, positions and P&L on
    // screen a trade out of date.
    //
    // And an observation pass counts. Unrealised P&L moves with the price and
    // nothing emits an event when it does, so without this the equity figure
    // froze between fills — which on a demo screen reads as a broken number
    // rather than a quiet market.
    useEffect(() => {
        if (!events.length) return;
        const fresh = events.filter((e) => e.seq > refreshedThroughRef.current);
        if (!fresh.length) return;
        refreshedThroughRef.current = events[events.length - 1].seq;
        if (!fresh.some((e) => CHANGES_STATE.has(e.kind))) return;

        let cancelled = false;
        api.get("/internal/cockpit/snapshot", { baseURL: "/", params: { limit: 1 } })
            .then(({ data }) => {
                if (cancelled) return;
                // Narration is owned by the live stream; only the state the
                // snapshot is authoritative for is replaced.
                setSnapshot((prev) => (prev ? { ...prev, ...data, narration: prev.narration } : data));
            })
            .catch(() => {});
        return () => { cancelled = true; };
    }, [events]);

    return { snapshot, events, connected, error, reload: loadSnapshot };
};

export default useCockpit;
