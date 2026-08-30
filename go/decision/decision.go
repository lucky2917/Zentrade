// Package decision holds the deterministic half of the ZenTrade agent's
// decision. The technical, sentiment and risk agents are LLM-backed and may
// return anything; consensus and the guardrails are what make their output
// safe to act on.
//
// Everything here is pure: no I/O, no clock, no randomness, no package state.
// The behavioural contract is docs/GO_MIGRATION_CONTRACTS.md, and the
// TypeScript in apps/api/src/services/aiEngine.js is the source of truth for
// parity.
package decision

// Signal is an agent's directional read. Classification is by exact match:
// anything that is not BULLISH or BEARISH counts as neutral, including the
// empty string and wrong casing. An agent that fails or returns junk must not
// be able to steer the decision.
type Signal string

const (
	SignalBullish Signal = "BULLISH"
	SignalBearish Signal = "BEARISH"
	SignalNeutral Signal = "NEUTRAL"
)

// Direction is the aggregate read across the three agents.
type Direction string

const (
	DirectionBullish Direction = "BULLISH"
	DirectionBearish Direction = "BEARISH"
	DirectionNeutral Direction = "NEUTRAL"
)

// Label describes how strongly the agents agreed.
type Label string

const (
	LabelUnanimous Label = "unanimous"
	LabelMajority  Label = "majority"
	LabelLeaning   Label = "leaning"
	LabelSplit     Label = "split"
)

// Confidence is the decision's stated confidence.
type Confidence string

const (
	ConfidenceHigh   Confidence = "HIGH"
	ConfidenceMedium Confidence = "MEDIUM"
	ConfidenceLow    Confidence = "LOW"
)

// Action is the decision itself. HOLD is the abstention state, and every
// failure mode resolves toward it rather than toward a position.
type Action string

const (
	ActionBuy  Action = "BUY"
	ActionSell Action = "SELL"
	ActionHold Action = "HOLD"
)

// MarketCrashing is the only market score the macro override reacts to. It is
// compared by exact equality, so every other score means "not crashing".
const MarketCrashing = -1

// Consensus is the aggregate of the three agent signals.
type Consensus struct {
	Direction         Direction  `json:"direction"`
	Bullish           int        `json:"bullish"`
	Bearish           int        `json:"bearish"`
	Neutral           int        `json:"neutral"`
	Label             Label      `json:"label"`
	ImpliedConfidence Confidence `json:"impliedConfidence"`
}

// Proposal is what the synthesizer returned. Both fields are untrusted, which
// is why they are plain strings rather than the Action and Confidence types:
// the whole point of the guardrails is that these may hold anything.
type Proposal struct {
	Action     string `json:"action"`
	Confidence string `json:"confidence"`
}

// Decision is the guardrailed output. Both fields are always legal.
type Decision struct {
	Action     Action     `json:"action"`
	Confidence Confidence `json:"confidence"`
}

// LegalActions and LegalConfidences mirror the TypeScript exports so the
// vocabulary lives in one place per language.
var (
	LegalActions     = []Action{ActionBuy, ActionSell, ActionHold}
	LegalConfidences = []Confidence{ConfidenceHigh, ConfidenceMedium, ConfidenceLow}
)

func isLegalAction(candidate string) bool {
	for _, a := range LegalActions {
		if string(a) == candidate {
			return true
		}
	}
	return false
}

func isLegalConfidence(candidate string) bool {
	for _, c := range LegalConfidences {
		if string(c) == candidate {
			return true
		}
	}
	return false
}

// ComputeConsensus aggregates three agent signals.
//
// Counting is deliberately total: a signal that is neither BULLISH nor BEARISH
// is neutral, so a failed or malformed agent abstains instead of voting.
func ComputeConsensus(technical, sentiment, risk Signal) Consensus {
	var bullish, bearish, neutral int
	for _, s := range [3]Signal{technical, sentiment, risk} {
		switch s {
		case SignalBullish:
			bullish++
		case SignalBearish:
			bearish++
		default:
			neutral++
		}
	}

	switch {
	case bullish > bearish:
		label, confidence := agreement(bullish, bearish)
		return Consensus{DirectionBullish, bullish, bearish, neutral, label, confidence}
	case bearish > bullish:
		label, confidence := agreement(bearish, bullish)
		return Consensus{DirectionBearish, bullish, bearish, neutral, label, confidence}
	default:
		return Consensus{DirectionNeutral, bullish, bearish, neutral, LabelSplit, ConfidenceLow}
	}
}

// agreement grades how strongly the winning side agreed. A clean sweep is
// unanimous; two votes with no dissent is a majority; anything else is a
// lean, which carries less confidence.
func agreement(winning, losing int) (Label, Confidence) {
	switch {
	case winning == 3:
		return LabelUnanimous, ConfidenceHigh
	case winning == 2 && losing == 0:
		return LabelMajority, ConfidenceHigh
	default:
		return LabelLeaning, ConfidenceMedium
	}
}

// ApplyGuardrails turns an untrusted synthesizer proposal into a legal
// decision. It is total: every input produces a legal action and confidence.
//
// Unlike the TypeScript, which mutates its argument, this returns a new value.
// That difference is documented in the contract and is invisible in the output.
func ApplyGuardrails(proposal Proposal, consensus Consensus, marketScore int) Decision {
	action := Action(proposal.Action)

	// Rule 1: an action the synthesizer invented falls back to the consensus.
	if !isLegalAction(proposal.Action) {
		switch consensus.Direction {
		case DirectionBullish:
			action = ActionBuy
		case DirectionBearish:
			action = ActionSell
		default:
			action = ActionHold
		}
	}

	// Rule 2: a crashing market outranks a bullish read unless all three
	// agents agree. Applied after rule 1, so a fabricated BUY is caught too.
	// This only ever downgrades to abstention.
	if action == ActionBuy && marketScore == MarketCrashing && consensus.Label != LabelUnanimous {
		action = ActionHold
	}

	confidence := Confidence(proposal.Confidence)
	if !isLegalConfidence(proposal.Confidence) {
		confidence = consensus.ImpliedConfidence
	}

	return Decision{Action: action, Confidence: confidence}
}
