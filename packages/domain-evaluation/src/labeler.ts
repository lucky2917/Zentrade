import { istDateString } from "@zentrade/kernel";

/**
 * Outcome labeling (M11) — deterministic, zero look-ahead, replayable.
 *
 * LAWS (each has a dedicated test):
 *  1. NO LOOK-AHEAD, NO LOOK-BEHIND-MISATTRIBUTION: path hits (target/stop)
 *     are scanned only in sessions STRICTLY AFTER the decision's IST session.
 *     A same-session daily candle contains pre-decision movement (its high
 *     may have printed before the decision existed) — crediting it would
 *     misattribute already-spent moves. Same-session data is used only for
 *     the intraday square-off CLOSE, which by definition prints after any
 *     intraday decision.
 *  2. DETERMINISM: same decision + same candles -> same label, forever.
 *     Integer math on minor units; bps rounded half-away-from-zero.
 *  3. TRUNCATION INVARIANCE: candles beyond the horizon window never change
 *     the label — replaying years later with a longer history is identical.
 *  4. CONSERVATIVE AMBIGUITY: if one candle spans both target and stop, the
 *     STOP wins (risk-first: we assume the worst path through the bar).
 *  5. GAPS ARE REAL: a session opening beyond the level fills at the OPEN,
 *     not at the level you wished for.
 */

export interface DailyCandle {
    /** epoch seconds, session (bar) time */
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
}

export interface LabelableDecision {
    action: "BUY" | "SELL" | "HOLD";
    mode: "INTRADAY" | "DELIVERY";
    entryMinor: number | null;
    targetMinor: number | null;
    stopMinor: number | null;
    /** ISO timestamp of the decision */
    createdAt: string;
}

export interface HorizonSpec {
    key: string;
    /** sessions after the decision session (0 = decision session itself) */
    sessions: number;
}

export const HORIZONS_FOR_MODE: Record<LabelableDecision["mode"], HorizonSpec[]> = {
    INTRADAY: [{ key: "squareoff", sessions: 0 }],
    DELIVERY: [
        { key: "1d", sessions: 1 },
        { key: "5d", sessions: 5 },
    ],
};

export interface OutcomeLabel {
    ready: true;
    horizon: string;
    basis: "path" | "close" | "squareoff" | "abstain";
    hit: "target" | "stop" | "neither";
    entryMinor: number | null;
    exitMinor: number | null;
    realizedReturnBps: number | null;
    sessionsUsed: number;
}

export interface NotReady {
    ready: false;
    reason: string;
}

const toMinor = (price: number): number => Math.round(price * 100);

/** bps of (exit-entry)/entry, sign-flipped for SELL; half away from zero. */
const returnBps = (entryMinor: number, exitMinor: number, action: "BUY" | "SELL" | "HOLD"): number => {
    const raw = ((exitMinor - entryMinor) / entryMinor) * 10_000;
    const signed = action === "SELL" ? -raw : raw;
    return signed >= 0 ? Math.floor(signed + 0.5) : -Math.floor(-signed + 0.5);
};

/**
 * Label one decision for one horizon.
 * `candles` may contain ANY range of daily candles (past, decision day,
 * far future) — the function slices what the laws permit and ignores the
 * rest. Time zone: sessions are compared by IST calendar date.
 */
export const labelDecisionOutcome = (
    decision: LabelableDecision,
    horizon: HorizonSpec,
    candles: readonly DailyCandle[],
): OutcomeLabel | NotReady => {
    const decisionDate = istDateString(new Date(decision.createdAt));

    const sorted = [...candles].sort((a, b) => a.time - b.time);
    const sameSession = sorted.filter((c) => istDateString(new Date(c.time * 1000)) === decisionDate);
    const afterSessions = sorted.filter((c) => istDateString(new Date(c.time * 1000)) > decisionDate);

    // ---- INTRADAY: square-off at the decision session's close ----
    if (horizon.sessions === 0) {
        const sessionCandle = sameSession[sameSession.length - 1];
        if (!sessionCandle) return { ready: false, reason: "decision-session candle not yet available" };
        const exitMinor = toMinor(sessionCandle.close);
        const entryMinor = decision.entryMinor;
        return {
            ready: true,
            horizon: horizon.key,
            basis: decision.entryMinor === null ? "abstain" : "squareoff",
            hit: "neither", // path hits inside the session are unknowable from a daily bar
            entryMinor,
            exitMinor,
            realizedReturnBps: entryMinor === null ? null : returnBps(entryMinor, exitMinor, decision.action),
            sessionsUsed: 0,
        };
    }

    // ---- DELIVERY horizons: window = sessions strictly after decision day,
    // capped at the horizon (truncation invariance). A path hit inside the
    // available sessions is a FINAL fact and labels early; only the no-hit
    // close-basis label must wait for the complete window.
    const window = afterSessions.slice(0, horizon.sessions);

    // abstention / missing entry: measure the market we sat out — needs the full window
    if (decision.entryMinor === null) {
        if (afterSessions.length < horizon.sessions) {
            return { ready: false, reason: `need ${horizon.sessions} post-decision sessions, have ${afterSessions.length}` };
        }
        const reference = toMinor(window[0]!.open);
        const exitMinor = toMinor(window[window.length - 1]!.close);
        return {
            ready: true,
            horizon: horizon.key,
            basis: "abstain",
            hit: "neither",
            entryMinor: reference,
            exitMinor,
            realizedReturnBps: returnBps(reference, exitMinor, "BUY"),
            sessionsUsed: horizon.sessions,
        };
    }

    const entry = decision.entryMinor;
    const target = decision.targetMinor;
    const stop = decision.stopMinor;
    const isBuy = decision.action !== "SELL"; // HOLD with levels labels long-convention

    for (let i = 0; i < window.length; i++) {
        const c = window[i]!;
        const openM = toMinor(c.open);
        const highM = toMinor(c.high);
        const lowM = toMinor(c.low);

        const stopTouched = stop !== null && (isBuy ? lowM <= stop : highM >= stop);
        const targetTouched = target !== null && (isBuy ? highM >= target : lowM <= target);

        if (stopTouched) {
            // LAW 4: stop wins ambiguous bars. LAW 5: gap fills at the open.
            const gapped = isBuy ? openM <= stop! : openM >= stop!;
            const exitMinor = gapped ? openM : stop!;
            return {
                ready: true,
                horizon: horizon.key,
                basis: "path",
                hit: "stop",
                entryMinor: entry,
                exitMinor,
                realizedReturnBps: returnBps(entry, exitMinor, decision.action),
                sessionsUsed: i + 1,
            };
        }
        if (targetTouched) {
            const gapped = isBuy ? openM >= target! : openM <= target!;
            const exitMinor = gapped ? openM : target!;
            return {
                ready: true,
                horizon: horizon.key,
                basis: "path",
                hit: "target",
                entryMinor: entry,
                exitMinor,
                realizedReturnBps: returnBps(entry, exitMinor, decision.action),
                sessionsUsed: i + 1,
            };
        }
    }

    // neither level touched: the close-basis label needs the full window
    if (afterSessions.length < horizon.sessions) {
        return { ready: false, reason: `no hit yet; need ${horizon.sessions} post-decision sessions, have ${afterSessions.length}` };
    }
    const exitMinor = toMinor(window[window.length - 1]!.close);
    return {
        ready: true,
        horizon: horizon.key,
        basis: "close",
        hit: "neither",
        entryMinor: entry,
        exitMinor,
        realizedReturnBps: returnBps(entry, exitMinor, decision.action),
        sessionsUsed: horizon.sessions,
    };
};
