package marketdata

import (
	"hash/maphash"
	"sync"
)

// Per-symbol sharding.
//
// One mutex over the whole lane made concurrent ticks serialise on a lock they
// almost never actually contend for: two ticks on two different symbols touch
// disjoint state. Measured, that cost 123.6 ns/op in parallel against 21.05
// ns/op serial — a 5.9x penalty paid entirely to a lock, not to work.
//
// Symbols are distributed across a fixed number of shards, each with its own
// mutex and its own counters. Two ticks collide only when their symbols hash to
// the same shard, and the counters no longer share a cache line.
//
// The shard count is fixed rather than derived from GOMAXPROCS so that a
// benchmark on one machine and a production run on another distribute symbols
// identically. Behaviour does not depend on it either way: sharding is a
// concurrency detail and every observable result is unchanged.
const shardCount = 64

type shard struct {
	mu      sync.Mutex
	armed   map[string]*commitmentState
	states  map[string]*SymbolState
	watches map[string]*watchState
	// Symbols already reported silent. Absence of ticks persists, so the report
	// has to be edge triggered like everything else here.
	staleLatched map[string]bool
	stats        Stats
}

func newShard() *shard {
	return &shard{
		armed:        make(map[string]*commitmentState),
		states:       make(map[string]*SymbolState),
		watches:      make(map[string]*watchState),
		staleLatched: make(map[string]bool),
	}
}

// One seed for the process. maphash is randomly seeded per seed value, which is
// what keeps a hostile symbol set from being able to force every symbol into
// one shard.
var shardSeed = maphash.MakeSeed()

func shardFor(symbol string) uint64 {
	return maphash.String(shardSeed, symbol) & (shardCount - 1)
}
