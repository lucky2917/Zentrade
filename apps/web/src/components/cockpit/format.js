// Formatting for the cockpit.
//
// One rule throughout: a value the system does not have is shown as UNKNOWN.
// A dash, a zero or a blank all read as information; UNKNOWN reads as absence,
// which is what it is.

export const UNKNOWN = "UNKNOWN";

// The one definition of "we have this value". Number(null) is 0, so a bare
// isFinite check quietly turns an absent figure into a real-looking zero.
export const isKnown = (value) =>
    value !== null && value !== undefined && Number.isFinite(Number(value));

export const rupees = (paise) => {
    if (!isKnown(paise)) return UNKNOWN;
    return `₹${(Number(paise) / 100).toLocaleString("en-IN", {
        minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

export const signedRupees = (paise) => {
    if (!isKnown(paise)) return UNKNOWN;
    const value = Number(paise);
    return `${value >= 0 ? "+" : "−"}${rupees(Math.abs(value))}`;
};

export const percent = (value, digits = 2) => {
    if (!isKnown(value)) return UNKNOWN;
    return `${Number(value) >= 0 ? "+" : "−"}${Math.abs(Number(value)).toFixed(digits)}%`;
};

export const ratio = (value, digits = 2) => {
    if (!isKnown(value)) return UNKNOWN;
    return Number(value).toFixed(digits);
};

// IST, because the operator is watching an Indian session.
export const clockTime = (iso) => {
    if (!iso) return UNKNOWN;
    const at = new Date(iso);
    if (Number.isNaN(at.getTime())) return UNKNOWN;
    return at.toLocaleTimeString("en-GB", { hour12: false, timeZone: "Asia/Kolkata" });
};

export const duration = (seconds) => {
    if (seconds === null || seconds === undefined || !Number.isFinite(Number(seconds))) return UNKNOWN;
    const total = Math.max(0, Math.floor(Number(seconds)));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h) return `${h}h ${m}m`;
    if (m) return `${m}m ${s}s`;
    return `${s}s`;
};

export const ago = (iso, now = Date.now()) => {
    if (!iso) return UNKNOWN;
    const at = new Date(iso).getTime();
    if (Number.isNaN(at)) return UNKNOWN;
    return duration((now - at) / 1000);
};

export const titleCase = (value) =>
    text(value, UNKNOWN).replaceAll("_", " ");

// Anything the backend hands us, rendered as something a person can read.
//
// Every field below comes from a model response or an event payload, and a
// shape that drifts by one level — `{condition: "..."}` where a string was
// expected — used to reach React as an object. React does not print
// "[object Object]" for that; it throws, and the whole cockpit goes white in
// front of whoever is watching. Nothing on this screen is worth that.
export const text = (value, fallback = UNKNOWN) => {
    if (value === null || value === undefined) return fallback;
    if (typeof value === "string") return value.trim() || fallback;
    if (typeof value === "number") return Number.isFinite(value) ? String(value) : fallback;
    if (typeof value === "boolean") return value ? "yes" : "no";
    if (Array.isArray(value)) {
        const parts = value.map((v) => text(v, "")).filter(Boolean);
        return parts.length ? parts.join("; ") : fallback;
    }
    if (typeof value === "object") {
        // The common shapes an object arrives in when a string was expected.
        for (const key of ["statement", "text", "reason", "label", "verdict",
                           "condition", "description", "message", "name"]) {
            if (typeof value[key] === "string" && value[key].trim()) return value[key];
        }
        const pairs = Object.entries(value)
            .filter(([, v]) => v !== null && v !== undefined && typeof v !== "object")
            .map(([k, v]) => `${k} ${v}`);
        return pairs.length ? pairs.join(", ") : fallback;
    }
    return fallback;
};

// Only three severities exist in the event vocabulary; anything else is a bug
// and should look like one rather than silently rendering as normal.
export const severityClass = (severity) => {
    switch (severity) {
        case "CRITICAL": return "sev-critical";
        case "WARNING": return "sev-warning";
        case "INFO": return "sev-info";
        default: return "sev-unknown";
    }
};

export const tierClass = (tier) => `tier-${(tier ?? "unknown").toLowerCase()}`;
