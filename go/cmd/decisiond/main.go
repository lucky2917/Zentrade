// Command decisiond exposes the decision package over line-delimited JSON on
// stdin/stdout. It exists so the Node process can run the Go implementation in
// shadow mode without a network hop or a per-call process spawn: the daemon is
// started once and reused.
//
// It holds no state between requests and performs no I/O beyond stdin/stdout.
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"

	"github.com/zentrade/zentrade/go/decision"
)

type request struct {
	ID         int    `json:"id"`
	Technical  string `json:"technical"`
	Sentiment  string `json:"sentiment"`
	Risk       string `json:"risk"`
	Score      int    `json:"score"`
	Action     string `json:"action"`
	Confidence string `json:"confidence"`
}

type response struct {
	ID                int    `json:"id"`
	Direction         string `json:"direction"`
	Bullish           int    `json:"bullish"`
	Bearish           int    `json:"bearish"`
	Neutral           int    `json:"neutral"`
	Label             string `json:"label"`
	ImpliedConfidence string `json:"impliedConfidence"`
	FinalAction       string `json:"finalAction"`
	FinalConfidence   string `json:"finalConfidence"`
	Error             string `json:"error,omitempty"`
}

func main() {
	in := bufio.NewScanner(os.Stdin)
	in.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	out := bufio.NewWriter(os.Stdout)
	defer out.Flush()

	for in.Scan() {
		line := in.Bytes()
		if len(line) == 0 {
			continue
		}
		var req request
		reply := response{}
		if err := json.Unmarshal(line, &req); err != nil {
			reply.Error = "malformed request: " + err.Error()
		} else {
			c := decision.ComputeConsensus(
				decision.Signal(req.Technical),
				decision.Signal(req.Sentiment),
				decision.Signal(req.Risk))
			d := decision.ApplyGuardrails(
				decision.Proposal{Action: req.Action, Confidence: req.Confidence}, c, req.Score)
			reply = response{
				ID:                req.ID,
				Direction:         string(c.Direction),
				Bullish:           c.Bullish,
				Bearish:           c.Bearish,
				Neutral:           c.Neutral,
				Label:             string(c.Label),
				ImpliedConfidence: string(c.ImpliedConfidence),
				FinalAction:       string(d.Action),
				FinalConfidence:   string(d.Confidence),
			}
		}
		encoded, err := json.Marshal(reply)
		if err != nil {
			fmt.Fprintln(os.Stderr, "encode:", err)
			continue
		}
		out.Write(encoded)
		out.WriteByte('\n')
		out.Flush()
	}
}
