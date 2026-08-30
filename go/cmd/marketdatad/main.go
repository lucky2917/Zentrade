// Command marketdatad is the fast market plane.
//
// It owns the live world state, the deterministic reflex over pre-committed
// levels, continuous material-change detection and feed liveness. It consumes
// decoded ticks from the feed edge and emits material events.
//
// It has no model client, no database driver and no order path linked into it.
// That is deliberate: the fast plane cannot wait for the LLM, and it cannot be
// made to by adding an import, because there is nothing here to import.
//
// Run it in shadow first. In shadow it writes to its own namespace and nothing
// downstream reads it, so it can be compared against the incumbent for a full
// session before anything depends on it.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/zentrade/zentrade/go/marketdata"
)

const (
	leaseKey       = "zentrade:marketdata:owner"
	tickChannel    = "price:update"
	commandChannel = "marketdata:commands"
	commandBacklog = "marketdata:commands:state"
	liveStream     = "marketdata:events"
	shadowStream   = "shadow:marketdata:events"
	liveChannel    = "marketdata:events:live"
	shadowChannel  = "shadow:marketdata:events:live"
	liveHealth     = "marketdata:plane:health"
	shadowHealth   = "shadow:marketdata:plane:health"
	healthTTL      = 15 * time.Second
)

type config struct {
	redisURL      string
	mode          string
	sweepInterval time.Duration
	staleAfter    time.Duration
	leaseTTL      time.Duration
	healthAddr    string
}

func main() {
	var cfg config
	flag.StringVar(&cfg.mode, "mode", "shadow", "shadow | live")
	flag.DurationVar(&cfg.sweepInterval, "sweep", time.Second, "feed liveness sweep interval")
	flag.DurationVar(&cfg.staleAfter, "stale-after", 30*time.Second, "silence before a symbol is reported blind")
	flag.DurationVar(&cfg.leaseTTL, "lease-ttl", 15*time.Second, "ownership lease duration")
	flag.StringVar(&cfg.healthAddr, "health", "127.0.0.1:5601", "health endpoint address")
	flag.Parse()

	// The connection string is read from the environment and never logged.
	cfg.redisURL = os.Getenv("REDIS_URL")
	if cfg.redisURL == "" {
		log.Fatal("marketdatad: REDIS_URL is not set")
	}
	if cfg.mode != "shadow" && cfg.mode != "live" {
		log.Fatalf("marketdatad: unknown mode %q, want shadow or live", cfg.mode)
	}

	if err := run(cfg); err != nil {
		log.Fatalf("marketdatad: %v", err)
	}
}

func run(cfg config) error {
	opts, err := redis.ParseURL(cfg.redisURL)
	if err != nil {
		return fmt.Errorf("parsing REDIS_URL: %w", err)
	}
	client := redis.NewClient(opts)
	defer client.Close()

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	if err := client.Ping(ctx).Err(); err != nil {
		return fmt.Errorf("redis unreachable: %w", err)
	}

	holder := fmt.Sprintf("%s-%d-%d", hostname(), os.Getpid(), time.Now().UnixNano())
	lease := NewLease(client, leaseKey, holder, cfg.leaseTTL)
	held, err := lease.Acquire(ctx)
	if err != nil {
		return fmt.Errorf("acquiring the lease: %w", err)
	}
	if !held {
		// Exit non-zero rather than opening a second connection to the venue.
		return fmt.Errorf("another instance owns the market-data role; refusing to start a second")
	}
	defer func() {
		release, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = lease.Release(release)
	}()

	stream, channel, healthKey := shadowStream, shadowChannel, shadowHealth
	if cfg.mode == "live" {
		stream, channel, healthKey = liveStream, liveChannel, liveHealth
	}
	log.Printf("marketdatad: mode=%s stream=%s channel=%s holder=%s",
		cfg.mode, stream, channel, holder)

	// Declared before construction because the heartbeat closure below reads the
	// plane it is attached to.
	var plane *marketdata.Plane
	plane = marketdata.NewPlane(newRedisSink(client, stream, channel), marketdata.PlaneConfig{
		SweepInterval: cfg.sweepInterval,
		StaleAfter:    cfg.staleAfter,
		// The plane's own liveness, written on work it already does. Node reads
		// it to tell "the plane is quiet" from "the plane is dead", which are
		// the same thing on the wire and very different things in a session.
		OnSweep: func(m marketdata.PlaneMetrics) {
			publishHealth(client, healthKey, plane, cfg.mode, holder, m)
		},
	})

	go serveHealth(cfg.healthAddr, plane, cfg.mode, holder)

	// Losing the lease is fatal by design: an owner that no longer owns the role
	// must stop, not keep publishing alongside its successor.
	errs := make(chan error, 2)
	go func() { errs <- lease.Keep(ctx) }()
	go func() { errs <- consume(ctx, client, plane) }()

	err = <-errs
	if ctx.Err() != nil {
		log.Print("marketdatad: shutting down")
		return nil
	}
	return err
}

// consume subscribes to the decoded feed and the command channel, then drives
// the plane. Redis re-subscribes on its own after a drop; a decode failure skips
// one message rather than ending the session.
func consume(ctx context.Context, client *redis.Client, plane *marketdata.Plane) error {
	// Subscribe to commands BEFORE replaying the backlog, so a command issued
	// during the replay is queued rather than lost in the gap between them.
	commandSub := client.Subscribe(ctx, commandChannel)
	defer commandSub.Close()
	if _, err := commandSub.Receive(ctx); err != nil {
		return fmt.Errorf("subscribing to %s: %w", commandChannel, err)
	}

	tickSub := client.Subscribe(ctx, tickChannel)
	defer tickSub.Close()
	if _, err := tickSub.Receive(ctx); err != nil {
		return fmt.Errorf("subscribing to %s: %w", tickChannel, err)
	}

	commands := make(chan marketdata.Command, 1024)

	// Restart recovery. A plane that came up after the brain had already armed
	// its positions would protect nothing until the next entry, which is the
	// worst possible time to discover it. The brain keeps the current
	// commitments in a hash; replaying it makes a restart safe.
	replayed, err := replayCommands(ctx, client, commands)
	if err != nil {
		return fmt.Errorf("replaying the command backlog: %w", err)
	}
	log.Printf("marketdatad: replayed %d commitment(s) on start", replayed)

	go func() {
		for msg := range commandSub.Channel() {
			var c marketdata.Command
			if err := json.Unmarshal([]byte(msg.Payload), &c); err != nil {
				continue
			}
			select {
			case commands <- c:
			default:
				log.Print("marketdatad: command backlog full, dropping one")
			}
		}
	}()

	ticks := make(chan marketdata.NormalisedTick, 4096)
	go func() {
		defer close(ticks)
		for msg := range tickSub.Channel() {
			var vendor marketdata.VendorTick
			if err := json.Unmarshal([]byte(msg.Payload), &vendor); err != nil {
				continue
			}
			tick, ok := marketdata.Normalise(vendor, time.Now().UnixMilli())
			if !ok {
				continue
			}
			select {
			case ticks <- tick:
			default:
				// The plane is behind. Dropping the oldest would reorder the
				// stream; dropping this one keeps the sequence honest and the
				// loss visible in the plane's rejected count.
			}
		}
	}()

	return plane.Run(ctx, ticks, commands)
}

// The brain's current commitments, one field per symbol. Read once at start so
// a restarted plane arms what is actually held rather than waiting for the next
// entry to learn about the book.
func replayCommands(ctx context.Context, client *redis.Client,
	commands chan<- marketdata.Command) (int, error) {

	entries, err := client.HGetAll(ctx, commandBacklog).Result()
	if err != nil {
		return 0, err
	}
	replayed := 0
	for _, raw := range entries {
		var batch []marketdata.Command
		if err := json.Unmarshal([]byte(raw), &batch); err != nil {
			continue
		}
		for _, c := range batch {
			select {
			case commands <- c:
				replayed++
			default:
				return replayed, fmt.Errorf("command backlog exceeds the queue")
			}
		}
	}
	return replayed, nil
}

// Two destinations, one write.
//
//	channel  push, so the brain reacts to a protective crossing in about a
//	         millisecond rather than on a drain interval. This is the path that
//	         matters: a stop breach must not wait for a poll.
//	stream   a bounded replay log, so a brain that restarts or a cockpit that
//	         refreshes can recover what it missed.
//
// A consumer that stops reading must not be able to exhaust memory here, hence
// the trim; and publish is fire-and-forget by nature, so a channel with no
// subscriber costs nothing.
func newRedisSink(client *redis.Client, stream, channel string) marketdata.EventSink {
	return marketdata.SinkFunc(func(e marketdata.MarketEvent) error {
		payload, err := json.Marshal(e)
		if err != nil {
			return err
		}
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		pipe := client.TxPipeline()
		pipe.Publish(ctx, channel, payload)
		pipe.RPush(ctx, stream, payload)
		pipe.LTrim(ctx, stream, -10_000, -1)
		_, err = pipe.Exec(ctx)
		return err
	})
}

// The plane's heartbeat. Short TTL so a dead plane disappears rather than
// leaving a stale record that reads as healthy.
func publishHealth(client *redis.Client, key string, plane *marketdata.Plane,
	mode, holder string, m marketdata.PlaneMetrics) {

	payload, err := json.Marshal(map[string]any{
		"contract": marketdata.ContractVersion,
		"mode":     mode,
		"holder":   holder,
		"at":       time.Now().UnixMilli(),
		"plane":    m,
		"lane":     plane.Lane().Health(),
		"symbols":  len(plane.Lane().Symbols()),
	})
	if err != nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	// Best effort: a health write that fails must not disturb the plane.
	_ = client.Set(ctx, key, payload, healthTTL).Err()
}

func serveHealth(addr string, plane *marketdata.Plane, mode, holder string) {
	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"contract": marketdata.ContractVersion,
			"mode":     mode,
			"holder":   holder,
			"plane":    plane.Metrics(),
			"lane":     plane.Lane().Health(),
			"symbols":  len(plane.Lane().Symbols()),
		})
	})
	server := &http.Server{Addr: addr, Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Printf("marketdatad: health endpoint stopped: %v", err)
	}
}

func hostname() string {
	h, err := os.Hostname()
	if err != nil {
		return "unknown"
	}
	return h
}
