package marketdata

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// Behavioural parity against the golden fixtures.
//
// The fixtures were generated from the Node implementation that runs in
// production. This test asserts the Go port reproduces them exactly: every
// event, in order, field for field, and the final state of every symbol.
//
// Zero divergence is the bar. A fixture that needs "adjusting" to pass is a
// behaviour change and must be argued for, not edited away.

const fixtureDir = "../../contracts/market-data/v1/fixtures"

type fixture struct {
	Contract    string `json:"contract"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Input       struct {
		Commitments []Commitment `json:"commitments"`
		Watches     []struct {
			Symbol           string    `json:"symbol"`
			EntryPaise       *int64    `json:"entryPaise"`
			ThesisID         string    `json:"thesisId"`
			CorrelationID    string    `json:"correlationId"`
			Direction        Direction `json:"direction"`
			ApproachFraction *float64  `json:"approachFraction"`
			JumpPercent      *float64  `json:"jumpPercent"`
			VelocityWindowMs *int64    `json:"velocityWindowMs"`
			VwapDeviation    *float64  `json:"vwapDeviation"`
			VwapPaise        *int64    `json:"vwapPaise"`
			VolumeBaseline   *float64  `json:"volumeBaseline"`
			VolumeSpikeRatio *float64  `json:"volumeSpikeRatio"`
		} `json:"watches"`
		Ticks []struct {
			Symbol           string `json:"symbol"`
			PricePaise       int64  `json:"pricePaise"`
			ReceiveTs        int64  `json:"receiveTs"`
			CumulativeVolume *int64 `json:"cumulativeVolume"`
		} `json:"ticks"`
	} `json:"input"`
	Expected struct {
		Events     []MarketEvent `json:"events"`
		FinalState []struct {
			Symbol    string `json:"symbol"`
			Observed  bool   `json:"observed"`
			LastPaise int64  `json:"lastPaise"`
			HighPaise int64  `json:"highPaise"`
			LowPaise  int64  `json:"lowPaise"`
			Sequence  uint64 `json:"sequence"`
			UpdatedTs int64  `json:"updatedTs"`
		} `json:"finalState"`
	} `json:"expected"`
}

func loadFixtures(t *testing.T) []fixture {
	t.Helper()
	paths, err := filepath.Glob(filepath.Join(fixtureDir, "*.json"))
	if err != nil {
		t.Fatalf("globbing fixtures: %v", err)
	}
	var out []fixture
	for _, p := range paths {
		if filepath.Base(p) == "index.json" {
			continue
		}
		raw, err := os.ReadFile(p)
		if err != nil {
			t.Fatalf("reading %s: %v", p, err)
		}
		var f fixture
		if err := json.Unmarshal(raw, &f); err != nil {
			t.Fatalf("parsing %s: %v", p, err)
		}
		out = append(out, f)
	}
	if len(out) == 0 {
		t.Fatal("no fixtures found; run node scripts/generateReflexFixtures.js")
	}
	return out
}

func TestParityAgainstGoldenFixtures(t *testing.T) {
	for _, f := range loadFixtures(t) {
		f := f
		t.Run(f.Name, func(t *testing.T) {
			if f.Contract != ContractVersion {
				t.Fatalf("fixture declares contract %q, this package implements %q",
					f.Contract, ContractVersion)
			}

			lane := NewLane()
			for _, c := range f.Input.Commitments {
				if !lane.Arm(c) {
					t.Fatalf("refused to arm a commitment the fixture expects to be armed: %+v", c)
				}
			}

			for _, w := range f.Input.Watches {
				cfg := Watch{
					EntryPaise: w.EntryPaise, ThesisID: w.ThesisID,
					CorrelationID: w.CorrelationID, Direction: w.Direction,
				}
				if w.ApproachFraction != nil {
					cfg.ApproachFraction = *w.ApproachFraction
				}
				if w.JumpPercent != nil {
					cfg.JumpPercent = *w.JumpPercent
				}
				if w.VelocityWindowMs != nil {
					cfg.VelocityWindowMs = *w.VelocityWindowMs
				}
				if w.VwapDeviation != nil {
					cfg.VwapDeviation = *w.VwapDeviation
				}
				if !lane.Watch(w.Symbol, cfg, 0) {
					t.Fatalf("refused a watch the fixture expects: %+v", w)
				}
				if w.VwapPaise != nil {
					lane.UpdateVwap(w.Symbol, *w.VwapPaise)
				}
				if w.VolumeBaseline != nil && w.VolumeSpikeRatio != nil {
					lane.UpdateVolumeBaseline(w.Symbol, *w.VolumeBaseline, *w.VolumeSpikeRatio)
				}
			}

			var got []MarketEvent
			for _, tk := range f.Input.Ticks {
				got = append(got, lane.Observe(NormalisedTick{
					Contract: TickContract, Symbol: tk.Symbol,
					PricePaise: tk.PricePaise, ReceiveTs: tk.ReceiveTs,
					CumulativeVolume: tk.CumulativeVolume,
				})...)
			}

			if len(got) != len(f.Expected.Events) {
				t.Fatalf("event count diverged: go produced %d, node produced %d\ngo:   %+v\nnode: %+v",
					len(got), len(f.Expected.Events), got, f.Expected.Events)
			}
			for i := range got {
				if got[i] != f.Expected.Events[i] {
					t.Errorf("event %d diverged\n  go:   %+v\n  node: %+v", i, got[i], f.Expected.Events[i])
				}
			}

			for _, want := range f.Expected.FinalState {
				state := lane.Snapshot(want.Symbol)
				if !want.Observed {
					if state != nil {
						t.Errorf("%s: node never observed it, go has %+v", want.Symbol, state)
					}
					continue
				}
				if state == nil {
					t.Fatalf("%s: node observed it, go did not", want.Symbol)
				}
				if state.LastPaise != want.LastPaise || state.HighPaise != want.HighPaise ||
					state.LowPaise != want.LowPaise || state.Sequence != want.Sequence ||
					state.UpdatedTs != want.UpdatedTs {
					t.Errorf("%s state diverged\n  go:   last=%d high=%d low=%d seq=%d ts=%d\n  node: last=%d high=%d low=%d seq=%d ts=%d",
						want.Symbol, state.LastPaise, state.HighPaise, state.LowPaise, state.Sequence, state.UpdatedTs,
						want.LastPaise, want.HighPaise, want.LowPaise, want.Sequence, want.UpdatedTs)
				}
			}
		})
	}
}

// The fixture set is the specification. If it stops covering a behaviour the
// contract promises, parity means less than it appears to.
func TestFixtureSetCoversTheContract(t *testing.T) {
	fixtures := loadFixtures(t)
	seen := map[Kind]bool{}
	sawSuppression, sawShort, sawMultiSymbol, sawIgnoredTick := false, false, false, false

	for _, f := range fixtures {
		for _, e := range f.Expected.Events {
			seen[e.Kind] = true
		}
		for _, c := range f.Input.Commitments {
			if c.Direction == Short {
				sawShort = true
			}
		}
		symbols := map[string]bool{}
		for _, tk := range f.Input.Ticks {
			symbols[tk.Symbol] = true
			if tk.PricePaise <= 0 {
				sawIgnoredTick = true
			}
		}
		if len(symbols) > 1 {
			sawMultiSymbol = true
		}
		if len(f.Input.Ticks) > len(f.Expected.Events)+1 && len(f.Expected.Events) > 0 {
			sawSuppression = true
		}
	}

	for _, kind := range []Kind{
		KindStop, KindTarget, KindInvalidation,
		KindStopApproach, KindTargetApproach, KindPriceJump,
		KindVwapDeviation, KindVolumeSpike,
	} {
		if !seen[kind] {
			t.Errorf("no fixture exercises a %s crossing", kind)
		}
	}
	if !sawShort {
		t.Error("no fixture exercises a short position")
	}
	if !sawMultiSymbol {
		t.Error("no fixture exercises more than one symbol")
	}
	if !sawIgnoredTick {
		t.Error("no fixture exercises a non-positive price")
	}
	if !sawSuppression {
		t.Error("no fixture exercises edge-triggered suppression")
	}
}
