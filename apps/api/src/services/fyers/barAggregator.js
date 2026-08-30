// Deterministic 1m/5m/15m bar aggregation from the existing Fyers tick stream.
//
// There was no bar feed: the websocket wrote only `stock:SYMBOL` (last price),
// so the whole intelligence layer was starved. This builds bars from the ticks
// that were already arriving. It creates no second Fyers client, no second
// rate limiter, and no second connection.
//
// Redis holds the low-latency operational view. The research spine remains
// authoritative for historical and replay data and is untouched.
//
// VOLUME: Fyers ticks carry `vol_traded_today`, which is CUMULATIVE for the
// session, not per-tick. Bar volume is therefore the delta across the bar.
// Summing the raw field would multiply a day's volume by the tick count.

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

export const SESSION_OPEN_IST = 9 * 60 + 15;    // 09:15
export const SESSION_CLOSE_IST = 15 * 60 + 30;  // 15:30

export const GRANULARITY_MINUTES = { "1m": 1, "5m": 5, "15m": 15 };

// A bar stamped T covers [T, T+interval), so the last valid START is
// close - interval. 15:30 is never a valid 1m bar: it would cover 15:30-15:31,
// entirely after the bell. This matches the frozen spine_v2 rule exactly.
export const lastBarStartMinute = (granularity) =>
    SESSION_CLOSE_IST - GRANULARITY_MINUTES[granularity];

export const istMinutesOf = (epochMs) => {
    const ist = new Date(epochMs + IST_OFFSET_MS);
    return ist.getUTCHours() * 60 + ist.getUTCMinutes();
};

export const istDateOf = (epochMs) =>
    new Date(epochMs + IST_OFFSET_MS).toISOString().slice(0, 10);

// Is this instant inside the continuous session and able to start a bar?
export const isTradableMinute = (epochMs, granularity = "1m") => {
    const minutes = istMinutesOf(epochMs);
    return minutes >= SESSION_OPEN_IST && minutes <= lastBarStartMinute(granularity);
};

// The bucket a tick belongs to, as IST minutes since midnight.
export const bucketStartMinute = (epochMs, granularity) => {
    const size = GRANULARITY_MINUTES[granularity];
    const minutes = istMinutesOf(epochMs);
    const offset = minutes - SESSION_OPEN_IST;
    if (offset < 0) return null;
    return SESSION_OPEN_IST + Math.floor(offset / size) * size;
};

// UTC ISO timestamp for a bucket, so bars carry an unambiguous instant.
export const bucketTimestamp = (epochMs, granularity) => {
    const startMinute = bucketStartMinute(epochMs, granularity);
    if (startMinute === null) return null;
    const dayStartUtc = Date.UTC(
        ...istDateOf(epochMs).split("-").map((v, i) => (i === 1 ? Number(v) - 1 : Number(v))));
    return new Date(dayStartUtc + startMinute * 60_000 - IST_OFFSET_MS).toISOString();
};

// In-progress bar, updated tick by tick. Pure: no clock, no I/O.
export const applyTick = (bar, tick) => {
    const price = tick.price;
    if (!Number.isFinite(price)) return bar;

    if (!bar) {
        return {
            ts: tick.ts, open: price, high: price, low: price, close: price,
            // Anchor on the cumulative figure; volume is the delta from here.
            volumeAnchor: Number.isFinite(tick.cumulativeVolume) ? tick.cumulativeVolume : null,
            volume: 0, ticks: 1, lastTickAt: tick.at,
        };
    }

    // Out-of-order ticks are ignored rather than rewriting a closed price.
    if (tick.at < bar.lastTickAt) return bar;

    const volume = bar.volumeAnchor !== null && Number.isFinite(tick.cumulativeVolume)
        ? Math.max(0, tick.cumulativeVolume - bar.volumeAnchor)
        : bar.volume;

    return {
        ...bar,
        high: Math.max(bar.high, price),
        low: Math.min(bar.low, price),
        close: price,
        volume,
        ticks: bar.ticks + 1,
        lastTickAt: tick.at,
    };
};

// Roll 1m bars up. Derivation from one authoritative source keeps 5m and 15m
// consistent with 1m by construction instead of by coincidence.
export const rollUp = (bars1m, granularity) => {
    const size = GRANULARITY_MINUTES[granularity];
    const buckets = new Map();

    for (const bar of bars1m) {
        const epoch = new Date(bar.ts).getTime();
        const startMinute = bucketStartMinute(epoch, granularity);
        if (startMinute === null) continue;
        const key = `${istDateOf(epoch)}:${startMinute}`;
        const existing = buckets.get(key);
        if (!existing) {
            buckets.set(key, {
                ts: bucketTimestamp(epoch, granularity),
                open: bar.open, high: bar.high, low: bar.low, close: bar.close,
                volume: bar.volume, ticks: bar.ticks ?? 0,
            });
        } else {
            existing.high = Math.max(existing.high, bar.high);
            existing.low = Math.min(existing.low, bar.low);
            existing.close = bar.close;
            existing.volume += bar.volume;
            existing.ticks += bar.ticks ?? 0;
        }
    }
    return [...buckets.values()].sort((a, b) => a.ts.localeCompare(b.ts));
};

export const MAX_BARS = 240;   // ~4 hours of 1m, ample for a 60-bar baseline

// Redis-backed aggregator. One instance per process; the websocket feeds it.
export class BarAggregator {
    constructor({ redis, maxBars = MAX_BARS, logger = null } = {}) {
        this.redis = redis;
        this.maxBars = maxBars;
        this.logger = logger;
        this.current = new Map();     // symbol -> { minute, bar }
        this.stats = { ticks: 0, ignoredOutOfSession: 0, ignoredOutOfOrder: 0, barsClosed: 0 };
    }

    // Called for every sanitised tick. Returns the closed bar when this tick
    // rolled the minute over, otherwise null.
    async ingest(tick) {
        const at = tick.timestamp ?? Date.now();
        if (!isTradableMinute(at, "1m")) {
            this.stats.ignoredOutOfSession += 1;
            return null;
        }
        this.stats.ticks += 1;

        const minute = bucketStartMinute(at, "1m");
        const key = `${istDateOf(at)}:${minute}`;
        const entry = this.current.get(tick.symbol);

        const normalized = {
            ts: bucketTimestamp(at, "1m"),
            price: tick.price,
            cumulativeVolume: Number.isFinite(tick.volume) ? tick.volume : null,
            at,
        };

        // Same bucket: keep accumulating.
        if (entry && entry.key === key) {
            const before = entry.bar.ticks;
            entry.bar = applyTick(entry.bar, normalized);
            if (entry.bar.ticks === before) this.stats.ignoredOutOfOrder += 1;
            return null;
        }

        // The minute rolled over: persist the completed bar, start a new one.
        let closed = null;
        if (entry) {
            closed = entry.bar;
            await this.persist(tick.symbol, closed);
            this.stats.barsClosed += 1;
        }
        this.current.set(tick.symbol, { key, bar: applyTick(null, normalized) });
        return closed;
    }

    async persist(symbol, bar) {
        const payload = JSON.stringify({
            ts: bar.ts, open: bar.open, high: bar.high, low: bar.low,
            close: bar.close, volume: bar.volume, ticks: bar.ticks,
        });
        const listKey = `bars:1m:${symbol}`;
        try {
            // Duplicate suppression: an identical trailing bar is not appended.
            const last = await this.redis.lindex(listKey, -1);
            if (last) {
                try {
                    if (JSON.parse(last).ts === bar.ts) return;
                } catch { /* malformed tail, overwrite by appending */ }
            }
            await this.redis.rpush(listKey, payload);
            await this.redis.ltrim(listKey, -this.maxBars, -1);
            await this.rebuildDerived(symbol, bar);
        } catch (err) {
            this.logger?.error?.("BarAggregator", "persist failed",
                                 { error: err.message, symbol });
        }
    }

    // 5m and 15m are derived from the stored 1m series, never accumulated
    // separately, so they cannot drift from it.
    // Only the bucket containing the closed bar can have changed, and because
    // bars close in order that bucket is always the last one. Recomputing the
    // whole series instead cost 87.5 ms across the universe at the minute
    // boundary, and every tick arriving in that window queued behind it --
    // including a tick crossing a stop.
    async rebuildDerived(symbol, closedBar = null) {
        if (closedBar === null) return this.rebuildDerivedFull(symbol);

        const epoch = new Date(closedBar.ts).getTime();
        if (!Number.isFinite(epoch)) return this.rebuildDerivedFull(symbol);

        for (const granularity of ["5m", "15m"]) {
            const startMinute = bucketStartMinute(epoch, granularity);
            if (startMinute === null) continue;
            const bucketTs = bucketTimestamp(epoch, granularity);
            const size = GRANULARITY_MINUTES[granularity];

            // The 1m bars belonging to this bucket, and only those.
            const window = await this.redis.lrange(`bars:1m:${symbol}`, -size, -1);
            const members = [];
            for (const entry of window ?? []) {
                try {
                    const bar = JSON.parse(entry);
                    const barEpoch = new Date(bar.ts).getTime();
                    if (!Number.isFinite(barEpoch)) continue;
                    if (bucketStartMinute(barEpoch, granularity) === startMinute
                        && istDateOf(barEpoch) === istDateOf(epoch)) {
                        members.push(bar);
                    }
                } catch { /* skip malformed */ }
            }
            if (!members.length) continue;

            const [rolled] = rollUp(members, granularity);
            if (!rolled) continue;

            const key = `bars:${granularity}:${symbol}`;
            const tail = await this.redis.lindex(key, -1);
            let replace = false;
            if (tail) {
                try { replace = JSON.parse(tail).ts === bucketTs; } catch { replace = false; }
            }

            if (replace) {
                await this.redis.lset(key, -1, JSON.stringify(rolled));
            } else {
                await this.redis.rpush(key, JSON.stringify(rolled));
                await this.redis.ltrim(key, -this.maxBars, -1);
            }
        }
    }

    // The whole-series rebuild. Retained for recovery, where the derived series
    // may be missing or inconsistent and there is no single closed bar to
    // reason from. Never on the hot path.
    async rebuildDerivedFull(symbol) {
        const raw = await this.redis.lrange(`bars:1m:${symbol}`, -this.maxBars, -1);
        const bars1m = [];
        for (const entry of raw ?? []) {
            try { bars1m.push(JSON.parse(entry)); } catch { /* skip */ }
        }
        for (const granularity of ["5m", "15m"]) {
            const rolled = rollUp(bars1m, granularity);
            const key = `bars:${granularity}:${symbol}`;
            const pipeline = this.redis.pipeline();
            pipeline.del(key);
            for (const bar of rolled.slice(-this.maxBars)) {
                pipeline.rpush(key, JSON.stringify(bar));
            }
            await pipeline.exec();
        }
    }

    // Close every bar whose minute has passed, on a clock rather than on the
    // arrival of the next tick.
    //
    // A bar used to be published only when the following minute's first tick
    // arrived. On a thin symbol that could be tens of seconds late, and on the
    // last bar of the session it never arrived at all, so bar-scale
    // intelligence ran on a cadence set by tick density rather than by time.
    async closeCompleted(nowMs = Date.now()) {
        const currentMinute = bucketStartMinute(nowMs, "1m");
        const currentKey = currentMinute === null
            ? null : `${istDateOf(nowMs)}:${currentMinute}`;
        const closed = [];
        for (const [symbol, entry] of [...this.current]) {
            if (entry.key === currentKey) continue;   // still accumulating
            await this.persist(symbol, entry.bar);
            this.current.delete(symbol);
            this.stats.barsClosed += 1;
            closed.push(symbol);
        }
        return closed;
    }

    // Flush in-progress bars, e.g. at the close or on shutdown.
    async flush() {
        const flushed = [];
        for (const [symbol, entry] of this.current) {
            await this.persist(symbol, entry.bar);
            flushed.push(symbol);
        }
        this.current.clear();
        return flushed;
    }

    health() {
        return { ...this.stats, symbolsInProgress: this.current.size };
    }
}
