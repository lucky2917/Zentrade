// Golden fixture generator for the market-data contract.
//
// Fixtures are produced FROM the Node implementation, which is the behaviour
// currently in production. The Go port must reproduce them exactly. Generating
// them from the incumbent rather than hand-writing them is what makes "zero
// divergence" a real claim rather than a matched pair of assumptions.
//
// Regenerate with:  node scripts/generateReflexFixtures.js
// A regeneration that changes existing fixtures is a behaviour change and must
// be justified, not waved through.

import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ReflexLane, CROSSING, DIRECTION } from "../src/services/tick/reflex.js";

const OUT = join(dirname(fileURLToPath(import.meta.url)),
                 "../../../contracts/market-data/v1/fixtures");

const SEVERITY = {
    [CROSSING.STOP]: "CRITICAL",
    [CROSSING.INVALIDATION]: "CRITICAL",
    [CROSSING.TARGET]: "WARNING",
    [CROSSING.STOP_APPROACH]: "WARNING",
    [CROSSING.PRICE_JUMP]: "WARNING",
    [CROSSING.VWAP_DEVIATION]: "WARNING",
    [CROSSING.VOLUME_SPIKE]: "WARNING",
    [CROSSING.TARGET_APPROACH]: "INFO",
};

// One scenario: arm some commitments, feed a tick sequence, record every
// crossing emitted and the final state of each symbol.
const run = ({ name, description, commitments, watches = [], ticks }) => {
    const lane = new ReflexLane({ clock: () => 0 });
    for (const c of commitments) {
        lane.arm(c.symbol, {
            thesisId: c.thesisId,
            direction: c.direction,
            stopPaise: c.stopPaise ?? null,
            targetPaise: c.targetPaise ?? null,
            invalidationPaise: c.invalidationPaise ?? null,
            quantity: c.quantity,
            correlationId: c.correlationId,
        });
    }

    // Continuous detection is off unless a watch asks for it, which is why
    // adding it changed none of the fixtures above.
    for (const w of watches) {
        lane.watch(w.symbol, {
            entryPaise: w.entryPaise ?? null,
            thesisId: w.thesisId ?? null,
            correlationId: w.correlationId ?? null,
            direction: w.direction ?? DIRECTION.LONG,
            ...(w.approachFraction !== undefined ? { approachFraction: w.approachFraction } : {}),
            ...(w.jumpPercent !== undefined ? { jumpPercent: w.jumpPercent } : {}),
            ...(w.velocityWindowMs !== undefined ? { velocityWindowMs: w.velocityWindowMs } : {}),
            ...(w.vwapDeviation !== undefined ? { vwapDeviation: w.vwapDeviation } : {}),
        });
        if (w.vwapPaise !== undefined) lane.updateVwap(w.symbol, w.vwapPaise);
        if (w.volumeBaseline !== undefined) {
            lane.updateVolumeBaseline(w.symbol,
                { baseline: w.volumeBaseline, ratio: w.volumeSpikeRatio });
        }
    }

    const events = [];
    for (const tick of ticks) {
        const crossings = lane.onTick({
            symbol: tick.symbol, pricePaise: tick.pricePaise, at: tick.receiveTs,
            cumulativeVolume: tick.cumulativeVolume ?? null,
        });
        for (const c of crossings) {
            events.push({
                contract: "zentrade.marketdata.event.v1",
                kind: c.kind,
                symbol: c.symbol,
                severity: SEVERITY[c.kind],
                reason: c.reason
                    ?? `${c.kind} crossed at ${c.pricePaise} against ${c.levelPaise}`,
                pricePaise: c.pricePaise,
                levelPaise: c.levelPaise,
                thesisId: c.thesisId,
                correlationId: c.correlationId,
                observedTs: c.at,
                sequence: lane.snapshot(c.symbol).seq,
            });
        }
    }

    const symbols = [...new Set(ticks.map((t) => t.symbol))].sort();
    const finalState = symbols.map((symbol) => {
        const s = lane.snapshot(symbol);
        return s === null ? { symbol, observed: false } : {
            symbol, observed: true,
            lastPaise: s.last, highPaise: s.high, lowPaise: s.low,
            sequence: s.seq, updatedTs: s.at,
        };
    });

    return {
        contract: "zentrade.marketdata.v1",
        name, description,
        input: { commitments, watches, ticks },
        expected: { events, finalState },
    };
};

const L = DIRECTION.LONG, S = DIRECTION.SHORT;
const tick = (symbol, pricePaise, receiveTs) => ({ symbol, pricePaise, receiveTs });
const vtick = (symbol, pricePaise, receiveTs, cumulativeVolume) =>
    ({ symbol, pricePaise, receiveTs, cumulativeVolume });
const commit = (over) => ({
    symbol: "RELIANCE", thesisId: "t-1", direction: L,
    stopPaise: 98_000, targetPaise: 108_000, invalidationPaise: null,
    quantity: 200, correlationId: "c-1", ...over,
});

const SCENARIOS = [
    {
        name: "quiet_inside_levels",
        description: "Price moves inside the levels. No crossing, but state advances.",
        commitments: [commit({})],
        ticks: [tick("RELIANCE", 100_000, 1000), tick("RELIANCE", 99_500, 1001),
                tick("RELIANCE", 98_100, 1002), tick("RELIANCE", 100_200, 1003)],
    },
    {
        name: "stop_crossed_once",
        description: "The tick that breaches the stop fires once; later ticks below it do not.",
        commitments: [commit({})],
        ticks: [tick("RELIANCE", 98_100, 1000), tick("RELIANCE", 97_990, 1001),
                tick("RELIANCE", 97_500, 1002), tick("RELIANCE", 96_000, 1003)],
    },
    {
        name: "stop_touched_exactly",
        description: "Touching the level is breaching it.",
        commitments: [commit({})],
        ticks: [tick("RELIANCE", 98_000, 1000)],
    },
    {
        name: "transient_breach_and_recovery",
        description: "A spike through the stop that retraces still fires, and the extremes remember it.",
        commitments: [commit({})],
        ticks: [tick("RELIANCE", 100_000, 1000), tick("RELIANCE", 97_800, 1001),
                tick("RELIANCE", 100_200, 1002)],
    },
    {
        name: "target_reached",
        description: "A target crossing is a warning, not an exit.",
        commitments: [commit({})],
        ticks: [tick("RELIANCE", 107_000, 1000), tick("RELIANCE", 108_500, 1001),
                tick("RELIANCE", 109_000, 1002)],
    },
    {
        name: "short_mirrors_the_levels",
        description: "A short is stopped above and targets below.",
        commitments: [commit({ direction: S, stopPaise: 102_000, targetPaise: 92_000 })],
        ticks: [tick("RELIANCE", 101_000, 1000), tick("RELIANCE", 102_500, 1001)],
    },
    {
        name: "invalidation_without_a_stop",
        description: "A named invalidation price fires on its own.",
        commitments: [commit({ stopPaise: null, invalidationPaise: 97_000 })],
        ticks: [tick("RELIANCE", 97_500, 1000), tick("RELIANCE", 96_900, 1001)],
    },
    {
        name: "stop_and_invalidation_same_tick",
        description: "Evaluation order is stop, then invalidation, then target, and it is stable.",
        commitments: [commit({ invalidationPaise: 98_500 })],
        ticks: [tick("RELIANCE", 97_000, 1000)],
    },
    {
        name: "unarmed_symbol_is_tracked_but_silent",
        description: "State advances for a symbol with no commitment; no event is produced.",
        commitments: [],
        ticks: [tick("TCS", 50_000, 1000), tick("TCS", 51_000, 1001), tick("TCS", 49_000, 1002)],
    },
    {
        name: "multiple_symbols_are_independent",
        description: "One symbol crossing does not disturb another.",
        commitments: [commit({}), commit({ symbol: "TCS", thesisId: "t-2", stopPaise: 40_000,
                                           targetPaise: 60_000, correlationId: "c-2" })],
        ticks: [tick("RELIANCE", 100_000, 1000), tick("TCS", 50_000, 1001),
                tick("RELIANCE", 97_000, 1002), tick("TCS", 50_500, 1003),
                tick("TCS", 39_500, 1004)],
    },
    {
        name: "non_positive_price_is_ignored",
        description: "A zero or negative price does not advance state and produces nothing.",
        commitments: [commit({})],
        ticks: [tick("RELIANCE", 100_000, 1000), tick("RELIANCE", 0, 1001),
                tick("RELIANCE", -5, 1002), tick("RELIANCE", 99_000, 1003)],
    },
    {
        name: "extremes_track_the_whole_window",
        description: "Running high and low span every accepted tick, not just the endpoints.",
        commitments: [],
        ticks: [tick("INFY", 100_000, 1000), tick("INFY", 103_400, 1001),
                tick("INFY", 99_100, 1002), tick("INFY", 100_000, 1003)],
    },
    {
        name: "approach_bands_fire_on_the_tick",
        description: "Entering the stop band and the target band each fire once, and neither is protective.",
        commitments: [commit({})],
        watches: [{ symbol: "RELIANCE", entryPaise: 100_000, thesisId: "t-1", correlationId: "c-1" }],
        ticks: [tick("RELIANCE", 99_500, 1000), tick("RELIANCE", 98_400, 1001),
                tick("RELIANCE", 98_300, 1002), tick("RELIANCE", 106_500, 1003),
                tick("RELIANCE", 106_600, 1004)],
    },
    {
        name: "a_spike_that_reverses_between_polls",
        description: "A 3.5% move that returns inside fourteen seconds is invisible to a poll and is caught here.",
        commitments: [],
        watches: [{ symbol: "TCS", thesisId: "t-9", correlationId: "c-9" }],
        ticks: [tick("TCS", 100_000, 0), tick("TCS", 103_500, 7_000),
                tick("TCS", 100_000, 14_000)],
    },
    {
        name: "velocity_forgets_prices_outside_the_window",
        description: "The same move spread beyond the velocity window is a drift, not a jump.",
        commitments: [],
        watches: [{ symbol: "TCS", jumpPercent: 2.0, velocityWindowMs: 30_000 }],
        ticks: [tick("TCS", 100_000, 0), tick("TCS", 102_500, 90_000)],
    },
    {
        name: "vwap_deviation_against_a_pushed_value",
        description: "Deviation is judged against the bar plane's VWAP, and a new VWAP reopens the question.",
        commitments: [],
        watches: [{ symbol: "INFY", vwapPaise: 100_000, vwapDeviation: 0.02 }],
        ticks: [tick("INFY", 101_000, 1000), tick("INFY", 102_500, 1001),
                tick("INFY", 102_600, 1002)],
    },
    {
        name: "volume_spike_inside_the_minute",
        description: "Volume is cumulative for the session; the minute in progress is the delta from its first tick.",
        commitments: [],
        watches: [{ symbol: "VEDL", volumeBaseline: 1000, volumeSpikeRatio: 3 }],
        ticks: [vtick("VEDL", 50_000, 60_000, 500_000),
                vtick("VEDL", 50_100, 65_000, 501_000),
                vtick("VEDL", 50_200, 68_000, 503_000),
                vtick("VEDL", 50_300, 70_000, 504_000)],
    },
    {
        name: "volume_counter_going_backwards_re_anchors",
        description: "A reconnect restarts the cumulative counter; the delta must not go negative or fire falsely.",
        commitments: [],
        watches: [{ symbol: "VEDL", volumeBaseline: 1000, volumeSpikeRatio: 3 }],
        ticks: [vtick("VEDL", 50_000, 60_000, 900_000),
                vtick("VEDL", 50_100, 61_000, 100),
                vtick("VEDL", 50_200, 62_000, 200),
                vtick("VEDL", 50_300, 63_000, 3_100)],
    },
    {
        name: "protection_is_never_displaced_by_a_signal",
        description: "A stop crossing and an attention signal on the same tick both appear, stop first.",
        commitments: [commit({})],
        watches: [{ symbol: "RELIANCE", entryPaise: 100_000, jumpPercent: 1.0,
                    thesisId: "t-1", correlationId: "c-1" }],
        ticks: [tick("RELIANCE", 100_000, 1000), tick("RELIANCE", 97_000, 1001)],
    },
    {
        name: "an_unwatched_symbol_produces_no_signals",
        description: "Detection is off unless a watch asks for it; an armed symbol still protects.",
        commitments: [commit({})],
        watches: [],
        ticks: [tick("RELIANCE", 99_000, 1000), tick("RELIANCE", 105_000, 1001),
                tick("RELIANCE", 97_000, 1002)],
    },
];

mkdirSync(OUT, { recursive: true });
const index = [];
for (const scenario of SCENARIOS) {
    const fixture = run(scenario);
    writeFileSync(join(OUT, `${scenario.name}.json`), `${JSON.stringify(fixture, null, 2)}\n`);
    index.push({ name: scenario.name, description: scenario.description,
                 events: fixture.expected.events.length });
}
writeFileSync(join(OUT, "index.json"), `${JSON.stringify({
    contract: "zentrade.marketdata.v1",
    generatedFrom: "apps/api/src/services/tick/reflex.js",
    scenarios: index,
}, null, 2)}\n`);

console.log(`wrote ${index.length} fixtures to contracts/market-data/v1/fixtures`);
for (const s of index) console.log(`  ${s.name.padEnd(38)} ${s.events} event(s)`);
