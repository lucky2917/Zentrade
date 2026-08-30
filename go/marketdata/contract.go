// Package marketdata implements the zentrade.marketdata.v1 contract.
//
// It owns, or will own, the tick: normalisation, current symbol state, feed
// liveness and the evaluation of pre-committed protective levels.
//
// It is a library. Nothing in production calls it yet. It exists so that the
// behaviour can be proven identical to the Node implementation against golden
// fixtures before any question of ownership arises.
//
// Money is integer paise throughout. There is no float64 in this package by
// design: a rupee value that round-trips through a float is a rupee value that
// can disagree between two runtimes.
package marketdata

const (
	ContractVersion = "zentrade.marketdata.v1"
	TickContract    = "zentrade.marketdata.tick.v1"
	EventContract   = "zentrade.marketdata.event.v1"
)

// Direction of the position a commitment protects.
type Direction string

const (
	Long  Direction = "LONG"
	Short Direction = "SHORT"
)

// Kind of level that was crossed.
type Kind string

const (
	KindStop         Kind = "STOP"
	KindTarget       Kind = "TARGET"
	KindInvalidation Kind = "INVALIDATION"
	KindStale        Kind = "STALE"

	// Continuous material-change detection. These are not pre-commitments, so
	// they never authorise a protective action: they wake the trader. They
	// live on the tick because they are observable on the tick, and a poll
	// cannot see a move that happens and reverses between two samples.
	KindStopApproach   Kind = "STOP_APPROACH"
	KindTargetApproach Kind = "TARGET_APPROACH"
	KindPriceJump      Kind = "PRICE_JUMP"
	KindVwapDeviation  Kind = "VWAP_DEVIATION"
	KindVolumeSpike    Kind = "VOLUME_SPIKE"
)

// IsProtective reports whether a kind authorises acting on the position without
// further judgement. Only a crossing of a level the thesis pre-committed to
// does. Everything else is attention.
func IsProtective(k Kind) bool {
	return k == KindStop || k == KindInvalidation
}

type Severity string

const (
	SeverityInfo     Severity = "INFO"
	SeverityWarning  Severity = "WARNING"
	SeverityCritical Severity = "CRITICAL"
)

type Source string

const (
	SourceWebsocket Source = "websocket"
	SourceREST      Source = "rest"
)

// severityFor is fixed by the contract. A stop or a named invalidation is
// critical because the thesis pre-committed to acting on it. A target is a
// warning because taking profit is a judgement the thesis did not pre-commit.
func severityFor(k Kind) Severity {
	switch k {
	case KindStop, KindInvalidation:
		return SeverityCritical
	case KindTarget, KindStopApproach, KindPriceJump, KindVwapDeviation, KindVolumeSpike:
		return SeverityWarning
	case KindTargetApproach:
		return SeverityInfo
	default:
		return SeverityInfo
	}
}

// NormalisedTick is the vendor-independent form of one price update.
type NormalisedTick struct {
	Contract         string `json:"contract"`
	Symbol           string `json:"symbol"`
	ExchangeTs       *int64 `json:"exchangeTs"`
	ReceiveTs        int64  `json:"receiveTs"`
	Sequence         uint64 `json:"sequence"`
	PricePaise       int64  `json:"pricePaise"`
	CumulativeVolume *int64 `json:"cumulativeVolume"`
	Source           Source `json:"source"`
	Session          string `json:"session"`
}

// Commitment is what a thesis recorded at entry. The reflex evaluates these
// levels and nothing else, because they are the only decisions already made.
type Commitment struct {
	Symbol            string    `json:"symbol"`
	ThesisID          string    `json:"thesisId"`
	Direction         Direction `json:"direction"`
	StopPaise         *int64    `json:"stopPaise"`
	TargetPaise       *int64    `json:"targetPaise"`
	InvalidationPaise *int64    `json:"invalidationPaise"`
	Quantity          int64     `json:"quantity"`
	CorrelationID     string    `json:"correlationId"`
}

// SymbolState is the owner's view of one symbol since the last takeRange.
type SymbolState struct {
	Symbol    string `json:"symbol"`
	LastPaise int64  `json:"lastPaise"`
	HighPaise int64  `json:"highPaise"`
	LowPaise  int64  `json:"lowPaise"`
	Sequence  uint64 `json:"sequence"`
	UpdatedTs int64  `json:"updatedTs"`
}

// MarketEvent is emitted when a pre-committed level is crossed.
type MarketEvent struct {
	Contract      string   `json:"contract"`
	Kind          Kind     `json:"kind"`
	Symbol        string   `json:"symbol"`
	Severity      Severity `json:"severity"`
	Reason        string   `json:"reason"`
	PricePaise    int64    `json:"pricePaise"`
	LevelPaise    int64    `json:"levelPaise"`
	ThesisID      string   `json:"thesisId"`
	CorrelationID string   `json:"correlationId"`
	ObservedTs    int64    `json:"observedTs"`
	Sequence      uint64   `json:"sequence"`
}
