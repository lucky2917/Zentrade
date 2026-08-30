package marketdata

import (
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
)

func paise(v int64) *int64 { return &v }

func longCommitment() Commitment {
	return Commitment{
		Symbol: "RELIANCE", ThesisID: "t-1", Direction: Long,
		StopPaise: paise(98_000), TargetPaise: paise(108_000),
		Quantity: 200, CorrelationID: "c-1",
	}
}

// --- failure and refusal ----------------------------------------------------

func TestRefusesACommitmentWithNoLevels(t *testing.T) {
	lane := NewLane()
	if lane.Arm(Commitment{Symbol: "RELIANCE", ThesisID: "t"}) {
		t.Fatal("armed a commitment with nothing to evaluate")
	}
	if lane.IsArmed("RELIANCE") {
		t.Fatal("symbol reports armed after a refused commitment")
	}
}

func TestRefusesACommitmentWithNoSymbol(t *testing.T) {
	c := longCommitment()
	c.Symbol = ""
	if NewLane().Arm(c) {
		t.Fatal("armed a commitment with no symbol")
	}
}

func TestIgnoresNonPositivePricesEntirely(t *testing.T) {
	lane := NewLane()
	lane.Arm(longCommitment())
	lane.OnTick("RELIANCE", 100_000, 1)

	for _, bad := range []int64{0, -1, -100_000} {
		if events := lane.OnTick("RELIANCE", bad, 2); events != nil {
			t.Errorf("price %d produced %d event(s)", bad, len(events))
		}
	}
	// State must not have advanced past the one good tick.
	if s := lane.Snapshot("RELIANCE"); s.Sequence != 1 || s.LastPaise != 100_000 {
		t.Errorf("a rejected tick advanced state: %+v", s)
	}
}

func TestAnUnknownSymbolIsSilent(t *testing.T) {
	if events := NewLane().OnTick("NEVER_ARMED", 100_000, 1); events != nil {
		t.Fatalf("unarmed symbol produced %d event(s)", len(events))
	}
}

func TestDisarmStopsEvaluation(t *testing.T) {
	lane := NewLane()
	lane.Arm(longCommitment())
	lane.Disarm("RELIANCE")
	if events := lane.OnTick("RELIANCE", 90_000, 1); events != nil {
		t.Fatalf("disarmed symbol produced %d event(s)", len(events))
	}
	if lane.Disarm("RELIANCE") {
		t.Error("disarming twice reported success the second time")
	}
}

func TestReArmingResetsTheLatch(t *testing.T) {
	lane := NewLane()
	lane.Arm(longCommitment())
	if got := lane.OnTick("RELIANCE", 97_000, 1); len(got) != 1 {
		t.Fatalf("expected the first breach to fire, got %d", len(got))
	}
	// A revised thesis is a new pre-commitment and must be protected again.
	c := longCommitment()
	c.StopPaise = paise(96_000)
	lane.Arm(c)
	if got := lane.OnTick("RELIANCE", 95_900, 2); len(got) != 1 {
		t.Fatalf("re-armed commitment did not fire, got %d", len(got))
	}
}

// --- concurrency ------------------------------------------------------------
//
// The Node implementation is single threaded because its runtime is. Go's is
// not, so a market-data owner fanning out across goroutines must not corrupt
// its own state or emit a crossing twice.

func TestConcurrentTicksProduceExactlyOneCrossing(t *testing.T) {
	for attempt := 0; attempt < 50; attempt++ {
		lane := NewLane()
		lane.Arm(longCommitment())

		var fired int64
		var wg sync.WaitGroup
		for i := 0; i < 64; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				atomic.AddInt64(&fired, int64(len(lane.OnTick("RELIANCE", 97_000, 1))))
			}()
		}
		wg.Wait()

		if fired != 1 {
			t.Fatalf("attempt %d: 64 concurrent breaching ticks produced %d crossings, want exactly 1",
				attempt, fired)
		}
	}
}

func TestConcurrentTicksAccountForEverySequence(t *testing.T) {
	lane := NewLane()
	const goroutines, each = 16, 500

	var wg sync.WaitGroup
	for g := 0; g < goroutines; g++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < each; i++ {
				lane.OnTick("INFY", 100_000, 1)
			}
		}()
	}
	wg.Wait()

	if s := lane.Snapshot("INFY"); s.Sequence != goroutines*each {
		t.Fatalf("sequence lost updates under contention: got %d, want %d", s.Sequence, goroutines*each)
	}
}

func TestConcurrentArmAndTickDoNotRace(t *testing.T) {
	lane := NewLane()
	var wg sync.WaitGroup
	stop := make(chan struct{})

	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			select {
			case <-stop:
				return
			default:
				lane.Arm(longCommitment())
				lane.Disarm("RELIANCE")
			}
		}
	}()
	wg.Add(1)
	go func() {
		defer wg.Done()
		// Closing here rather than after Wait: the arm/disarm goroutine only
		// exits on this signal, so signalling afterwards deadlocks the test.
		defer close(stop)
		for i := 0; i < 20000; i++ {
			lane.OnTick("RELIANCE", 97_000, int64(i))
			lane.Snapshot("RELIANCE")
			lane.TakeRange("RELIANCE")
		}
	}()

	wg.Wait()
}

// --- state ------------------------------------------------------------------

func TestTakeRangeRestartsTheWindowAtTheLastPrice(t *testing.T) {
	lane := NewLane()
	for _, p := range []int64{100_000, 103_400, 99_100, 100_000} {
		lane.OnTick("INFY", p, 1)
	}
	r := lane.TakeRange("INFY")
	if r.HighPaise != 103_400 || r.LowPaise != 99_100 || r.LastPaise != 100_000 {
		t.Fatalf("range lost an extreme: %+v", r)
	}
	after := lane.Snapshot("INFY")
	if after.HighPaise != 100_000 || after.LowPaise != 100_000 || after.Sequence != 0 {
		t.Fatalf("window did not restart at the last price: %+v", after)
	}
}

func TestSymbolsAreReturnedInADeterministicOrder(t *testing.T) {
	lane := NewLane()
	for _, s := range []string{"TCS", "INFY", "RELIANCE", "WIPRO"} {
		lane.OnTick(s, 100_000, 1)
	}
	want := []string{"INFY", "RELIANCE", "TCS", "WIPRO"}
	for i := 0; i < 20; i++ {
		got := lane.Symbols()
		for j := range want {
			if got[j] != want[j] {
				t.Fatalf("map order leaked into the result: %v", got)
			}
		}
	}
}

func TestSnapshotIsACopy(t *testing.T) {
	lane := NewLane()
	lane.OnTick("INFY", 100_000, 1)
	s := lane.Snapshot("INFY")
	s.LastPaise = 1
	if lane.Snapshot("INFY").LastPaise != 100_000 {
		t.Fatal("callers can mutate lane state through a snapshot")
	}
}

// --- benchmarks -------------------------------------------------------------

func BenchmarkOnTickArmed(b *testing.B) {
	lane := NewLane()
	lane.Arm(longCommitment())
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		lane.OnTick("RELIANCE", 100_000+int64(i%400), int64(i))
	}
}

func BenchmarkOnTickUniverse(b *testing.B) {
	lane := NewLane()
	symbols := make([]string, 200)
	for i := range symbols {
		symbols[i] = string(rune('A'+i%26)) + string(rune('A'+(i/26)%26)) + string(rune('0'+i%10))
	}
	for i := 0; i < 25; i++ {
		c := longCommitment()
		c.Symbol = symbols[i]
		lane.Arm(c)
	}
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		lane.OnTick(symbols[i%200], 100_000+int64(i%400), int64(i))
	}
}

func BenchmarkOnTickParallel(b *testing.B) {
	lane := NewLane()
	lane.Arm(longCommitment())
	b.ReportAllocs()
	b.ResetTimer()
	b.RunParallel(func(pb *testing.PB) {
		i := 0
		for pb.Next() {
			lane.OnTick("RELIANCE", 100_000+int64(i%400), int64(i))
			i++
		}
	})
}

// The benchmark above drives one symbol from every goroutine. That contention
// is inherent: two ticks on one symbol must serialise, or the sequence stops
// being monotonic and the running high and low stop being correct. No lock
// design removes it.
//
// Production does not look like that. Two hundred symbols arrive interleaved on
// one connection, and two ticks on two symbols touch disjoint state. This is
// the benchmark that measures whether they wait for each other.
func BenchmarkOnTickParallelUniverse(b *testing.B) {
	lane := NewLane()
	symbols := make([]string, 200)
	for i := range symbols {
		symbols[i] = fmt.Sprintf("SYM%03d", i)
		c := longCommitment()
		c.Symbol = symbols[i]
		lane.Arm(c)
	}
	b.ReportAllocs()
	b.ResetTimer()
	var counter int64
	b.RunParallel(func(pb *testing.PB) {
		i := int(atomic.AddInt64(&counter, 1)) * 7919
		for pb.Next() {
			lane.OnTick(symbols[i%len(symbols)], 100_000+int64(i%400), int64(i))
			i++
		}
	})
}
