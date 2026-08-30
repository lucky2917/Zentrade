package marketdata

import "errors"

// Commands: how the brain tells the fast plane what to protect.
//
// The plane owns world state and evaluates levels; it does not own the decision
// that produced those levels. The brain writes a thesis, the risk gate
// authorises the position, and only then is the plane told which levels to
// watch. That direction is the whole architecture: the plane never asks the
// brain anything, and the brain never waits for the plane.
//
// Unknown operations are rejected rather than ignored, because silently
// dropping an ARM would leave a real position unprotected while every health
// check reported success.

const CommandContract = "zentrade.marketdata.command.v1"

type Op string

const (
	OpArm            Op = "ARM"
	OpDisarm         Op = "DISARM"
	OpWatch          Op = "WATCH"
	OpUnwatch        Op = "UNWATCH"
	OpVwap           Op = "VWAP"
	OpVolumeBaseline Op = "VOLUME_BASELINE"
)

var ErrUnknownCommand = errors.New("unknown command")

type Command struct {
	Contract string `json:"contract"`
	Op       Op     `json:"op"`
	Symbol   string `json:"symbol"`
	IssuedTs int64  `json:"issuedTs"`

	Commitment *Commitment `json:"commitment,omitempty"`
	Watch      *Watch      `json:"watch,omitempty"`

	VwapPaise        *int64   `json:"vwapPaise,omitempty"`
	VolumeBaseline   *float64 `json:"volumeBaseline,omitempty"`
	VolumeSpikeRatio *float64 `json:"volumeSpikeRatio,omitempty"`
}

// Apply routes one command to the lane. It returns whether the command changed
// anything and an error only for a command that cannot be interpreted at all.
func (p *Plane) Apply(c Command) (bool, error) {
	if c.Contract != CommandContract {
		p.bump(func(m *PlaneMetrics) { m.RejectedCommands++ })
		return false, ErrUnknownCommand
	}
	if c.Symbol == "" {
		p.bump(func(m *PlaneMetrics) { m.RejectedCommands++ })
		return false, ErrUnknownCommand
	}

	at := c.IssuedTs
	if at == 0 {
		at = p.cfg.Now().UnixMilli()
	}

	var changed bool
	switch c.Op {
	case OpArm:
		if c.Commitment == nil {
			p.bump(func(m *PlaneMetrics) { m.RejectedCommands++ })
			return false, ErrUnknownCommand
		}
		commitment := *c.Commitment
		commitment.Symbol = c.Symbol
		changed = p.lane.Arm(commitment)
	case OpDisarm:
		changed = p.lane.Disarm(c.Symbol)
	case OpWatch:
		w := Watch{}
		if c.Watch != nil {
			w = *c.Watch
		}
		changed = p.lane.Watch(c.Symbol, w, at)
	case OpUnwatch:
		changed = p.lane.Unwatch(c.Symbol)
	case OpVwap:
		if c.VwapPaise == nil {
			p.bump(func(m *PlaneMetrics) { m.RejectedCommands++ })
			return false, ErrUnknownCommand
		}
		changed = p.lane.UpdateVwap(c.Symbol, *c.VwapPaise)
	case OpVolumeBaseline:
		if c.VolumeBaseline == nil || c.VolumeSpikeRatio == nil {
			p.bump(func(m *PlaneMetrics) { m.RejectedCommands++ })
			return false, ErrUnknownCommand
		}
		changed = p.lane.UpdateVolumeBaseline(c.Symbol, *c.VolumeBaseline, *c.VolumeSpikeRatio)
	default:
		p.bump(func(m *PlaneMetrics) { m.RejectedCommands++ })
		return false, ErrUnknownCommand
	}

	p.bump(func(m *PlaneMetrics) { m.CommandsApplied++ })
	return changed, nil
}
