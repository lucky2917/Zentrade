# Market data contract, version 1

`zentrade.marketdata.v1`

The interface between whichever runtime owns the tick stream and everything
downstream. Both the Node and the Go implementations are written against this
file, and the golden fixtures in `fixtures/` are the executable form of it.

## Versioning

The contract identifier is embedded in every message. A consumer that does not
recognise the identifier rejects the message rather than attempting to interpret
it. Version 1 is frozen: a change to any field below requires v2, and the two
may coexist.

## Rules that hold across every message

- **Money is integer paise.** Never a floating point rupee value, in either
  runtime, at any point in the contract.
- **Timestamps are epoch milliseconds, UTC.**
- **Receipt time and exchange time are separate fields** and are never
  conflated. The feed does not always supply an exchange timestamp; receipt time
  is always present.
- **Unknown enum values are rejected**, never defaulted.
- **Sequence is monotonic per symbol** and assigned by the owner of the stream.

## NormalisedTick

    contract          string   "zentrade.marketdata.tick.v1"
    symbol            string   root symbol, exchange prefix and suffix stripped
    exchangeTs        int64?   exchange timestamp, null when not supplied
    receiveTs         int64    receipt timestamp, always present
    sequence          uint64   monotonic per symbol
    pricePaise        int64    integer minor units
    cumulativeVolume  int64?   session cumulative as the feed reports it
    source            enum     "websocket" | "rest"
    session           enum     "PRE_OPEN" | "OPEN" | "CLOSE" | "POST_CLOSE"

`source` exists because a polled quote and a streamed tick share a cache key and
must not be judged by the same freshness bound.

## SymbolState

The owner's view of one symbol since the last time anyone asked.

    symbol      string
    lastPaise   int64
    highPaise   int64    running high since the last takeRange
    lowPaise    int64    running low since the last takeRange
    sequence    uint64
    updatedTs   int64

The running extremes exist because a move that spikes through a level and
retraces inside one supervisory interval is invisible to anything that samples
endpoints.

## Commitment

Levels recorded at entry. The reflex evaluates these and nothing else.

    symbol             string
    thesisId           string
    direction          enum     "LONG" | "SHORT"
    stopPaise          int64?
    targetPaise        int64?
    invalidationPaise  int64?
    quantity           int64
    correlationId      string

## MarketEvent

    contract       string   "zentrade.marketdata.event.v1"
    kind           enum     "STOP" | "TARGET" | "INVALIDATION" | "STALE"
    symbol         string
    severity       enum     "INFO" | "WARNING" | "CRITICAL"
    reason         string   deterministic for a given input
    pricePaise     int64    the price that crossed
    levelPaise     int64    the level it crossed
    thesisId       string?
    correlationId  string
    observedTs     int64
    sequence       uint64   the tick sequence that produced it

## Evaluation semantics

These are the behaviours the fixtures pin, and any implementation must match
them exactly.

1. A long is stopped at or below `stopPaise` and targets at or above
   `targetPaise`. A short mirrors both.
2. Crossings are **edge triggered**. A position resting beyond its stop produces
   one event, not one per tick.
3. Evaluation order within a tick is **STOP, then INVALIDATION, then TARGET**,
   and it is stable.
4. Re-arming a symbol **resets the latch**, because a revised thesis is a new
   pre-commitment.
5. A tick with a non-positive or non-finite price is **ignored entirely** and
   does not advance state.
6. Running extremes update on every accepted tick, including ticks that produce
   no crossing.
7. `STOP` and `INVALIDATION` are `CRITICAL`. `TARGET` is `WARNING`, because
   reaching a target is a judgement the thesis did not pre-commit.
