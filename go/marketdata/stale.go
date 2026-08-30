package marketdata

import "sort"

// Feed liveness.
//
// This is the one condition in the fast plane that legitimately stays timer
// driven: absence of ticks cannot arrive as a tick. A watched symbol that has
// stopped ticking is a symbol this lane can no longer protect, and an ARMED
// symbol going quiet means a pre-committed stop is unguarded.
//
// Nothing here trades on that. Acting on the absence of data is how a system
// talks itself into a decision it cannot support.

// StaleEntry is one symbol the lane has gone blind on.
type StaleEntry struct {
	Symbol    string `json:"symbol"`
	AgeMs     int64  `json:"ageMs"`
	LastPaise *int64 `json:"lastPaise"`
	Ticked    bool   `json:"ticked"`
	Armed     bool   `json:"armed"`
}

// ResetSilence restarts the silence clock for every watched symbol.
//
// The sweep only runs while the market is open, so it begins each session
// having watched nothing. Without this, every position armed during boot has
// been silent for as long as the process has been up, and the first sweep of
// the day would report the whole book blind.
func (l *Lane) ResetSilence(nowMs int64) int {
	n := 0
	for _, sh := range l.shards {
		sh.mu.Lock()
		for _, w := range sh.watches {
			w.silenceFrom = nowMs
			n++
		}
		sh.staleLatched = make(map[string]bool)
		sh.mu.Unlock()
	}
	return n
}

// StaleSymbols reports every watched symbol silent for longer than the bound,
// sorted, so two runs over the same state agree.
func (l *Lane) StaleSymbols(nowMs, staleAfterMs int64) []StaleEntry {
	out := make([]StaleEntry, 0, 8)
	for _, sh := range l.shards {
		sh.mu.Lock()
		for symbol, w := range sh.watches {
			out = appendIfStale(out, sh, symbol, w, nowMs, staleAfterMs)
		}
		sh.mu.Unlock()
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Symbol < out[j].Symbol })
	return out
}

// NewlyStale is edge triggered. Silence persists, so reporting it every sweep
// would produce one event per second for as long as the feed stayed down.
func (l *Lane) NewlyStale(nowMs, staleAfterMs int64) []StaleEntry {
	out := make([]StaleEntry, 0, 8)
	for _, sh := range l.shards {
		sh.mu.Lock()
		for symbol, w := range sh.watches {
			if sh.staleLatched[symbol] {
				continue
			}
			before := len(out)
			out = appendIfStale(out, sh, symbol, w, nowMs, staleAfterMs)
			if len(out) > before {
				sh.staleLatched[symbol] = true
				sh.stats.Stale++
			}
		}
		sh.mu.Unlock()
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Symbol < out[j].Symbol })
	return out
}

// Caller holds the shard lock.
func appendIfStale(out []StaleEntry, sh *shard, symbol string, w *watchState,
	nowMs, staleAfterMs int64) []StaleEntry {

	state, ticked := sh.states[symbol]

	// The later of the last tick and the last resumption. A tick from before a
	// resumption says nothing about whether the feed is alive now.
	since := w.silenceFrom
	if ticked && state.UpdatedTs > since {
		since = state.UpdatedTs
	}
	age := nowMs - since
	if age <= staleAfterMs {
		return out
	}

	entry := StaleEntry{
		Symbol: symbol, AgeMs: age,
		Ticked: ticked && state.UpdatedTs >= w.silenceFrom,
		// An armed symbol going quiet means protection is blind, which is a
		// different severity from a watchlist name going quiet.
		Armed: sh.armed[symbol] != nil,
	}
	if ticked {
		last := state.LastPaise
		entry.LastPaise = &last
	}
	return append(out, entry)
}
