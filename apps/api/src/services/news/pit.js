// Point-in-time visibility for external events.
//
// An announcement must not inform a decision made before the exchange
// disseminated it. This is the same law the research spine enforces, applied
// to news: no row may carry information unavailable at its timestamp.
//
// BOUNDARY: an event is visible when disseminated_at <= decision_as_of.
// Inclusive at the boundary, because an announcement disseminated at exactly
// the decision instant was, by definition, available at that instant. The
// research spine uses an EXCLUSIVE as_of for bars for a different reason: a
// bar stamped at as_of is not yet complete. An announcement is complete the
// moment it is disseminated. The two rules differ deliberately and both are
// tested.

export class FutureEventRejected extends Error {}

export const isVisibleAt = (event, asOf) => {
    const disseminated = new Date(event.disseminatedAt).getTime();
    const cutoff = new Date(asOf).getTime();
    if (!Number.isFinite(disseminated) || !Number.isFinite(cutoff)) return false;
    return disseminated <= cutoff;
};

export const visibleEvents = (events, asOf) => events.filter((e) => isVisibleAt(e, asOf));

// Guard for callers that should never have been handed a future event.
export const assertNotFuture = (event, asOf) => {
    if (!isVisibleAt(event, asOf)) {
        throw new FutureEventRejected(
            `event disseminated ${event.disseminatedAt} is after as_of ${asOf}`);
    }
    return event;
};

// Ingestion time is separate from event time throughout. Lag is evidence about
// the pipeline, never a reason to move the event's own timestamp.
export const ingestionLagMs = (event) => {
    const disseminated = new Date(event.disseminatedAt).getTime();
    const received = new Date(event.receivedAt).getTime();
    if (!Number.isFinite(disseminated) || !Number.isFinite(received)) return null;
    return received - disseminated;
};
