// Shadow replay generator.
//
// Twenty hand-built fixtures prove the contract's named cases. They do not
// prove that two implementations agree over a session's worth of traffic, where
// latches interleave, windows slide and volume minutes roll over.
//
// This drives the incumbent Node implementation over a deterministic synthetic
// session and records both the input and every event it produced. The Go plane
// replays the same input and must produce the same output, event for event.
//
// Deterministic by construction: one seeded generator, written to a file, so
// both runtimes read identical input rather than each generating its own.
//
// Usage: node scripts/shadowReplay.js <outputDir>

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { ReflexLane, DIRECTION } from "../src/services/tick/reflex.js";

const out = process.argv[2];
if (!out) {
    process.stderr.write("usage: node scripts/shadowReplay.js <outputDir>\n");
    process.exit(2);
}

const SYMBOLS = 200;
const TICKS_PER_SYMBOL = 500;
const ARMED_FRACTION = 0.4;
const WATCHED_FRACTION = 0.8;

// xorshift32. Small, deterministic, and its exact distribution does not matter:
// what matters is that the same sequence reaches both runtimes.
let seed = 0x5eed1234;
const rand = () => {
    seed ^= seed << 13; seed >>>= 0;
    seed ^= seed >>> 17;
    seed ^= seed << 5;  seed >>>= 0;
    return seed / 0x100000000;
};

const symbols = Array.from({ length: SYMBOLS }, (_, i) => `SYM${String(i).padStart(3, "0")}`);

const commitments = [];
const watches = [];
for (let i = 0; i < symbols.length; i += 1) {
    const symbol = symbols[i];
    const entry = 100_000 + Math.floor(rand() * 50_000);
    if (i < SYMBOLS * ARMED_FRACTION) {
        commitments.push({
            symbol, thesisId: `t-${i}`, direction: i % 7 === 0 ? DIRECTION.SHORT : DIRECTION.LONG,
            stopPaise: Math.round(entry * 0.97), targetPaise: Math.round(entry * 1.05),
            invalidationPaise: i % 5 === 0 ? Math.round(entry * 0.96) : null,
            quantity: 10 + i, correlationId: `c-${i}`,
        });
    }
    if (i < SYMBOLS * WATCHED_FRACTION) {
        watches.push({
            symbol, entryPaise: entry, thesisId: `t-${i}`, correlationId: `c-${i}`,
            direction: i % 7 === 0 ? DIRECTION.SHORT : DIRECTION.LONG,
            vwapPaise: i % 3 === 0 ? Math.round(entry * 1.001) : undefined,
            volumeBaseline: i % 4 === 0 ? 1000 + i : undefined,
            volumeSpikeRatio: i % 4 === 0 ? 3 : undefined,
        });
    }
}

// Interleaved across symbols, as a single connection delivers them.
const ticks = [];
const price = new Map(symbols.map((s, i) => [s, 100_000 + Math.floor(rand() * 50_000)]));
const volume = new Map(symbols.map((s) => [s, 400_000 + Math.floor(rand() * 100_000)]));
let at = 1_700_000_000_000;
for (let round = 0; round < TICKS_PER_SYMBOL; round += 1) {
    for (const symbol of symbols) {
        // Mostly small moves with occasional jumps, so latches, velocity windows
        // and approach bands all get exercised rather than one of them.
        const shock = rand() < 0.02 ? (rand() - 0.5) * 0.08 : (rand() - 0.5) * 0.004;
        const next = Math.max(1, Math.round(price.get(symbol) * (1 + shock)));
        price.set(symbol, next);
        volume.set(symbol, volume.get(symbol) + Math.floor(rand() * 900));
        at += 7;
        ticks.push({ symbol, pricePaise: next, receiveTs: at,
                     cumulativeVolume: volume.get(symbol) });
    }
}

const lane = new ReflexLane({ clock: () => 0 });
for (const c of commitments) {
    lane.arm(c.symbol, {
        thesisId: c.thesisId, direction: c.direction,
        stopPaise: c.stopPaise, targetPaise: c.targetPaise,
        invalidationPaise: c.invalidationPaise,
        quantity: c.quantity, correlationId: c.correlationId,
    });
}
for (const w of watches) {
    lane.watch(w.symbol, {
        entryPaise: w.entryPaise, thesisId: w.thesisId,
        correlationId: w.correlationId, direction: w.direction,
    });
    if (w.vwapPaise !== undefined) lane.updateVwap(w.symbol, w.vwapPaise);
    if (w.volumeBaseline !== undefined) {
        lane.updateVolumeBaseline(w.symbol,
            { baseline: w.volumeBaseline, ratio: w.volumeSpikeRatio });
    }
}

const SEVERITY = {
    STOP: "CRITICAL", INVALIDATION: "CRITICAL", TARGET: "WARNING",
    STOP_APPROACH: "WARNING", PRICE_JUMP: "WARNING", VWAP_DEVIATION: "WARNING",
    VOLUME_SPIKE: "WARNING", TARGET_APPROACH: "INFO",
};

const events = [];
for (const tick of ticks) {
    for (const c of lane.onTick({
        symbol: tick.symbol, pricePaise: tick.pricePaise, at: tick.receiveTs,
        cumulativeVolume: tick.cumulativeVolume,
    })) {
        events.push({
            contract: "zentrade.marketdata.event.v1",
            kind: c.kind, symbol: c.symbol, severity: SEVERITY[c.kind],
            reason: c.reason ?? `${c.kind} crossed at ${c.pricePaise} against ${c.levelPaise}`,
            pricePaise: c.pricePaise, levelPaise: c.levelPaise,
            thesisId: c.thesisId, correlationId: c.correlationId,
            observedTs: c.at, sequence: lane.snapshot(c.symbol).seq,
        });
    }
}

const finalState = symbols.map((symbol) => {
    const s = lane.snapshot(symbol);
    return { symbol, lastPaise: s.last, highPaise: s.high, lowPaise: s.low,
             sequence: s.seq, updatedTs: s.at };
});

mkdirSync(out, { recursive: true });
writeFileSync(join(out, "setup.json"), JSON.stringify({ commitments, watches }, null, 2));
writeFileSync(join(out, "ticks.jsonl"), ticks.map((t) => JSON.stringify(t)).join("\n") + "\n");
writeFileSync(join(out, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
writeFileSync(join(out, "finalState.json"), JSON.stringify(finalState, null, 2));

const byKind = {};
for (const e of events) byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
process.stdout.write(`ticks   ${ticks.length}\nevents  ${events.length}\n`);
for (const [k, n] of Object.entries(byKind).sort()) {
    process.stdout.write(`  ${k.padEnd(18)} ${n}\n`);
}
