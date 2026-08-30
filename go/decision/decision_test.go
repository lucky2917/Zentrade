package decision

import "testing"

var allSignals = []Signal{SignalBullish, SignalBearish, SignalNeutral}

// Values the synthesizer might return that are not legal actions. An LLM can
// emit any of these, so the guardrails have to survive all of them.
var malformedActions = []string{
	"", "buy", "Buy", "ACCUMULATE", "BUY the dip", "HOLD ", " HOLD",
	"1", "null", "undefined", "SHORT", "STRONG BUY",
}

var malformedConfidences = []string{
	"", "high", "VERY HIGH", "0.9", "certain", "null", "MED",
}

func TestConsensusCountsAlwaysSumToThree(t *testing.T) {
	for _, a := range allSignals {
		for _, b := range allSignals {
			for _, c := range allSignals {
				got := ComputeConsensus(a, b, c)
				if got.Bullish+got.Bearish+got.Neutral != 3 {
					t.Fatalf("%s/%s/%s: counts sum to %d, want 3",
						a, b, c, got.Bullish+got.Bearish+got.Neutral)
				}
			}
		}
	}
}

func TestConsensusLabels(t *testing.T) {
	cases := []struct {
		a, b, c    Signal
		direction  Direction
		label      Label
		confidence Confidence
	}{
		{SignalBullish, SignalBullish, SignalBullish, DirectionBullish, LabelUnanimous, ConfidenceHigh},
		{SignalBearish, SignalBearish, SignalBearish, DirectionBearish, LabelUnanimous, ConfidenceHigh},
		{SignalBullish, SignalBullish, SignalNeutral, DirectionBullish, LabelMajority, ConfidenceHigh},
		{SignalBearish, SignalBearish, SignalNeutral, DirectionBearish, LabelMajority, ConfidenceHigh},
		{SignalBullish, SignalBullish, SignalBearish, DirectionBullish, LabelLeaning, ConfidenceMedium},
		{SignalBullish, SignalNeutral, SignalNeutral, DirectionBullish, LabelLeaning, ConfidenceMedium},
		{SignalBullish, SignalBearish, SignalNeutral, DirectionNeutral, LabelSplit, ConfidenceLow},
		{SignalNeutral, SignalNeutral, SignalNeutral, DirectionNeutral, LabelSplit, ConfidenceLow},
	}
	for _, tc := range cases {
		got := ComputeConsensus(tc.a, tc.b, tc.c)
		if got.Direction != tc.direction || got.Label != tc.label || got.ImpliedConfidence != tc.confidence {
			t.Errorf("%s/%s/%s: got %s/%s/%s, want %s/%s/%s",
				tc.a, tc.b, tc.c, got.Direction, got.Label, got.ImpliedConfidence,
				tc.direction, tc.label, tc.confidence)
		}
	}
}

// An unknown signal must abstain, never vote.
func TestUnknownSignalCountsAsNeutral(t *testing.T) {
	known := ComputeConsensus(SignalBullish, SignalNeutral, SignalNeutral)
	for _, junk := range []Signal{"", "bullish", "GARBAGE", "1"} {
		got := ComputeConsensus(SignalBullish, junk, junk)
		if got != known {
			t.Errorf("signal %q: got %+v, want %+v", junk, got, known)
		}
	}
}

func TestNormalDecisions(t *testing.T) {
	bullish := ComputeConsensus(SignalBullish, SignalBullish, SignalNeutral)
	bearish := ComputeConsensus(SignalBearish, SignalBearish, SignalNeutral)
	split := ComputeConsensus(SignalBullish, SignalBearish, SignalNeutral)

	if got := ApplyGuardrails(Proposal{Action: "BUY"}, bullish, 0); got.Action != ActionBuy {
		t.Errorf("normal BUY: got %s", got.Action)
	}
	if got := ApplyGuardrails(Proposal{Action: "SELL"}, bearish, 0); got.Action != ActionSell {
		t.Errorf("normal SELL: got %s", got.Action)
	}
	if got := ApplyGuardrails(Proposal{Action: "HOLD"}, split, 0); got.Action != ActionHold {
		t.Errorf("normal HOLD: got %s", got.Action)
	}
}

func TestMalformedActionFallsBackToConsensus(t *testing.T) {
	cases := []struct {
		consensus Consensus
		want      Action
	}{
		{ComputeConsensus(SignalBullish, SignalBullish, SignalNeutral), ActionBuy},
		{ComputeConsensus(SignalBearish, SignalBearish, SignalNeutral), ActionSell},
		{ComputeConsensus(SignalBullish, SignalBearish, SignalNeutral), ActionHold},
	}
	for _, tc := range cases {
		for _, junk := range malformedActions {
			got := ApplyGuardrails(Proposal{Action: junk}, tc.consensus, 0)
			if got.Action != tc.want {
				t.Errorf("action %q with %s: got %s, want %s",
					junk, tc.consensus.Direction, got.Action, tc.want)
			}
		}
	}
}

func TestMacroOverrideDowngradesButNeverUpgrades(t *testing.T) {
	majority := ComputeConsensus(SignalBullish, SignalBullish, SignalNeutral)
	unanimous := ComputeConsensus(SignalBullish, SignalBullish, SignalBullish)

	if got := ApplyGuardrails(Proposal{Action: "BUY"}, majority, MarketCrashing); got.Action != ActionHold {
		t.Errorf("BUY in a crash without unanimity: got %s, want HOLD", got.Action)
	}
	if got := ApplyGuardrails(Proposal{Action: "BUY"}, unanimous, MarketCrashing); got.Action != ActionBuy {
		t.Errorf("BUY in a crash with unanimity: got %s, want BUY", got.Action)
	}
	if got := ApplyGuardrails(Proposal{Action: "SELL"}, majority, MarketCrashing); got.Action != ActionSell {
		t.Errorf("SELL is not the override's business: got %s", got.Action)
	}
	if got := ApplyGuardrails(Proposal{Action: "HOLD"}, majority, MarketCrashing); got.Action != ActionHold {
		t.Errorf("HOLD must not be upgraded: got %s", got.Action)
	}
}

// Rule 1 can manufacture a BUY, which rule 2 must then catch.
func TestFabricatedBuyIsCaughtByTheOverride(t *testing.T) {
	majority := ComputeConsensus(SignalBullish, SignalBullish, SignalNeutral)
	got := ApplyGuardrails(Proposal{Action: "MOON"}, majority, MarketCrashing)
	if got.Action != ActionHold {
		t.Errorf("fabricated action in a crash: got %s, want HOLD", got.Action)
	}
}

func TestOnlyExactlyMinusOneCrashes(t *testing.T) {
	majority := ComputeConsensus(SignalBullish, SignalBullish, SignalNeutral)
	for _, score := range []int{-2, 0, 1, 2, 100} {
		if got := ApplyGuardrails(Proposal{Action: "BUY"}, majority, score); got.Action != ActionBuy {
			t.Errorf("score %d must not trigger the override, got %s", score, got.Action)
		}
	}
}

func TestConfidenceIsAlwaysLegal(t *testing.T) {
	bullish := ComputeConsensus(SignalBullish, SignalBullish, SignalNeutral)
	for _, junk := range malformedConfidences {
		got := ApplyGuardrails(Proposal{Action: "BUY", Confidence: junk}, bullish, 0)
		if got.Confidence != bullish.ImpliedConfidence {
			t.Errorf("confidence %q: got %s, want %s", junk, got.Confidence, bullish.ImpliedConfidence)
		}
	}
	got := ApplyGuardrails(Proposal{Action: "BUY", Confidence: "LOW"}, bullish, 0)
	if got.Confidence != ConfidenceLow {
		t.Errorf("a legal confidence must survive: got %s", got.Confidence)
	}
}

// Totality: no combination of inputs may produce an illegal action.
func TestTotality(t *testing.T) {
	actions := append([]string{"BUY", "SELL", "HOLD"}, malformedActions...)
	confidences := append([]string{"HIGH", "MEDIUM", "LOW"}, malformedConfidences...)
	scores := []int{-2, -1, 0, 1, 2}

	checked := 0
	for _, a := range allSignals {
		for _, b := range allSignals {
			for _, c := range allSignals {
				consensus := ComputeConsensus(a, b, c)
				for _, score := range scores {
					for _, action := range actions {
						for _, conf := range confidences {
							got := ApplyGuardrails(Proposal{action, conf}, consensus, score)
							if !isLegalAction(string(got.Action)) {
								t.Fatalf("illegal action %q escaped", got.Action)
							}
							if !isLegalConfidence(string(got.Confidence)) {
								t.Fatalf("illegal confidence %q escaped", got.Confidence)
							}
							checked++
						}
					}
				}
			}
		}
	}
	want := 27 * len(scores) * len(actions) * len(confidences)
	if checked != want {
		t.Fatalf("checked %d combinations, want %d", checked, want)
	}
	t.Logf("totality holds across %d combinations", checked)
}

func TestDeterminism(t *testing.T) {
	consensus := ComputeConsensus(SignalBullish, SignalNeutral, SignalBearish)
	first := ApplyGuardrails(Proposal{"BUY", "HIGH"}, consensus, -1)
	for i := 0; i < 1000; i++ {
		if got := ApplyGuardrails(Proposal{"BUY", "HIGH"}, consensus, -1); got != first {
			t.Fatalf("call %d diverged: %+v vs %+v", i, got, first)
		}
	}
}

// The documented contract difference: Go does not mutate its input.
func TestGuardrailsDoNotMutateInput(t *testing.T) {
	consensus := ComputeConsensus(SignalBullish, SignalBullish, SignalNeutral)
	proposal := Proposal{Action: "ACCUMULATE", Confidence: "certain"}
	ApplyGuardrails(proposal, consensus, 0)
	if proposal.Action != "ACCUMULATE" || proposal.Confidence != "certain" {
		t.Errorf("input was mutated: %+v", proposal)
	}
}

func BenchmarkComputeConsensus(b *testing.B) {
	for i := 0; i < b.N; i++ {
		ComputeConsensus(SignalBullish, SignalBearish, SignalNeutral)
	}
}

func BenchmarkApplyGuardrails(b *testing.B) {
	consensus := ComputeConsensus(SignalBullish, SignalBullish, SignalNeutral)
	proposal := Proposal{Action: "ACCUMULATE", Confidence: "certain"}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		ApplyGuardrails(proposal, consensus, -1)
	}
}

func BenchmarkFullDecision(b *testing.B) {
	proposal := Proposal{Action: "BUY", Confidence: "HIGH"}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		c := ComputeConsensus(SignalBullish, SignalBullish, SignalNeutral)
		ApplyGuardrails(proposal, c, -1)
	}
}
