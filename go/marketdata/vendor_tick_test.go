package marketdata

import "testing"

func f(v float64) *float64 { return &v }

func TestNormaliseProducesIntegerPaise(t *testing.T) {
	got, ok := Normalise(VendorTick{Symbol: "RELIANCE", Price: 1234.56,
		Volume: f(98765), Timestamp: 1_700_000_000_000}, 0)
	if !ok {
		t.Fatal("refused a good tick")
	}
	if got.PricePaise != 123_456 {
		t.Errorf("pricePaise = %d, want 123456", got.PricePaise)
	}
	if got.CumulativeVolume == nil || *got.CumulativeVolume != 98_765 {
		t.Errorf("volume lost: %+v", got.CumulativeVolume)
	}
	if got.Contract != TickContract {
		t.Errorf("contract not stamped: %q", got.Contract)
	}
}

// A rupee value that round-trips through a float is a rupee value that can
// disagree between two runtimes. It dies at this boundary.
func TestNormaliseRoundsRatherThanTruncating(t *testing.T) {
	for _, c := range []struct {
		price float64
		want  int64
	}{
		{100.005, 10_001}, {100.004, 10_000}, {0.01, 1}, {2456.7, 245_670},
		{1234.565, 123_457},
	} {
		got, ok := Normalise(VendorTick{Symbol: "X", Price: c.price, Timestamp: 1}, 0)
		if !ok || got.PricePaise != c.want {
			t.Errorf("price %v -> %d, want %d", c.price, got.PricePaise, c.want)
		}
	}
}

func TestNormaliseRefusesWhatItCannotVouchFor(t *testing.T) {
	bad := []VendorTick{
		{Symbol: "", Price: 100, Timestamp: 1},
		{Symbol: "X", Price: 0, Timestamp: 1},
		{Symbol: "X", Price: -1, Timestamp: 1},
		{Symbol: "X", Price: nan(), Timestamp: 1},
		{Symbol: "X", Price: inf(), Timestamp: 1},
		{Symbol: "X", Price: 100, Timestamp: 1, Source: "guessed"},
	}
	for i, v := range bad {
		if _, ok := Normalise(v, 0); ok {
			t.Errorf("case %d: accepted a tick it cannot vouch for: %+v", i, v)
		}
	}
}

func TestNormaliseFallsBackToReceiptTime(t *testing.T) {
	got, ok := Normalise(VendorTick{Symbol: "X", Price: 100}, 4_242)
	if !ok || got.ReceiveTs != 4_242 {
		t.Fatalf("receiveTs = %d, want the moment of receipt 4242", got.ReceiveTs)
	}
}

func TestNormaliseKeepsSourceDistinct(t *testing.T) {
	// A polled quote and a streamed tick share a cache key upstream and must
	// not be judged by the same freshness bound.
	rest, _ := Normalise(VendorTick{Symbol: "X", Price: 1, Timestamp: 1, Source: "rest"}, 0)
	ws, _ := Normalise(VendorTick{Symbol: "X", Price: 1, Timestamp: 1, Source: "websocket"}, 0)
	if rest.Source != SourceREST || ws.Source != SourceWebsocket {
		t.Fatalf("source collapsed: rest=%q ws=%q", rest.Source, ws.Source)
	}
}

func TestNormaliseDropsAnUnusableVolumeWithoutDroppingTheTick(t *testing.T) {
	got, ok := Normalise(VendorTick{Symbol: "X", Price: 100, Timestamp: 1, Volume: f(-5)}, 0)
	if !ok {
		t.Fatal("a bad volume discarded a good price")
	}
	if got.CumulativeVolume != nil {
		t.Errorf("kept a negative cumulative volume: %v", *got.CumulativeVolume)
	}
}
