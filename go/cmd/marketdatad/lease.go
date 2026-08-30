package main

import (
	"context"
	"errors"
	"time"

	"github.com/redis/go-redis/v9"
)

// Single ownership of the market-data role.
//
// Nothing claimed ownership before, so two instances opened two Fyers sockets
// against one account: a deploy overlap, or a developer running locally against
// the same token, silently doubled the connection count and the REST budget.
//
// The lease is a Redis key held by exactly one holder and renewed on a
// heartbeat. A crashed holder's lease expires on its own, so a replacement can
// take over without an operator intervening, and a holder that has lost its
// lease learns so on its next renewal and stops rather than continuing to
// believe it is the owner.

var ErrLeaseLost = errors.New("market-data lease lost")

// Renewal and release are compare-and-set on the holder id. Without the check a
// slow holder could renew or delete a lease that a successor already owns.
var renewScript = redis.NewScript(`
	if redis.call("get", KEYS[1]) == ARGV[1] then
		return redis.call("pexpire", KEYS[1], ARGV[2])
	end
	return 0
`)

var releaseScript = redis.NewScript(`
	if redis.call("get", KEYS[1]) == ARGV[1] then
		return redis.call("del", KEYS[1])
	end
	return 0
`)

type Lease struct {
	client *redis.Client
	key    string
	holder string
	ttl    time.Duration
}

func NewLease(client *redis.Client, key, holder string, ttl time.Duration) *Lease {
	return &Lease{client: client, key: key, holder: holder, ttl: ttl}
}

// Acquire takes the lease if it is free. It does not wait and it does not steal:
// a second instance is expected to exit, not to fight for ownership.
func (l *Lease) Acquire(ctx context.Context) (bool, error) {
	return l.client.SetNX(ctx, l.key, l.holder, l.ttl).Result()
}

func (l *Lease) Renew(ctx context.Context) error {
	ok, err := renewScript.Run(ctx, l.client, []string{l.key}, l.holder,
		l.ttl.Milliseconds()).Int64()
	if err != nil {
		return err
	}
	if ok == 0 {
		return ErrLeaseLost
	}
	return nil
}

func (l *Lease) Release(ctx context.Context) error {
	return releaseScript.Run(ctx, l.client, []string{l.key}, l.holder).Err()
}

// Keep renews on a heartbeat until the context ends or the lease is lost.
// Renewing at a third of the TTL survives two consecutive missed beats before
// an owner is declared dead.
func (l *Lease) Keep(ctx context.Context) error {
	interval := l.ttl / 3
	if interval <= 0 {
		interval = time.Second
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-t.C:
			if err := l.Renew(ctx); err != nil {
				return err
			}
		}
	}
}
