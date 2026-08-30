package marketdata

import (
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
)

func watched(t *testing.T, lane *Lane, symbol string, at int64) {
	t.Helper()
	if !lane.Watch(symbol, Watch{}, at) {
		t.Fatalf("could not watch %s", symbol)
	}
}

func TestSilenceIsNotReportedWhileTicksArrive(t *testing.T) {
	lane := NewLane()
	watched(t, lane, "RELIANCE", 0)
	for i := int64(1); i <= 10; i++ {
		lane.OnTick("RELIANCE", 100_000, i*5_000)
	}
	if got := lane.StaleSymbols(50_000, DefaultStaleAfterMs); len(got) != 0 {
		t.Fatalf("reported %d silent symbols while ticking: %+v", len(got), got)
	}
}

func TestSilenceIsReportedAfterTheBound(t *testing.T) {
	lane := NewLane()
	watched(t, lane, "RELIANCE", 0)
	lane.OnTick("RELIANCE", 100_000, 1_000)

	got := lane.StaleSymbols(1_000+DefaultStaleAfterMs+1, DefaultStaleAfterMs)
	if len(got) != 1 {
		t.Fatalf("expected one silent symbol, got %d", len(got))
	}
	if !got[0].Ticked || got[0].LastPaise == nil || *got[0].LastPaise != 100_000 {
		t.Fatalf("silent entry lost the last price: %+v", got[0])
	}
	if got[0].Armed {
		t.Error("an unarmed symbol reported as armed")
	}
}

// A position armed at boot on a symbol the feed never delivers has no state
// entry. Measuring from the last tick found nothing to measure and the symbol
// looked healthy forever.
func TestASymbolThatNeverTickedIsStillReported(t *testing.T) {
	lane := NewLane()
	watched(t, lane, "RELIANCE", 0)
	got := lane.StaleSymbols(DefaultStaleAfterMs+1, DefaultStaleAfterMs)
	if len(got) != 1 || got[0].Ticked || got[0].LastPaise != nil {
		t.Fatalf("a never-ticked symbol was not reported correctly: %+v", got)
	}
}

func TestAnArmedSymbolIsMarked(t *testing.T) {
	lane := NewLane()
	lane.Arm(longCommitment())
	watched(t, lane, "RELIANCE", 0)
	lane.OnTick("RELIANCE", 100_000, 1_000)

	got := lane.StaleSymbols(1_000+DefaultStaleAfterMs+1, DefaultStaleAfterMs)
	if len(got) != 1 || !got[0].Armed {
		t.Fatalf("a blind armed position was not marked: %+v", got)
	}
}

func TestAnUnwatchedSymbolIsNeverReported(t *testing.T) {
	lane := NewLane()
	lane.OnTick("RELIANCE", 100_000, 1_000)
	if got := lane.StaleSymbols(999_000, DefaultStaleAfterMs); len(got) != 0 {
		t.Fatalf("reported a symbol nobody asked to watch: %+v", got)
	}
}

func TestNewlyStaleIsEdgeTriggered(t *testing.T) {
	lane := NewLane()
	watched(t, lane, "RELIANCE", 0)
	lane.OnTick("RELIANCE", 100_000, 1_000)

	at := int64(1_000 + DefaultStaleAfterMs + 1)
	if got := lane.NewlyStale(at, DefaultStaleAfterMs); len(got) != 1 {
		t.Fatalf("first sweep did not report: %+v", got)
	}
	for i := int64(1); i <= 20; i++ {
		if got := lane.NewlyStale(at+i*1_000, DefaultStaleAfterMs); len(got) != 0 {
			t.Fatalf("sweep %d re-reported a persisting silence", i)
		}
	}
	if lane.Health().Stale != 1 {
		t.Errorf("stale counter = %d, want 1", lane.Health().Stale)
	}
}

func TestRecoveryReArmsTheReport(t *testing.T) {
	lane := NewLane()
	watched(t, lane, "RELIANCE", 0)
	lane.OnTick("RELIANCE", 100_000, 1_000)

	at := int64(1_000 + DefaultStaleAfterMs + 1)
	lane.NewlyStale(at, DefaultStaleAfterMs)

	lane.OnTick("RELIANCE", 100_100, at+1_000)
	if lane.Health().Recovered != 1 {
		t.Fatalf("a tick after silence did not count as recovery")
	}
	if got := lane.NewlyStale(at+2_000, DefaultStaleAfterMs); len(got) != 0 {
		t.Fatalf("reported silence immediately after a tick: %+v", got)
	}
	if got := lane.NewlyStale(at+1_000+DefaultStaleAfterMs+1, DefaultStaleAfterMs); len(got) != 1 {
		t.Fatalf("second silence episode was not reported: %+v", got)
	}
	if lane.Health().Stale != 2 {
		t.Errorf("stale counter = %d, want 2", lane.Health().Stale)
	}
}

// The sweep only runs inside the trading window, so it resumes at the open
// having watched nothing. Every position armed during boot has then been quiet
// for as long as the process has been up.
func TestResumptionDoesNotChargeForSilenceNobodyWasListeningTo(t *testing.T) {
	lane := NewLane()
	for _, s := range []string{"A", "B", "C"} {
		watched(t, lane, s, 0)
	}
	const halfHour = 30 * 60 * 1000

	lane.ResetSilence(halfHour)
	if got := lane.NewlyStale(halfHour, DefaultStaleAfterMs); len(got) != 0 {
		t.Fatalf("resumption reported %d symbols blind: %+v", len(got), got)
	}
	if got := lane.NewlyStale(halfHour+DefaultStaleAfterMs-1_000, DefaultStaleAfterMs); len(got) != 0 {
		t.Fatalf("reported before the bound elapsed from the resumption: %+v", got)
	}
	if got := lane.NewlyStale(halfHour+DefaultStaleAfterMs+1, DefaultStaleAfterMs); len(got) != 3 {
		t.Fatalf("expected all three after the bound, got %d", len(got))
	}
}

func TestResumptionReAnchorsASymbolWhoseLastTickPredatesIt(t *testing.T) {
	lane := NewLane()
	watched(t, lane, "A", 0)
	lane.OnTick("A", 100_000, 1_000) // a pre-market tick
	const halfHour = 30 * 60 * 1000

	lane.ResetSilence(halfHour)
	if got := lane.NewlyStale(halfHour+DefaultStaleAfterMs-1_000, DefaultStaleAfterMs); len(got) != 0 {
		t.Fatalf("charged for silence before the resumption: %+v", got)
	}
}

func TestUnwatchAndDisarmForgetTheSymbol(t *testing.T) {
	lane := NewLane()
	lane.Arm(longCommitment())
	watched(t, lane, "RELIANCE", 0)
	lane.OnTick("RELIANCE", 100_000, 1_000)
	lane.Disarm("RELIANCE")

	if lane.IsWatched("RELIANCE") {
		t.Error("disarming left the watch behind")
	}
	if got := lane.StaleSymbols(999_000, DefaultStaleAfterMs); len(got) != 0 {
		t.Fatalf("a closed position is still being watched: %+v", got)
	}
}

func TestStaleReportIsSortedAcrossShards(t *testing.T) {
	lane := NewLane()
	for i := 0; i < 200; i++ {
		watched(t, lane, fmt.Sprintf("SYM%03d", i), 0)
	}
	got := lane.StaleSymbols(DefaultStaleAfterMs+1, DefaultStaleAfterMs)
	if len(got) != 200 {
		t.Fatalf("expected 200 silent symbols, got %d", len(got))
	}
	for i := 1; i < len(got); i++ {
		if got[i-1].Symbol >= got[i].Symbol {
			t.Fatalf("shard iteration order leaked into the result at %d", i)
		}
	}
}

// A sweep runs while ticks keep arriving. Neither may corrupt the other.
func TestSweepAndTicksAreSafeTogether(t *testing.T) {
	lane := NewLane()
	symbols := make([]string, 64)
	for i := range symbols {
		symbols[i] = fmt.Sprintf("SYM%03d", i)
		watched(t, lane, symbols[i], 0)
	}

	var wg sync.WaitGroup
	var sweeps int64
	stop := make(chan struct{})

	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			select {
			case <-stop:
				return
			default:
				lane.NewlyStale(1_000_000, DefaultStaleAfterMs)
				lane.StaleSymbols(1_000_000, DefaultStaleAfterMs)
				atomic.AddInt64(&sweeps, 1)
			}
		}
	}()

	wg.Add(1)
	go func() {
		defer wg.Done()
		defer close(stop)
		for i := 0; i < 20_000; i++ {
			s := symbols[i%len(symbols)]
			lane.OnTick(s, 100_000, int64(i))
			lane.ResetSilence(int64(i))
		}
	}()

	wg.Wait()
	if atomic.LoadInt64(&sweeps) == 0 {
		t.Fatal("the sweep never ran")
	}
}
