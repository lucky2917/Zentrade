package marketdata

import (
	"fmt"
	"math"
)

// Continuous material-change detection.
//
// The reflex acts on pre-commitments. This does not: it notices that something
// has changed enough to be worth a thesis review, and hands that to the brain.
// It lives on the tick because every condition here is observable on the tick,
// and a fifteen-second poll cannot see a move that happens and reverses between
// two samples.
//
// Arithmetic only. No model, no I/O, no allocation beyond the events emitted.
// Edge triggered, so a condition that persists produces one signal rather than
// one per tick for the rest of the session.

// Defaults are deliberately inert where a value must come from the bar plane.
// A watch is created explicitly by the caller that knows the position.
const (
	DefaultApproachFraction = 0.25 // within 25% of the entry-to-level span
	DefaultJumpPercent      = 2.0  // absolute move over the velocity window
	DefaultVelocityWindowMs = 60_000
	DefaultVwapDeviation    = 0.02 // 2% from session VWAP
	DefaultStaleAfterMs     = 30_000
)

// Watch is the per-symbol detection configuration. VwapPaise, VolumeBaseline
// and VolumeSpikeRatio are bar-scale quantities the tick path cannot derive;
// the bar plane pushes them in. Nil means that detector stays off.
type Watch struct {
	EntryPaise       *int64
	ThesisID         string
	CorrelationID    string
	Direction        Direction
	ApproachFraction float64
	JumpPercent      float64
	VelocityWindowMs int64
	VwapDeviation    float64

	VwapPaise        *int64
	VolumeBaseline   *float64
	VolumeSpikeRatio *float64
}

type pricePoint struct {
	at         int64
	pricePaise int64
}

type watchState struct {
	cfg     Watch
	fired   map[Kind]bool
	history []pricePoint

	// Silence is measured from the later of the last tick and the last
	// resumption. The sweep only runs inside the trading window, so it must not
	// charge a symbol for quiet that accumulated before anyone was listening.
	silenceFrom int64

	volumeMinute int64
	volumeAnchor int64
	volumeSeen   bool
}

func defaulted(w Watch) Watch {
	if w.ApproachFraction == 0 {
		w.ApproachFraction = DefaultApproachFraction
	}
	if w.JumpPercent == 0 {
		w.JumpPercent = DefaultJumpPercent
	}
	if w.VelocityWindowMs == 0 {
		w.VelocityWindowMs = DefaultVelocityWindowMs
	}
	if w.VwapDeviation == 0 {
		w.VwapDeviation = DefaultVwapDeviation
	}
	if w.Direction != Long && w.Direction != Short {
		w.Direction = Long
	}
	return w
}

// Watch enables continuous detection for one symbol. Re-watching merges the new
// configuration over the old and keeps the latch and the silence clock, so
// refreshing a watch does not re-open questions already answered.
func (l *Lane) Watch(symbol string, cfg Watch, nowMs int64) bool {
	if symbol == "" {
		return false
	}
	sh := l.shard(symbol)
	sh.mu.Lock()
	defer sh.mu.Unlock()

	if existing, ok := sh.watches[symbol]; ok {
		merged := defaulted(cfg)
		if merged.VwapPaise == nil {
			merged.VwapPaise = existing.cfg.VwapPaise
		}
		if merged.VolumeBaseline == nil {
			merged.VolumeBaseline = existing.cfg.VolumeBaseline
		}
		if merged.VolumeSpikeRatio == nil {
			merged.VolumeSpikeRatio = existing.cfg.VolumeSpikeRatio
		}
		if merged.EntryPaise == nil {
			merged.EntryPaise = existing.cfg.EntryPaise
		}
		existing.cfg = merged
		return true
	}

	sh.watches[symbol] = &watchState{
		cfg: defaulted(cfg), fired: make(map[Kind]bool), silenceFrom: nowMs,
	}
	return true
}

func (l *Lane) Unwatch(symbol string) bool {
	sh := l.shard(symbol)
	sh.mu.Lock()
	defer sh.mu.Unlock()
	if _, ok := sh.watches[symbol]; !ok {
		return false
	}
	delete(sh.watches, symbol)
	delete(sh.staleLatched, symbol)
	return true
}

func (l *Lane) IsWatched(symbol string) bool {
	sh := l.shard(symbol)
	sh.mu.Lock()
	defer sh.mu.Unlock()
	_, ok := sh.watches[symbol]
	return ok
}

// UpdateVwap pushes the bar plane's session VWAP. A new VWAP is a new question,
// so it clears the deviation latch.
func (l *Lane) UpdateVwap(symbol string, vwapPaise int64) bool {
	sh := l.shard(symbol)
	sh.mu.Lock()
	defer sh.mu.Unlock()
	w, ok := sh.watches[symbol]
	if !ok {
		return false
	}
	v := vwapPaise
	w.cfg.VwapPaise = &v
	delete(w.fired, KindVwapDeviation)
	return true
}

// UpdateVolumeBaseline pushes the typical volume of one completed bar and the
// multiple of it that counts as a spike. Both come from the intelligence
// layer's own baseline so the tick plane and the bar plane judge a spike by one
// rule rather than two that can drift.
func (l *Lane) UpdateVolumeBaseline(symbol string, baseline, ratio float64) bool {
	sh := l.shard(symbol)
	sh.mu.Lock()
	defer sh.mu.Unlock()
	w, ok := sh.watches[symbol]
	if !ok {
		return false
	}
	if baseline > 0 {
		w.cfg.VolumeBaseline = &baseline
	} else {
		w.cfg.VolumeBaseline = nil
	}
	if ratio > 0 {
		w.cfg.VolumeSpikeRatio = &ratio
	} else {
		w.cfg.VolumeSpikeRatio = nil
	}
	return true
}

// detect runs inside OnTick, under the shard lock. `entry` is the armed
// commitment or nil: the approach bands need the levels, the rest do not.
func (sh *shard) detect(symbol string, pricePaise int64, at int64,
	entry *commitmentState, state *SymbolState, cumulativeVolume *int64) []MarketEvent {

	w, ok := sh.watches[symbol]
	if !ok {
		return nil
	}

	var events []MarketEvent
	raise := func(kind Kind, levelPaise int64, reason string) {
		if w.fired[kind] {
			sh.stats.Suppressed++
			return
		}
		w.fired[kind] = true
		sh.stats.Signals++

		thesisID, correlationID := w.cfg.ThesisID, w.cfg.CorrelationID
		if entry != nil {
			thesisID = entry.commitment.ThesisID
			correlationID = entry.commitment.CorrelationID
		}
		events = append(events, MarketEvent{
			Contract: EventContract, Kind: kind, Symbol: symbol,
			Severity: severityFor(kind), Reason: reason,
			PricePaise: pricePaise, LevelPaise: levelPaise,
			ThesisID: thesisID, CorrelationID: correlationID,
			ObservedTs: at, Sequence: state.Sequence,
		})
	}

	// --- approach bands ------------------------------------------------
	// Distance to a level as a fraction of the entry-to-level span. The poll
	// computed exactly this; it just could not see a move that entered and left
	// the band between two samples.
	if w.cfg.EntryPaise != nil && entry != nil {
		band := func(level *int64, kind Kind) {
			if level == nil {
				return
			}
			span := float64(*level - *w.cfg.EntryPaise)
			if span == 0 {
				return
			}
			remaining := float64(*level-pricePaise) / span
			if remaining > 0 && remaining <= w.cfg.ApproachFraction {
				raise(kind, *level, fmt.Sprintf("within %d%% of the level at %d",
					int(math.Floor(remaining*100+0.5)), *level))
			}
		}
		band(entry.commitment.StopPaise, KindStopApproach)
		band(entry.commitment.TargetPaise, KindTargetApproach)
	}

	// --- price velocity ------------------------------------------------
	// Measured over a real window rather than between two poll samples, so a
	// spike that reverses inside the window is still seen.
	w.history = append(w.history, pricePoint{at: at, pricePaise: pricePaise})
	cutoff := at - w.cfg.VelocityWindowMs
	// Re-slicing the front away advances the window past its own backing array,
	// so every append past the end reallocates and the window costs an
	// allocation per tick. Compacting in place reuses the array: after the
	// window reaches its steady size this stops allocating entirely.
	drop := 0
	for drop < len(w.history)-1 && w.history[drop].at < cutoff {
		drop++
	}
	if drop > 0 {
		w.history = append(w.history[:0], w.history[drop:]...)
	}
	if len(w.history) > 1 {
		oldest := w.history[0].pricePaise
		if oldest > 0 {
			movePercent := (float64(pricePaise-oldest) / float64(oldest)) * 100
			if math.Abs(movePercent) >= w.cfg.JumpPercent {
				raise(KindPriceJump, oldest, fmt.Sprintf("moved %.2f%% within %ds",
					movePercent, w.cfg.VelocityWindowMs/1000))
			}
		}
	}

	// --- vwap deviation -------------------------------------------------
	if w.cfg.VwapPaise != nil && *w.cfg.VwapPaise > 0 {
		vwap := float64(*w.cfg.VwapPaise)
		deviation := (float64(pricePaise) - vwap) / vwap
		if math.Abs(deviation) >= w.cfg.VwapDeviation {
			raise(KindVwapDeviation, *w.cfg.VwapPaise,
				fmt.Sprintf("%.2f%% from session VWAP", deviation*100))
		}
	}

	// --- volume ----------------------------------------------------------
	// The feed reports volume cumulatively for the session, so the volume of
	// the minute in progress is the delta from its first tick. The test is
	// one-sided on purpose: has this incomplete minute ALREADY exceeded several
	// typical full minutes. That reports a spike late, never early on a
	// projection from two seconds of data.
	if cumulativeVolume != nil && w.cfg.VolumeBaseline != nil && w.cfg.VolumeSpikeRatio != nil {
		minute := int64(math.Floor(float64(at) / 60_000))
		if !w.volumeSeen || w.volumeMinute != minute {
			w.volumeMinute = minute
			w.volumeAnchor = *cumulativeVolume
			w.volumeSeen = true
			// A new minute is a new question, not the previous one's answer.
			delete(w.fired, KindVolumeSpike)
		}
		// A reconnect or a session rollover can restart the counter. Re-anchor
		// rather than reporting the difference as negative volume.
		if *cumulativeVolume < w.volumeAnchor {
			w.volumeAnchor = *cumulativeVolume
		}
		soFar := float64(*cumulativeVolume - w.volumeAnchor)
		threshold := *w.cfg.VolumeBaseline * *w.cfg.VolumeSpikeRatio
		if soFar >= threshold {
			raise(KindVolumeSpike, int64(math.Floor(threshold+0.5)),
				fmt.Sprintf("%.1fx typical minute volume", soFar / *w.cfg.VolumeBaseline))
		}
	}

	return events
}
