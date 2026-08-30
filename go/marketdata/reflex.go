package marketdata

import (
	"fmt"
	"sort"
)

// Lane holds current symbol state and evaluates pre-committed levels.
//
// A thesis is a pre-commitment: it named its stop, its target and the price
// that would prove it wrong, and the risk gate authorised the position those
// levels belong to. When a tick crosses one there is no judgement left, so the
// evaluation is arithmetic and deterministic.
//
// Safe for concurrent use. The Node implementation is single threaded because
// its runtime is; Go's is not, and a market-data owner that fans out across
// goroutines must not corrupt its own state.
//
// State is sharded by symbol (see shard.go). Two ticks on two symbols touch
// disjoint state and should not wait for each other.
type Lane struct {
	shards [shardCount]*shard
}

type commitmentState struct {
	commitment Commitment
	fired      map[Kind]bool
}

// Stats mirrors the Node implementation's health counters.
type Stats struct {
	Ticks      uint64 `json:"ticks"`
	Crossings  uint64 `json:"crossings"`
	Armed      uint64 `json:"armed"`
	Disarmed   uint64 `json:"disarmed"`
	Suppressed uint64 `json:"suppressed"`
	Signals    uint64 `json:"signals"`
	Stale      uint64 `json:"stale"`
	Recovered  uint64 `json:"recovered"`
}

func NewLane() *Lane {
	l := &Lane{}
	for i := range l.shards {
		l.shards[i] = newShard()
	}
	return l
}

func (l *Lane) shard(symbol string) *shard {
	return l.shards[shardFor(symbol)]
}

// Arm records the levels a thesis committed to. Re-arming replaces the previous
// commitment and clears the latch, because a revised thesis is a new
// pre-commitment and must be protected from the next tick.
func (l *Lane) Arm(c Commitment) bool {
	if c.Symbol == "" {
		return false
	}
	if c.StopPaise == nil && c.TargetPaise == nil && c.InvalidationPaise == nil {
		return false
	}
	if c.Direction != Long && c.Direction != Short {
		c.Direction = Long
	}
	sh := l.shard(c.Symbol)
	sh.mu.Lock()
	defer sh.mu.Unlock()
	sh.armed[c.Symbol] = &commitmentState{commitment: c, fired: make(map[Kind]bool)}
	sh.stats.Armed++
	return true
}

func (l *Lane) Disarm(symbol string) bool {
	sh := l.shard(symbol)
	sh.mu.Lock()
	defer sh.mu.Unlock()
	if _, ok := sh.armed[symbol]; !ok {
		return false
	}
	delete(sh.armed, symbol)
	delete(sh.watches, symbol)
	delete(sh.staleLatched, symbol)
	sh.stats.Disarmed++
	return true
}

func (l *Lane) IsArmed(symbol string) bool {
	sh := l.shard(symbol)
	sh.mu.Lock()
	defer sh.mu.Unlock()
	_, ok := sh.armed[symbol]
	return ok
}

// breached reports whether price has reached a level, in the direction that
// matters for this kind. A long is stopped below and targets above; a short
// mirrors both.
func breached(kind Kind, dir Direction, pricePaise, levelPaise int64) bool {
	long := dir != Short
	if kind == KindTarget {
		if long {
			return pricePaise >= levelPaise
		}
		return pricePaise <= levelPaise
	}
	if long {
		return pricePaise <= levelPaise
	}
	return pricePaise >= levelPaise
}

// OnTick is the hot path. It updates state and returns the crossings this tick
// caused, in the contract's fixed order: stop, then invalidation, then target.
//
// A non-positive price is ignored entirely and does not advance state.
func (l *Lane) OnTick(symbol string, pricePaise int64, at int64) []MarketEvent {
	return l.onTick(symbol, pricePaise, at, nil)
}

// Observe is the contract-shaped entry point: it carries the cumulative volume
// the feed reports, which the volume detector needs and OnTick cannot supply.
func (l *Lane) Observe(t NormalisedTick) []MarketEvent {
	return l.onTick(t.Symbol, t.PricePaise, t.ReceiveTs, t.CumulativeVolume)
}

func (l *Lane) onTick(symbol string, pricePaise int64, at int64, cumulativeVolume *int64) []MarketEvent {
	if pricePaise <= 0 {
		return nil
	}

	sh := l.shard(symbol)
	sh.mu.Lock()
	defer sh.mu.Unlock()

	sh.stats.Ticks++
	// A tick is the only proof that the feed for this symbol is alive.
	if sh.staleLatched[symbol] {
		delete(sh.staleLatched, symbol)
		sh.stats.Recovered++
	}

	state, ok := sh.states[symbol]
	if !ok {
		state = &SymbolState{Symbol: symbol, LastPaise: pricePaise,
			HighPaise: pricePaise, LowPaise: pricePaise, Sequence: 1, UpdatedTs: at}
		sh.states[symbol] = state
	} else {
		state.LastPaise = pricePaise
		if pricePaise > state.HighPaise {
			state.HighPaise = pricePaise
		}
		if pricePaise < state.LowPaise {
			state.LowPaise = pricePaise
		}
		state.Sequence++
		state.UpdatedTs = at
	}

	entry, armed := sh.armed[symbol]
	if !armed {
		// A symbol with no pre-commitment can still be materially changing, so
		// detection continues without one.
		return sh.detect(symbol, pricePaise, at, nil, state, cumulativeVolume)
	}

	var events []MarketEvent
	test := func(kind Kind, level *int64) {
		if level == nil {
			return
		}
		if !breached(kind, entry.commitment.Direction, pricePaise, *level) {
			return
		}
		// Edge triggered. A position resting beyond its stop produces one
		// event, not one per tick for the rest of the session.
		if entry.fired[kind] {
			sh.stats.Suppressed++
			return
		}
		entry.fired[kind] = true
		events = append(events, MarketEvent{
			Contract:      EventContract,
			Kind:          kind,
			Symbol:        symbol,
			Severity:      severityFor(kind),
			Reason:        fmt.Sprintf("%s crossed at %d against %d", kind, pricePaise, *level),
			PricePaise:    pricePaise,
			LevelPaise:    *level,
			ThesisID:      entry.commitment.ThesisID,
			CorrelationID: entry.commitment.CorrelationID,
			ObservedTs:    at,
			Sequence:      state.Sequence,
		})
	}

	test(KindStop, entry.commitment.StopPaise)
	test(KindInvalidation, entry.commitment.InvalidationPaise)
	test(KindTarget, entry.commitment.TargetPaise)

	sh.stats.Crossings += uint64(len(events))

	// Protection first, always. An attention signal never displaces a crossing
	// of a level the thesis pre-committed to.
	return append(events, sh.detect(symbol, pricePaise, at, entry, state, cumulativeVolume)...)
}

// Snapshot returns the current state of one symbol, or nil if never observed.
func (l *Lane) Snapshot(symbol string) *SymbolState {
	sh := l.shard(symbol)
	sh.mu.Lock()
	defer sh.mu.Unlock()
	s, ok := sh.states[symbol]
	if !ok {
		return nil
	}
	copied := *s
	return &copied
}

// TakeRange returns what the symbol did since the last call and restarts the
// window at the last price. This is what a supervisory monitor should reason
// over, so that a move which spiked and retraced is not invisible to it.
func (l *Lane) TakeRange(symbol string) *SymbolState {
	sh := l.shard(symbol)
	sh.mu.Lock()
	defer sh.mu.Unlock()
	s, ok := sh.states[symbol]
	if !ok {
		return nil
	}
	copied := *s
	s.HighPaise = s.LastPaise
	s.LowPaise = s.LastPaise
	s.Sequence = 0
	return &copied
}

// Symbols returns every observed symbol, sorted, so callers that iterate get a
// deterministic order rather than Go's randomised map order.
func (l *Lane) Symbols() []string {
	out := make([]string, 0, 64)
	for _, sh := range l.shards {
		sh.mu.Lock()
		for s := range sh.states {
			out = append(out, s)
		}
		sh.mu.Unlock()
	}
	sort.Strings(out)
	return out
}

// Health sums the shards. The total is a consistent view of counters that are
// individually consistent, which is what a counter is for; it is not a
// transactional snapshot across shards and does not need to be.
func (l *Lane) Health() Stats {
	var total Stats
	for _, sh := range l.shards {
		sh.mu.Lock()
		total.Ticks += sh.stats.Ticks
		total.Crossings += sh.stats.Crossings
		total.Armed += sh.stats.Armed
		total.Disarmed += sh.stats.Disarmed
		total.Suppressed += sh.stats.Suppressed
		total.Signals += sh.stats.Signals
		total.Stale += sh.stats.Stale
		total.Recovered += sh.stats.Recovered
		sh.mu.Unlock()
	}
	return total
}
