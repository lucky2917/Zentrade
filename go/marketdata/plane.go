package marketdata

import (
	"context"
	"sync"
	"time"
)

// The fast market plane.
//
// It consumes normalised ticks, maintains the live world state, evaluates
// pre-committed levels, detects continuous material change, and supervises feed
// liveness. It emits material events and nothing else.
//
// What it deliberately cannot do: reach a model, reach a database, or place an
// order. There is no client for any of those linked into this package, which is
// the structural half of "the fast plane never waits for the LLM". The other
// half is that it runs in a different process.

// EventSink receives material events. Publishing must not block the tick loop:
// an implementation that can be slow is responsible for its own buffering.
type EventSink interface {
	Publish(MarketEvent) error
}

// SinkFunc adapts a function to an EventSink.
type SinkFunc func(MarketEvent) error

func (f SinkFunc) Publish(e MarketEvent) error { return f(e) }

// PlaneConfig is everything the plane needs that is not a dependency.
type PlaneConfig struct {
	SweepInterval time.Duration
	StaleAfter    time.Duration
	// Now is injectable so a test drives the clock rather than waiting on it.
	Now func() time.Time
	// Called after every sweep with the current metrics. The plane already
	// wakes on this cadence, so a heartbeat here adds no timer of its own.
	OnSweep func(PlaneMetrics)
}

func (c PlaneConfig) defaulted() PlaneConfig {
	if c.SweepInterval <= 0 {
		c.SweepInterval = time.Second
	}
	if c.StaleAfter <= 0 {
		c.StaleAfter = DefaultStaleAfterMs * time.Millisecond
	}
	if c.Now == nil {
		c.Now = time.Now
	}
	return c
}

// PlaneMetrics is what the plane reports about itself.
type PlaneMetrics struct {
	TicksIngested    uint64 `json:"ticksIngested"`
	EventsPublished  uint64 `json:"eventsPublished"`
	PublishFailures  uint64 `json:"publishFailures"`
	Sweeps           uint64 `json:"sweeps"`
	Resumptions      uint64 `json:"resumptions"`
	StaleReported    uint64 `json:"staleReported"`
	BlindArmed       uint64 `json:"blindArmed"`
	RejectedTicks    uint64 `json:"rejectedTicks"`
	CommandsApplied  uint64 `json:"commandsApplied"`
	RejectedCommands uint64 `json:"rejectedCommands"`
}

type Plane struct {
	cfg  PlaneConfig
	lane *Lane
	sink EventSink

	mu          sync.Mutex
	metrics     PlaneMetrics
	lastSweepAt int64
	sweptOnce   bool
}

func NewPlane(sink EventSink, cfg PlaneConfig) *Plane {
	return &Plane{cfg: cfg.defaulted(), lane: NewLane(), sink: sink}
}

func (p *Plane) Lane() *Lane { return p.lane }

func (p *Plane) Metrics() PlaneMetrics {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.metrics
}

// Ingest evaluates one tick and publishes whatever it caused.
//
// A tick that does not declare the contract this package implements is
// rejected rather than interpreted. Guessing at an unrecognised message is how
// a version skew becomes a wrong price.
func (p *Plane) Ingest(t NormalisedTick) []MarketEvent {
	if t.Contract != TickContract || t.Symbol == "" {
		p.bump(func(m *PlaneMetrics) { m.RejectedTicks++ })
		return nil
	}
	events := p.lane.Observe(t)
	p.bump(func(m *PlaneMetrics) { m.TicksIngested++ })
	p.publish(events)
	return events
}

// Sweep asks the one question a tick cannot answer: which watched symbols have
// stopped ticking. Nothing here trades on the answer.
func (p *Plane) Sweep(now time.Time) []StaleEntry {
	nowMs := now.UnixMilli()

	p.mu.Lock()
	previous, swept := p.lastSweepAt, p.sweptOnce
	p.lastSweepAt, p.sweptOnce = nowMs, true
	p.metrics.Sweeps++
	p.mu.Unlock()

	// The sweep runs only inside the trading window, so it resumes at the open,
	// and again after a halt or a restart. Silence that accumulated while
	// nobody was listening is not evidence of anything.
	//
	// The gap is judged against the sweep's own cadence, not the staleness
	// bound: the question is whether the sweep was running, and a sweep that
	// missed several of its own intervals was not.
	resumptionGap := p.cfg.SweepInterval * 5
	if resumptionGap < 5*time.Second {
		resumptionGap = 5 * time.Second
	}
	if !swept || nowMs-previous > resumptionGap.Milliseconds() {
		p.lane.ResetSilence(nowMs)
		p.bump(func(m *PlaneMetrics) { m.Resumptions++ })
		p.heartbeat()
		return nil
	}

	stale := p.lane.NewlyStale(nowMs, p.cfg.StaleAfter.Milliseconds())
	p.heartbeat()
	if len(stale) == 0 {
		return nil
	}

	events := make([]MarketEvent, 0, len(stale))
	for _, s := range stale {
		severity := SeverityWarning
		if s.Armed {
			// An armed symbol going quiet means a pre-committed stop is
			// unguarded. That is not the same as a watchlist name going quiet.
			severity = SeverityCritical
			p.bump(func(m *PlaneMetrics) { m.BlindArmed++ })
		}
		level := int64(0)
		if s.LastPaise != nil {
			level = *s.LastPaise
		}
		events = append(events, MarketEvent{
			Contract: EventContract, Kind: KindStale, Symbol: s.Symbol,
			Severity:   severity,
			Reason:     staleReason(s),
			LevelPaise: level, PricePaise: level,
			ObservedTs: nowMs,
		})
	}
	p.bump(func(m *PlaneMetrics) { m.StaleReported += uint64(len(stale)) })
	p.publish(events)
	return stale
}

func staleReason(s StaleEntry) string {
	if s.Ticked {
		return "no tick for " + s.Symbol + " in " + durationSeconds(s.AgeMs) + "s"
	}
	return "no tick for " + s.Symbol + " since the watch began"
}

func durationSeconds(ms int64) string {
	secs := (ms + 500) / 1000
	return itoa(secs)
}

func itoa(v int64) string {
	if v == 0 {
		return "0"
	}
	neg := v < 0
	if neg {
		v = -v
	}
	var buf [20]byte
	i := len(buf)
	for v > 0 {
		i--
		buf[i] = byte('0' + v%10)
		v /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}

// A sink failure must not stop the plane. Detection is the job; publication is
// best effort and counted, so a silent sink is visible in health rather than
// mistaken for a quiet market.
func (p *Plane) publish(events []MarketEvent) {
	for _, e := range events {
		if err := p.sink.Publish(e); err != nil {
			p.bump(func(m *PlaneMetrics) { m.PublishFailures++ })
			continue
		}
		p.bump(func(m *PlaneMetrics) { m.EventsPublished++ })
	}
}

// Never holds a lock across the callback, and never lets it fail the sweep.
func (p *Plane) heartbeat() {
	if p.cfg.OnSweep == nil {
		return
	}
	metrics := p.Metrics()
	defer func() { _ = recover() }()
	p.cfg.OnSweep(metrics)
}

func (p *Plane) bump(f func(*PlaneMetrics)) {
	p.mu.Lock()
	f(&p.metrics)
	p.mu.Unlock()
}

// Run drives the plane until the context is cancelled.
//
// Ticks, commands and the sweep share ONE goroutine. That is deliberate: a
// command that arms a symbol must not interleave with the tick that would cross
// its stop, or a position could be armed halfway through its own protection.
// Serialising them here makes the ordering observable and testable, and the
// work is nanoseconds so there is nothing to gain by parallelising it.
func (p *Plane) Run(ctx context.Context, ticks <-chan NormalisedTick,
	commands <-chan Command) error {

	sweep := time.NewTicker(p.cfg.SweepInterval)
	defer sweep.Stop()

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case t, ok := <-ticks:
			if !ok {
				return nil
			}
			p.Ingest(t)
		case c, ok := <-commands:
			if !ok {
				commands = nil
				continue
			}
			if _, err := p.Apply(c); err != nil {
				// A command that cannot be interpreted is counted and dropped.
				// Guessing at it is how an ARM becomes a DISARM.
				continue
			}
		case <-sweep.C:
			p.Sweep(p.cfg.Now())
		}
	}
}
