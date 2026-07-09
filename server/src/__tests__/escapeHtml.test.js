import { describe, it, expect } from "vitest";
import { escapeHtml } from "../utils/escapeHtml.js";

describe("escapeHtml", () => {
    it("escapes all HTML-significant characters", () => {
        expect(escapeHtml(`<img src=x onerror="alert('xss')">&`))
            .toBe("&lt;img src=x onerror=&quot;alert(&#39;xss&#39;)&quot;&gt;&amp;");
    });

    it("passes plain text through unchanged", () => {
        expect(escapeHtml("Target hit at ₹1,748 — square off by 2:45 PM")).toBe(
            "Target hit at ₹1,748 — square off by 2:45 PM"
        );
    });

    it("stringifies non-string values and tolerates null/undefined", () => {
        expect(escapeHtml(1748.5)).toBe("1748.5");
        expect(escapeHtml(null)).toBe("");
        expect(escapeHtml(undefined)).toBe("");
    });
});
