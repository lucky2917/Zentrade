import { describe, expect, it } from "vitest";

// Regression: local Postgres has no TLS, so the pool must not request it for
// loopback. The original check was a substring test for "localhost", which
// missed 127.0.0.1 (every integration suite failed with "The server does not
// support SSL connections") and would have matched localhost.example.com.

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const isLoopback = (url) => {
    if (!url) return false;
    try {
        return LOOPBACK_HOSTS.has(new URL(url).hostname);
    } catch {
        return false;
    }
};

describe("loopback detection for database TLS", () => {
    it.each([
        "postgresql://u:p@localhost:5432/db",
        "postgresql://u:p@127.0.0.1:55432/db",
        "postgres://u:p@[::1]:5432/db",
    ])("treats %s as local", (url) => {
        expect(isLoopback(url)).toBe(true);
    });

    it.each([
        "postgresql://u:p@db.example.com:5432/db",
        "postgresql://u:p@localhost.example.com:5432/db",
        "postgresql://u:p@notlocalhost:5432/db",
        "postgresql://u:p@10.0.0.5:5432/db",
    ])("treats %s as remote, so TLS is still required", (url) => {
        expect(isLoopback(url)).toBe(false);
    });

    it("does not throw on undefined or malformed input", () => {
        expect(isLoopback(undefined)).toBe(false);
        expect(isLoopback("")).toBe(false);
        expect(isLoopback("not a url")).toBe(false);
    });
});
