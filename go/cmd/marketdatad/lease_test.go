package main

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
)

// Ownership is the answer to "how do we prevent duplicate Fyers connections",
// so it is tested against a real Redis rather than a fake. Set
// TEST_REDIS_URL to run it.
func testClient(t *testing.T) *redis.Client {
	t.Helper()
	url := os.Getenv("TEST_REDIS_URL")
	if url == "" {
		t.Skip("TEST_REDIS_URL not set")
	}
	opts, err := redis.ParseURL(url)
	if err != nil {
		t.Fatalf("parsing TEST_REDIS_URL: %v", err)
	}
	c := redis.NewClient(opts)
	if err := c.Ping(context.Background()).Err(); err != nil {
		t.Fatalf("redis unreachable: %v", err)
	}
	t.Cleanup(func() { c.Close() })
	return c
}

func key(t *testing.T) string { return "test:lease:" + t.Name() }

func TestOnlyOneInstanceTakesTheLease(t *testing.T) {
	ctx := context.Background()
	c := testClient(t)
	k := key(t)
	c.Del(ctx, k)
	t.Cleanup(func() { c.Del(ctx, k) })

	first := NewLease(c, k, "instance-a", 5*time.Second)
	second := NewLease(c, k, "instance-b", 5*time.Second)

	got, err := first.Acquire(ctx)
	if err != nil || !got {
		t.Fatalf("first instance could not take a free lease: %v %v", got, err)
	}
	got, err = second.Acquire(ctx)
	if err != nil {
		t.Fatalf("second acquire errored: %v", err)
	}
	if got {
		t.Fatal("two instances both believe they own the market-data role")
	}
}

func TestAReleasedLeaseIsAvailableAgain(t *testing.T) {
	ctx := context.Background()
	c := testClient(t)
	k := key(t)
	c.Del(ctx, k)
	t.Cleanup(func() { c.Del(ctx, k) })

	first := NewLease(c, k, "instance-a", 5*time.Second)
	if _, err := first.Acquire(ctx); err != nil {
		t.Fatal(err)
	}
	if err := first.Release(ctx); err != nil {
		t.Fatal(err)
	}
	second := NewLease(c, k, "instance-b", 5*time.Second)
	got, err := second.Acquire(ctx)
	if err != nil || !got {
		t.Fatalf("a released lease did not become available: %v %v", got, err)
	}
}

// A crashed owner cannot release. The lease has to expire on its own or the
// role is unrecoverable without an operator.
func TestACrashedOwnersLeaseExpires(t *testing.T) {
	ctx := context.Background()
	c := testClient(t)
	k := key(t)
	c.Del(ctx, k)
	t.Cleanup(func() { c.Del(ctx, k) })

	crashed := NewLease(c, k, "instance-a", 300*time.Millisecond)
	if _, err := crashed.Acquire(ctx); err != nil {
		t.Fatal(err)
	}
	// No release, no renewal: the process is gone.
	time.Sleep(500 * time.Millisecond)

	successor := NewLease(c, k, "instance-b", 5*time.Second)
	got, err := successor.Acquire(ctx)
	if err != nil || !got {
		t.Fatalf("the role was unrecoverable after a crash: %v %v", got, err)
	}
}

// A slow holder must not renew or delete a lease its successor already owns.
func TestALostLeaseCannotBeRenewedOrReleased(t *testing.T) {
	ctx := context.Background()
	c := testClient(t)
	k := key(t)
	c.Del(ctx, k)
	t.Cleanup(func() { c.Del(ctx, k) })

	old := NewLease(c, k, "instance-a", 300*time.Millisecond)
	if _, err := old.Acquire(ctx); err != nil {
		t.Fatal(err)
	}
	time.Sleep(500 * time.Millisecond)

	successor := NewLease(c, k, "instance-b", 10*time.Second)
	if got, _ := successor.Acquire(ctx); !got {
		t.Fatal("successor could not take over")
	}

	if err := old.Renew(ctx); !errors.Is(err, ErrLeaseLost) {
		t.Fatalf("the old holder renewed a lease it no longer owns: %v", err)
	}
	if err := old.Release(ctx); err != nil {
		t.Fatalf("release errored: %v", err)
	}
	if owner, _ := c.Get(ctx, k).Result(); owner != "instance-b" {
		t.Fatalf("the old holder deleted its successor's lease: owner=%q", owner)
	}
}

func TestKeepHoldsTheLeaseAndStopsWhenItIsLost(t *testing.T) {
	ctx := context.Background()
	c := testClient(t)
	k := key(t)
	c.Del(ctx, k)
	t.Cleanup(func() { c.Del(ctx, k) })

	holder := NewLease(c, k, "instance-a", 600*time.Millisecond)
	if _, err := holder.Acquire(ctx); err != nil {
		t.Fatal(err)
	}

	keepCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- holder.Keep(keepCtx) }()

	// Renewal at a third of the TTL survives well past a single TTL.
	time.Sleep(1500 * time.Millisecond)
	if owner, _ := c.Get(ctx, k).Result(); owner != "instance-a" {
		t.Fatalf("the lease lapsed while being kept: owner=%q", owner)
	}

	// Something else takes the role away.
	c.Set(ctx, k, "instance-b", 10*time.Second)
	select {
	case err := <-done:
		if !errors.Is(err, ErrLeaseLost) {
			t.Fatalf("Keep returned %v, want ErrLeaseLost", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("Keep did not notice it had lost the lease")
	}
}
