package marketdata

import "math"

// The one place a vendor's shape becomes the contract's shape.
//
// The Fyers HSM data socket is a proprietary, obfuscated binary protocol with no
// published schema, so the vendor SDK stays in Node and this plane receives the
// already-decoded frame. That is a vendor constraint, not a language
// preference, and it is why normalisation is a function here rather than a
// socket implementation.
//
// Everything downstream sees integer paise and epoch milliseconds. The float
// rupee value dies at this boundary and never travels further.

// VendorTick is the decoded frame as the feed edge emits it.
type VendorTick struct {
	Symbol    string   `json:"symbol"`
	Price     float64  `json:"price"`
	Volume    *float64 `json:"volume"`
	Timestamp int64    `json:"timestamp"`
	Source    string   `json:"source"`
}

// Normalise converts a decoded vendor frame into the contract form.
//
// It returns ok=false rather than a zero value for anything it cannot vouch
// for: an empty symbol, a non-positive or non-finite price, or a missing
// receipt time. A tick that cannot be trusted is dropped at the boundary, not
// carried inward as a plausible-looking number.
func Normalise(v VendorTick, receivedAt int64) (NormalisedTick, bool) {
	if v.Symbol == "" {
		return NormalisedTick{}, false
	}
	if math.IsNaN(v.Price) || math.IsInf(v.Price, 0) || v.Price <= 0 {
		return NormalisedTick{}, false
	}

	// Receipt time is always present by the contract. If the frame did not
	// carry one, the moment we received it is the honest answer.
	receiveTs := v.Timestamp
	if receiveTs <= 0 {
		receiveTs = receivedAt
	}

	source := SourceWebsocket
	switch v.Source {
	case string(SourceREST):
		source = SourceREST
	case string(SourceWebsocket), "":
		source = SourceWebsocket
	default:
		// Unknown enum values are rejected, never defaulted.
		return NormalisedTick{}, false
	}

	out := NormalisedTick{
		Contract: TickContract, Symbol: v.Symbol,
		ReceiveTs:  receiveTs,
		PricePaise: int64(math.Floor(v.Price*100 + 0.5)),
		Source:     source,
	}
	if v.Volume != nil && !math.IsNaN(*v.Volume) && !math.IsInf(*v.Volume, 0) && *v.Volume >= 0 {
		vol := int64(math.Floor(*v.Volume + 0.5))
		out.CumulativeVolume = &vol
	}
	return out, true
}
