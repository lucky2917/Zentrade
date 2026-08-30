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
    useEffect(() => {
        const last = events[events.length - 1];
        if (!last) return;
        const CHANGES_STATE = ["FILL", "ORDER_STATE_CHANGED", "POSITION_CHANGED",
                               "REASSESSMENT", "RECOVERY"];
        if (!CHANGES_STATE.includes(last.kind)) return;
        let cancelled = false;
        api.get("/internal/cockpit/snapshot", { baseURL: "/", params: { limit: 1 } })
            .then(({ data }) => {
                if (cancelled) return;
                setSnapshot((prev) => (prev ? { ...prev, ...data, narration: prev.narration } : data));
            })
            .catch(() => {});
        return () => { cancelled = true; };
    }, [events]);

    return { snapshot, events, connected, error, reload: loadSnapshot };
};

export default useCockpit;
