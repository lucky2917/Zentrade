// Escape untrusted values before interpolating into HTML (email bodies).
// LLM output and news-derived text are attacker-influenceable.
const escapeHtml = (value) =>
    String(value ?? "").replace(/[&<>"']/g, (ch) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
    }[ch]));

export { escapeHtml };
