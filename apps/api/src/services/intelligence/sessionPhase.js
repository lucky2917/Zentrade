// Intraday session phase — where we are inside the trading day.
//
// Distinct from the operational session state in orchestrator/session.js:
// that answers "what is the system allowed to do", this answers "what part of
// the day is it", which is evidence the agents reason with. The two are
// deliberately separate concepts with separate vocabularies.
//
// Deterministic, PIT-safe: a function of the observation timestamp alone. It
// reads no candles, so it cannot depend on future bars.

export const PHASE = {
    PRE_OPEN: "PRE_OPEN",
    OPEN: "OPEN",
    EARLY_SESSION: "EARLY_SESSION",
    MID_SESSION: "MID_SESSION",
    LATE_SESSION: "LATE_SESSION",
    CLOSE: "CLOSE",
    POST_CLOSE: "POST_CLOSE",
};

export const SESSION_PHASES = Object.values(PHASE);

// Boundaries in IST minutes, with the reason each one exists.
export const PHASE_BOUNDARIES = [
    { until: 9 * 60 + 15, phase: PHASE.PRE_OPEN,
      why: "before the bell; pre-open auction, no continuous trading" },
    { until: 9 * 60 + 30, phase: PHASE.OPEN,
      why: "first 15 minutes; opening auction imbalance and overnight gap resolution" },
    { until: 11 * 60, phase: PHASE.EARLY_SESSION,
      why: "morning trend establishment; highest sustained participation" },
    { until: 14 * 60, phase: PHASE.MID_SESSION,
      why: "midday lull; typically the lowest volume of the session" },
    { until: 15 * 60 + 20, phase: PHASE.LATE_SESSION,
      why: "afternoon repositioning ahead of the close" },
    // Inclusive of the bell itself: 15:30 is the close, not after it. The
    // operational session model treats it the same way.
    { until: 15 * 60 + 31, phase: PHASE.CLOSE,
      why: "closing window; intraday square-off pressure" },
];

export const istMinutesOf = (date) => {
    const ist = new Date(date.getTime() + 5.5 * 60 * 60 * 1000);
    return ist.getUTCHours() * 60 + ist.getUTCMinutes();
};

export const phaseAtMinutes = (istMinutes) => {
    for (const boundary of PHASE_BOUNDARIES) {
        if (istMinutes < boundary.until) return boundary.phase;
    }
    return PHASE.POST_CLOSE;
};

export const phaseAt = (date) => phaseAtMinutes(istMinutesOf(date));

// Minutes elapsed since the opening bell; negative before it. Useful as
// evidence ("12 minutes into the session") without another clock read.
export const minutesIntoSession = (date) => istMinutesOf(date) - (9 * 60 + 15);

export const describePhase = (phase) =>
    PHASE_BOUNDARIES.find((b) => b.phase === phase)?.why
    ?? "after the close; no continuous trading";
