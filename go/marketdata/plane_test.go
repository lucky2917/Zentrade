package marketdata

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"
)

type recorder struct {
	mu     sync.Mutex
	events []MarketEvent
	fail   error
}

func (r *recorder) Publish(e MarketEvent) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.fail != nil {
		return r.fail
	}
	r.events = append(r.events, e)
	return nil
}

func (r *recorder) all() []MarketEvent {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]MarketEvent(nil), r.events...)
}

func tickAt(symbol string, pricePaise, ts int64) NormalisedTick {
	return NormalisedTick{
		Contract: TickContract, Symbol: symbol,
		PricePaise: pricePaise, ReceiveTs: ts, Source: SourceWebsocket,
	}
}

func TestPlanePublishesACrossing(t *testing.T) {
	sink := &recorder{}
	p := NewPlane(sink, PlaneConfig{})
	p.Lane().Arm(longCommitment())

	p.Ingest(tickAt("RELIANCE", 100_000, 1_000))
	p.Ingest(tickAt("RELIANCE", 97_000, 2_000))

	got := sink.all()
	if len(got) != 1 || got[0].Kind != KindStop {
		t.Fatalf("expected one STOP, got %+v", got)
	}
	if p.Metrics().EventsPublished != 1 || p.Metrics().TicksIngested != 2 {
		t.Errorf("metrics disagree with what happened: %+v", p.Metrics())
	}
}

// Guessing at an unrecognised message is how a version skew becomes a wrong
// price. The contract says reject, so the plane rejects.
func TestPlaneRejectsAForeignContract(t *testing.T) {
	sink := &recorder{}
	p := NewPlane(sink, PlaneConfig{})
	p.Lane().Arm(longCommitment())

	bad := tickAt("RELIANCE", 97_000, 1_000)
	bad.Contract = "zentrade.marketdata.tick.v2"
	if got := p.Ingest(bad); got != nil {
		t.Fatalf("interpreted a message from an unknown contract: %+v", got)
	}
	if len(sink.all()) != 0 {
		t.Fatal("published an event derived from a rejected tick")
	}
	if p.Metrics().RejectedTicks != 1 || p.Metrics().TicksIngested != 0 {
		t.Errorf("a rejected tick was counted as ingested: %+v", p.Metrics())
	}
}

func TestPlaneRejectsATickWithNoSymbol(t *testing.T) {
	p := NewPlane(&recorder{}, PlaneConfig{})
	if got := p.Ingest(tickAt("", 100_000, 1)); got != nil {
		t.Fatalf("accepted a tick with no symbol: %+v", got)
	}
}

// Detection is the job; publication is best effort. A dead sink must not stop
// the plane from protecting, and must be visible rather than look like quiet.
func TestASinkFailureDoesNotStopThePlane(t *testing.T) {
	sink := &recorder{fail: errors.New("redis down")}
	p := NewPlane(sink, PlaneConfig{})
	p.Lane().Arm(longCommitment())

	p.Ingest(tickAt("RELIANCE", 97_000, 1_000))
	if p.Metrics().PublishFailures != 1 {
		t.Fatalf("a publish failure was not counted: %+v", p.Metrics())
	}
	// The lane still latched, so the condition is not re-reported forever.
	p.Ingest(tickAt("RELIANCE", 96_000, 2_000))
	if p.Metrics().PublishFailures != 1 {
		t.Errorf("a latched crossing was re-emitted after a sink failure: %+v", p.Metrics())
	}
}

func TestFirstSweepIsAResumptionAndReportsNothing(t *testing.T) {
	sink := &recorder{}
	p := NewPlane(sink, PlaneConfig{SweepInterval: time.Second})
	base := time.UnixMilli(1_000_000)
	for _, s := range []string{"A", "B", "C"} {
		p.Lane().Watch(s, Watch{}, base.UnixMilli())
	}

	// Half an hour after the watches were created, exactly like a boot at 09:00
	// and a first sweep at 09:15.
	if got := p.Sweep(base.Add(30 * time.Minute)); len(got) != 0 {
		t.Fatalf("the session's first sweep reported %d symbols blind: %+v", len(got), got)
	}
	if len(sink.all()) != 0 {
		t.Fatal("a resumption published events")
	}
	if p.Metrics().Resumptions != 1 {
		t.Errorf("resumption not counted: %+v", p.Metrics())
	}
}

func TestSweepReportsSilenceAtCadence(t *testing.T) {
	sink := &recorder{}
	p := NewPlane(sink, PlaneConfig{SweepInterval: time.Second,
		StaleAfter: 30 * time.Second})
	base := time.UnixMilli(1_000_000)
	p.Lane().Arm(longCommitment())
	p.Lane().Watch("RELIANCE", Watch{}, base.UnixMilli())
	p.Ingest(tickAt("RELIANCE", 100_000, base.UnixMilli()))

	now := base
	p.Sweep(now) // resumption
	for i := 0; i < 31; i++ {
		now = now.Add(time.Second)
		p.Sweep(now)
	}

	got := sink.all()
	if len(got) != 1 {
		t.Fatalf("expected exactly one staleness event, got %d: %+v", len(got), got)
	}
	if got[0].Kind != KindStale || got[0].Severity != SeverityCritical {
		t.Fatalf("a blind armed position was not CRITICAL: %+v", got[0])
	}
	if p.Metrics().BlindArmed != 1 {
		t.Errorf("blind armed position not counted: %+v", p.Metrics())
	}
}

func TestSweepIsSilentWhileTicksArrive(t *testing.T) {
	sink := &recorder{}
	p := NewPlane(sink, PlaneConfig{SweepInterval: time.Second,
		StaleAfter: 30 * time.Second})
	base := time.UnixMilli(1_000_000)
	p.Lane().Watch("RELIANCE", Watch{}, base.UnixMilli())

	now := base
	p.Sweep(now)
	for i := 0; i < 120; i++ {
		now = now.Add(time.Second)
		p.Ingest(tickAt("RELIANCE", 100_000, now.UnixMilli()))
		p.Sweep(now)
	}
	if len(sink.all()) != 0 {
		t.Fatalf("reported silence on a live feed: %+v", sink.all())
	}
}

// A gap in the middle of a session — a halt, a pause, a restart — is a
// resumption too, not thirty minutes of evidence.
func TestAMidSessionGapIsTreatedAsAResumption(t *testing.T) {
	sink := &recorder{}
	p := NewPlane(sink, PlaneConfig{SweepInterval: time.Second,
		StaleAfter: 30 * time.Second})
	base := time.UnixMilli(1_000_000)
	p.Lane().Watch("RELIANCE", Watch{}, base.UnixMilli())
	p.Sweep(base)
	p.Ingest(tickAt("RELIANCE", 100_000, base.UnixMilli()))

	if got := p.Sweep(base.Add(20 * time.Minute)); len(got) != 0 {
		t.Fatalf("a mid-session gap was charged as silence: %+v", got)
	}
	if p.Metrics().Resumptions != 2 {
		t.Errorf("expected two resumptions, got %+v", p.Metrics())
	}
}

func TestPlaneNeverEmitsAnythingButMaterialEvents(t *testing.T) {
	sink := &recorder{}
	p := NewPlane(sink, PlaneConfig{})
	p.Lane().Arm(longCommitment())
	p.Lane().Watch("RELIANCE", Watch{EntryPaise: paise(100_000)}, 0)

	for i := int64(0); i < 500; i++ {
		p.Ingest(tickAt("RELIANCE", 100_000+(i%50)*10, i*100))
	}
	for _, e := range sink.all() {
		if e.Contract != EventContract {
			t.Fatalf("published something that is not a market event: %+v", e)
		}
		if e.Symbol == "" || e.Kind == "" || e.Severity == "" {
			t.Fatalf("published an incomplete event: %+v", e)
		}
	}
}

func TestRunStopsOnContextCancel(t *testing.T) {
	p := NewPlane(&recorder{}, PlaneConfig{SweepInterval: 10 * time.Millisecond})
	ticks := make(chan NormalisedTick)
	ctx, cancel := context.WithCancel(context.Background())

	done := make(chan error, 1)
	go func() { done <- p.Run(ctx, ticks, nil) }()

	ticks <- tickAt("RELIANCE", 100_000, 1)
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("Run returned %v, want context.Canceled", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Run did not stop on cancel")
	}
}

func TestRunStopsWhenTheFeedCloses(t *testing.T) {
	p := NewPlane(&recorder{}, PlaneConfig{SweepInterval: 10 * time.Millisecond})
	ticks := make(chan NormalisedTick, 4)
	ticks <- tickAt("RELIANCE", 100_000, 1)
	close(ticks)

	done := make(chan error, 1)
	go func() { done <- p.Run(context.Background(), ticks, nil) }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Run returned %v on a closed feed, want nil", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Run did not stop when the feed closed")
	}
}

func TestPlaneUnderConcurrentLoad(t *testing.T) {
	sink := &recorder{}
	p := NewPlane(sink, PlaneConfig{SweepInterval: time.Millisecond})
	symbols := make([]string, 200)
	for i := range symbols {
		symbols[i] = fmt.Sprintf("SYM%03d", i)
		p.Lane().Watch(symbols[i], Watch{}, 0)
	}

	var wg sync.WaitGroup
	for g := 0; g < 8; g++ {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			for i := 0; i < 5_000; i++ {
				p.Ingest(tickAt(symbols[(g*997+i)%len(symbols)], 100_000, int64(i)))
			}
		}(g)
	}
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; i < 2_000; i++ {
			p.Sweep(time.UnixMilli(int64(i)))
		}
	}()
	wg.Wait()

	if got := p.Metrics().TicksIngested; got != 40_000 {
		t.Fatalf("lost ticks under concurrency: ingested %d, want 40000", got)
	}
}
