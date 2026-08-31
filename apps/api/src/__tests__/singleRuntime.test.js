import { describe, expect, it, vi } from "vitest";
import { otherRuntimeRunning } from "../agent.js";

// Importing this module must not start a trader. agent.js called start() at the
// top level, so a test reaching for one of its helpers booted a runtime against
// whatever database the environment happened to point at.

// One account, one brain.
//
// The Go plane refuses a second instance through its Redis ownership lease. The
// Node runtime had no equivalent, so running `npm run agent` twice gave one
// account two orchestrators: two of every decision, paid for twice, and two of
// everything in the cockpit. Duplicate ORDERS were already impossible — both
// would derive the same client order id and the engine absorbs the second — so
// this is about spend and legibility, not about safety.

const client = (raw) => ({ get: vi.fn(async () => raw) });

describe("a second trader refuses to start", () => {
    it("sees nothing when no heartbeat exists", async () => {
        expect(await otherRuntimeRunning(client(null), 100)).toBeNull();
    });

    it("names the trader that is already running", async () => {
        const raw = JSON.stringify({ pid: 4242, at: "2026-09-01T04:00:00.000Z" });
        expect(await otherRuntimeRunning(client(raw), 100))
            .toEqual({ pid: 4242, at: "2026-09-01T04:00:00.000Z" });
    });

    // A process restarting inside the heartbeat's TTL must not block itself.
    it("does not mistake its own heartbeat for someone else's", async () => {
        const raw = JSON.stringify({ pid: 100, at: "2026-09-01T04:00:00.000Z" });
        expect(await otherRuntimeRunning(client(raw), 100)).toBeNull();
    });

    // Absence of evidence, not evidence of a running trader: refusing to start
    // on a corrupt key would keep the trader down for no reason.
    it("treats an unreadable heartbeat as no evidence", async () => {
        expect(await otherRuntimeRunning(client("not json"), 100)).toBeNull();
    });

    it("treats a heartbeat with no pid as no evidence", async () => {
        expect(await otherRuntimeRunning(client(JSON.stringify({ at: "x" })), 100)).toBeNull();
    });
});
