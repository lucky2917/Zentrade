// The single scheduler.
//
// Replaces unsupervised `setInterval` calls with named jobs that have a
// lifecycle, error isolation and overlap prevention. Before this, a job could
// throw and vanish silently, two copies of a slow job could interleave, and
// nothing could report whether the system was alive.
//
// Design rules:
//   - one owner: start()/stop()/health()
//   - a job that throws is isolated; the scheduler and other jobs survive
//   - a job never overlaps itself; a slow cycle is skipped, not queued
//   - starting twice is a no-op, not a second set of timers
//   - stop() waits for in-flight work rather than abandoning it

export class Scheduler {
    constructor({ clock = () => new Date(), logger = null } = {}) {
        this.jobs = new Map();
        this.timers = new Map();
        this.running = false;
        this.clock = clock;
        this.logger = logger;
    }

    // `shouldRun` lets a job be session-aware without the scheduler knowing
    // anything about markets.
    register({ name, intervalMs, run, shouldRun = () => true, allowOverlap = false }) {
        if (this.jobs.has(name)) throw new Error(`job ${name} is already registered`);
        if (!Number.isFinite(intervalMs) || intervalMs <= 0)
            throw new Error(`job ${name} needs a positive intervalMs`);
        this.jobs.set(name, {
            name, intervalMs, run, shouldRun, allowOverlap,
            inFlight: false, runs: 0, skipped: 0, failures: 0,
            lastRunAt: null, lastSuccessAt: null, lastError: null, lastDurationMs: null,
        });
        return this;
    }

    async runJobOnce(name) {
        const job = this.jobs.get(name);
        if (!job) throw new Error(`unknown job ${name}`);

        // Claim the slot synchronously. Setting inFlight after an await lets
        // concurrent callers all pass the check before any of them sets it.
        if (!job.allowOverlap && job.inFlight) { job.skipped += 1; return { skipped: "in-flight" }; }
        job.inFlight = true;

        let permitted;
        try {
            permitted = await job.shouldRun();
        } catch (err) {
            job.inFlight = false;
            job.failures += 1; job.lastError = `shouldRun: ${err.message}`;
            this.logger?.error?.("Scheduler", `job ${name} shouldRun failed`, { error: err.message });
            return { skipped: "shouldRun-failed" };
        }
        if (!permitted) {
            job.inFlight = false;
            job.skipped += 1;
            return { skipped: "not-permitted" };
        }

        job.lastRunAt = this.clock();
        const started = Date.now();
        try {
            const result = await job.run();
            job.runs += 1;
            job.lastSuccessAt = this.clock();
            job.lastError = null;
            return { ok: true, result };
        } catch (err) {
            // Error isolation: a failing job must not take down the scheduler
            // or any other job.
            job.failures += 1;
            job.lastError = err.message;
            this.logger?.error?.("Scheduler", `job ${name} failed`, { error: err.message });
            return { ok: false, error: err.message };
        } finally {
            job.lastDurationMs = Date.now() - started;
            job.inFlight = false;
        }
    }

    start() {
        if (this.running) return false;   // duplicate start is a no-op
        this.running = true;
        for (const job of this.jobs.values()) {
            const timer = setInterval(() => {
                this.runJobOnce(job.name).catch(() => {});
            }, job.intervalMs);
            timer.unref?.();
            this.timers.set(job.name, timer);
        }
        return true;
    }

    async stop({ drainMs = 5000 } = {}) {
        if (!this.running) return false;  // duplicate stop is a no-op
        this.running = false;
        for (const timer of this.timers.values()) clearInterval(timer);
        this.timers.clear();

        // Let in-flight work finish rather than abandoning it mid-transaction.
        const deadline = Date.now() + drainMs;
        while (Date.now() < deadline) {
            if (![...this.jobs.values()].some((j) => j.inFlight)) break;
            await new Promise((r) => setTimeout(r, 20));
        }
        return true;
    }

    health() {
        const jobs = [...this.jobs.values()].map((j) => ({
            name: j.name, intervalMs: j.intervalMs, inFlight: j.inFlight,
            runs: j.runs, skipped: j.skipped, failures: j.failures,
            lastRunAt: j.lastRunAt, lastSuccessAt: j.lastSuccessAt,
            lastDurationMs: j.lastDurationMs, lastError: j.lastError,
            // A job whose cycle exceeds its interval will always be skipping.
            overrunning: j.lastDurationMs !== null && j.lastDurationMs > j.intervalMs,
        }));
        return {
            running: this.running,
            jobCount: jobs.length,
            healthy: this.running && jobs.every((j) => j.failures === 0 || j.lastError === null),
            jobs,
        };
    }
}
