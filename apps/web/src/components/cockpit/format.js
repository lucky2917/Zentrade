// Formatting for the cockpit.
//
// One rule throughout: a value the system does not have is shown as UNKNOWN.
// A dash, a zero or a blank all read as information; UNKNOWN reads as absence,
// which is what it is.

export const UNKNOWN = "UNKNOWN";

export const rupees = (paise) => {
    if (paise === null || paise === undefined || !Number.isFinite(Number(paise))) return UNKNOWN;
    return `₹${(Number(paise) / 100).toLocaleString("en-IN", {
        minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

export const signedRupees = (paise) => {
    if (paise === null || paise === undefined || !Number.isFinite(Number(paise))) return UNKNOWN;
    const value = Number(paise);
    return `${value >= 0 ? "+" : "−"}${rupees(Math.abs(value))}`;
};

export const percent = (value, digits = 2) => {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return UNKNOWN;
    return `${Number(value) >= 0 ? "+" : "−"}${Math.abs(Number(value)).toFixed(digits)}%`;
};

export const ratio = (value, digits = 2) => {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return UNKNOWN;
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
    (value ?? UNKNOWN).toString().replaceAll("_", " ");

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
