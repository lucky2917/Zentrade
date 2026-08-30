package marketdata

import (
	"context"
	"errors"
	"testing"
	"time"
)

func armCommand() Command {
	c := longCommitment()
	return Command{Contract: CommandContract, Op: OpArm, Symbol: "RELIANCE",
		IssuedTs: 1_000, Commitment: &c}
}

func TestArmViaCommandProtectsFromTheNextTick(t *testing.T) {
	sink := &recorder{}
	p := NewPlane(sink, PlaneConfig{})

	changed, err := p.Apply(armCommand())
	if err != nil || !changed {
		t.Fatalf("ARM was not applied: changed=%v err=%v", changed, err)
	}
	p.Ingest(tickAt("RELIANCE", 97_000, 2_000))

	got := sink.all()
	if len(got) != 1 || got[0].Kind != KindStop {
		t.Fatalf("an armed commitment did not protect: %+v", got)
	}
}

// Silently dropping an ARM would leave a real position unprotected while every
// health check reported success.
func TestAnUninterpretableCommandIsRejectedNotIgnored(t *testing.T) {
	p := NewPlane(&recorder{}, PlaneConfig{})

	bad := []Command{
		{Contract: "zentrade.marketdata.command.v2", Op: OpArm, Symbol: "X"},
		{Contract: CommandContract, Op: OpArm, Symbol: ""},
		{Contract: CommandContract, Op: OpArm, Symbol: "X"}, // no commitment
		{Contract: CommandContract, Op: "SELL_EVERYTHING", Symbol: "X"},
		{Contract: CommandContract, Op: OpVwap, Symbol: "X"},           // no value
		{Contract: CommandContract, Op: OpVolumeBaseline, Symbol: "X"}, // no value
	}
	for i, c := range bad {
		if _, err := p.Apply(c); !errors.Is(err, ErrUnknownCommand) {
			t.Errorf("case %d accepted an uninterpretable command: %+v", i, c)
		}
	}
	if p.Metrics().RejectedCommands != uint64(len(bad)) {
		t.Errorf("rejections not counted: %+v", p.Metrics())
	}
	if p.Metrics().CommandsApplied != 0 {
		t.Errorf("a rejected command was counted as applied: %+v", p.Metrics())
	}
}

func TestDisarmViaCommandStopsProtection(t *testing.T) {
	sink := &recorder{}
	p := NewPlane(sink, PlaneConfig{})
	p.Apply(armCommand())
	p.Apply(Command{Contract: CommandContract, Op: OpDisarm, Symbol: "RELIANCE"})

	p.Ingest(tickAt("RELIANCE", 97_000, 2_000))
	if len(sink.all()) != 0 {
		t.Fatalf("a disarmed symbol still protected: %+v", sink.all())
	}
}

func TestWatchAndBaselineCommandsEnableDetection(t *testing.T) {
	sink := &recorder{}
	p := NewPlane(sink, PlaneConfig{})
	entry := int64(100_000)

	p.Apply(Command{Contract: CommandContract, Op: OpWatch, Symbol: "INFY",
		IssuedTs: 1_000, Watch: &Watch{EntryPaise: &entry, ThesisID: "t-3"}})
	p.Apply(Command{Contract: CommandContract, Op: OpVwap, Symbol: "INFY",
		VwapPaise: &entry})

	p.Ingest(tickAt("INFY", 103_000, 2_000))
	got := sink.all()
	if len(got) != 1 || got[0].Kind != KindVwapDeviation {
		t.Fatalf("watch and baseline commands did not enable detection: %+v", got)
	}
	if got[0].Severity != SeverityWarning {
		t.Errorf("an attention signal was not a warning: %+v", got[0])
	}
}

// A command that arms a symbol must not interleave with the tick that would
// cross its stop.
func TestCommandsAndTicksAreSerialised(t *testing.T) {
	sink := &recorder{}
	p := NewPlane(sink, PlaneConfig{SweepInterval: time.Hour})
	ticks := make(chan NormalisedTick, 16)
	commands := make(chan Command, 16)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	done := make(chan error, 1)
	go func() { done <- p.Run(ctx, ticks, commands) }()

	commands <- armCommand()
	// Give the single loop a moment to apply the command before the tick, which
	// is the ordering the caller asked for by sending them in this order.
	for i := 0; i < 100 && p.Metrics().CommandsApplied == 0; i++ {
		time.Sleep(time.Millisecond)
	}
	ticks <- tickAt("RELIANCE", 97_000, 2_000)

	deadline := time.After(2 * time.Second)
	for len(sink.all()) == 0 {
		select {
		case <-deadline:
			t.Fatal("the tick after an ARM produced no protection")
		default:
			time.Sleep(time.Millisecond)
		}
	}
	if sink.all()[0].Kind != KindStop {
		t.Fatalf("wrong event: %+v", sink.all()[0])
	}
}

func TestRunSurvivesAClosedCommandChannel(t *testing.T) {
	p := NewPlane(&recorder{}, PlaneConfig{SweepInterval: 10 * time.Millisecond})
	ticks := make(chan NormalisedTick, 4)
	commands := make(chan Command)
	close(commands)

	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- p.Run(ctx, ticks, commands) }()

	ticks <- tickAt("RELIANCE", 100_000, 1)
	select {
	case err := <-done:
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("Run returned %v; a closed command channel must not end it early", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Run hung after the command channel closed")
	}
	if p.Metrics().TicksIngested != 1 {
		t.Errorf("ticks stopped being processed: %+v", p.Metrics())
	}
}
