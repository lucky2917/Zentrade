// Command parity enumerates the full decision input space, runs it through the
// Go implementation, and writes cases plus results as JSON. The TypeScript
// side reads the same case list, recomputes, and compares field by field, so
// both implementations are guaranteed to see identical input.
package main

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/zentrade/zentrade/go/decision"
)

type Case struct {
	Technical  string `json:"technical"`
	Sentiment  string `json:"sentiment"`
	Risk       string `json:"risk"`
	Score      int    `json:"score"`
	Action     string `json:"action"`
	Confidence string `json:"confidence"`
}

type Result struct {
	Direction         string `json:"direction"`
	Bullish           int    `json:"bullish"`
	Bearish           int    `json:"bearish"`
	Neutral           int    `json:"neutral"`
	Label             string `json:"label"`
	ImpliedConfidence string `json:"impliedConfidence"`
	FinalAction       string `json:"finalAction"`
	FinalConfidence   string `json:"finalConfidence"`
}

type Payload struct {
	Cases   []Case   `json:"cases"`
	Results []Result `json:"results"`
}

func main() {
	// Signals include malformed values so both sides exercise the
	// "anything else is neutral" rule, not just the happy path.
	signals := []string{"BULLISH", "BEARISH", "NEUTRAL", "", "bullish", "GARBAGE"}
	scores := []int{-2, -1, 0, 1, 2}
	actions := []string{
		"BUY", "SELL", "HOLD",
		"", "buy", "Buy", "ACCUMULATE", "BUY the dip", "HOLD ", " HOLD",
		"1", "null", "undefined", "SHORT", "STRONG BUY",
	}
	confidences := []string{"HIGH", "MEDIUM", "LOW", "", "high", "VERY HIGH", "0.9", "null"}

	payload := Payload{}
	for _, t := range signals {
		for _, s := range signals {
			for _, r := range signals {
				c := decision.ComputeConsensus(decision.Signal(t), decision.Signal(s), decision.Signal(r))
				for _, score := range scores {
					for _, a := range actions {
						for _, conf := range confidences {
							d := decision.ApplyGuardrails(
								decision.Proposal{Action: a, Confidence: conf}, c, score)
							payload.Cases = append(payload.Cases, Case{t, s, r, score, a, conf})
							payload.Results = append(payload.Results, Result{
								Direction:         string(c.Direction),
								Bullish:           c.Bullish,
								Bearish:           c.Bearish,
								Neutral:           c.Neutral,
								Label:             string(c.Label),
								ImpliedConfidence: string(c.ImpliedConfidence),
								FinalAction:       string(d.Action),
								FinalConfidence:   string(d.Confidence),
							})
						}
					}
				}
			}
		}
	}

	out, err := json.Marshal(payload)
	if err != nil {
		fmt.Fprintln(os.Stderr, "encode:", err)
		os.Exit(1)
	}
	if _, err := os.Stdout.Write(out); err != nil {
		fmt.Fprintln(os.Stderr, "write:", err)
		os.Exit(1)
	}
	fmt.Fprintf(os.Stderr, "emitted %d cases\n", len(payload.Cases))
}
