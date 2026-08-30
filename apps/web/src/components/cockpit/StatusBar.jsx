import { clockTime, ago, UNKNOWN } from "./format.js";

// Always visible. Unsafe states must be impossible to miss, and the mode badge
// must make it impossible to believe real money is involved.

const Pill = ({ label, value, tone = "neutral" }) => (
    <div className={`ck-pill ck-pill-${tone}`}>
        <span className="ck-pill-label">{label}</span>
        <span className="ck-pill-value">{value}</span>
    </div>
);

const sessionTone = (session) => {
    switch (session) {
        case "OPEN": return "good";
        case "PRE_MARKET":
        case "CLOSING": return "warn";
        case "HALTED": return "bad";
        default: return "neutral";
    }
};

const feedTone = (connection) => {
    if (!connection) return "unknown";
    if (connection.state === "CONNECTED" && connection.trusted) return "good";
    if (connection.state === "CONNECTED") return "warn";
    return "bad";
};

const feedLabel = (connection) => {
    if (!connection) return UNKNOWN;
    if (connection.state !== "CONNECTED") return connection.state;
    return connection.trusted ? "CONNECTED" : "STALE";
};

const brainTone = (brain) => (brain === "THINKING" ? "think"
    : brain === "EXECUTING" ? "warn" : "neutral");

export const StatusBar = ({ snapshot, events, connected }) => {
    const health = snapshot?.health ?? null;
    const narration = snapshot?.narration ?? null;
    const world = snapshot?.world ?? null;
    const runtime = snapshot?.runtime ?? null;
    const last = events[events.length - 1] ?? null;

    const halted = world?.halted || health?.orchestrator?.halted;
    const risk = halted ? "HALTED"
        : health?.newExposurePermitted === false ? "BLOCKED" : "ARMED";
    const plane = runtime?.fastPlane?.mode
        ? runtime.fastPlane.mode.toUpperCase() : "OFF";

    return (
        <header className="ck-status">
            <div className="ck-brand">
                <span className="ck-brand-name">ZENTRADE AI TRADER</span>
                <span className="ck-mode" title="No order-placement code exists in this system.">
                    PAPER MODE
                </span>
            </div>
            <div className="ck-pills">
                <Pill label="Market" value={world?.session ?? UNKNOWN}
                      tone={sessionTone(world?.session)} />
                <Pill label="Feed" value={feedLabel(health?.connection)}
                      tone={feedTone(health?.connection)} />
                <Pill label="Fast plane" value={plane}
                      tone={plane === "OFF" ? "neutral" : "good"} />
                <Pill label="Brain" value={narration?.brain ?? UNKNOWN}
                      tone={brainTone(narration?.brain)} />
                <Pill label="Risk" value={risk}
                      tone={risk === "ARMED" ? "good" : "bad"} />
                <Pill label="Queue" value={world?.queueDepth ?? UNKNOWN} />
                <Pill label="Reasoning today"
                      value={narration?.counters?.reasoningCalls ?? UNKNOWN} />
                <Pill label="Last event"
                      value={last ? clockTime(last.at) : UNKNOWN} />
                <Pill label="Stream" value={connected ? "LIVE" : "RECONNECTING"}
                      tone={connected ? "good" : "warn"} />
            </div>
        </header>
    );
};

export const StandbyBanner = ({ snapshot, events }) => {
    const world = snapshot?.world ?? null;
    const health = snapshot?.health ?? null;
    const brain = snapshot?.narration?.brain;
    const last = events[events.length - 1] ?? null;

    if (world?.halted) {
        return <div className="ck-banner ck-banner-bad">
            HALTED — no new exposure, no exits, observation only
        </div>;
    }
    if (health?.connection && !health.connection.trusted
        && world?.session === "OPEN") {
        return <div className="ck-banner ck-banner-bad">
            FEED STALE — new exposure blocked
        </div>;
    }
    if (world?.session === "CLOSED") {
        return <div className="ck-banner ck-banner-quiet">
            MARKET CLOSED — autonomous trader on standby
        </div>;
    }
    if (brain === "THINKING") return null;
    return <div className="ck-banner ck-banner-quiet">
        WAITING FOR MATERIAL CHANGE
        {last ? <span className="ck-banner-sub">
            {" "}· quiet for {ago(last.at)}</span> : null}
    </div>;
};

export default StatusBar;
