# Starting ZenTrade

Three terminals. Nothing else to remember.

## Before the first run

```
npm ci                 # from the repository root
cd apps/api
npm run preflight
```

The preflight is the one authoritative check. It ends in `READY` or in
`NOT READY` with the reason. It prints no secrets.

## Every morning

**Re-authenticate Fyers first.** The token expires at 03:00 IST daily. Visit
`${FRONTEND_URL}/reauth`. Nothing observes the market without it, and the
preflight will tell you so.

### Terminal 1 — frontend

```
cd apps/web
npm run dev
```

Serves the cockpit on `http://localhost:5173` with hot reload. **Optional:** if
`apps/web/dist` exists, the backend serves the cockpit itself and you can skip
this terminal entirely.

### Terminal 2 — backend

```
cd apps/api
npm run server
```

The API, the Fyers vendor edge, the websocket, the bar aggregator and the
cockpit's HTTP and socket transport. Port 5000 by default. **This process does
not trade** — it cannot start an autonomous runtime.

### Terminal 3 — the autonomous trader

```
cd apps/api
npm run agent
```

This one command:

1. checks the environment, Postgres and Redis, and names exactly what is missing
2. builds the Go fast market plane and starts it
3. waits for it to take ownership of the market-data role
4. starts the autonomous runtime — brain, risk gate, paper execution
5. prints the status

It prints:

```
  ZEN TRADE AUTONOMOUS TRADER
  ===========================

  MODE              PAPER
  FAST PLANE        ACTIVE (shadow)
  SENIOR BRAIN      ACTIVE
  RISK              ARMED
  EXECUTION         PAPER
  MARKET            OPEN
  ARMED POSITIONS   2

  TRADER IS RUNNING

  COCKPIT:
  http://localhost:5173/trader
```

### Open

**`http://localhost:5173/trader`** — or `http://localhost:5000/trader` when the
backend is serving the build.

---

## What each command owns

| | `npm run dev` | `npm run server` | `npm run agent` |
|---|---|---|---|
| Cockpit UI | serves it | serves the build | — |
| API, auth, routes | — | yes | — |
| Fyers socket, bars | — | yes | — |
| Cockpit transport | — | yes | — |
| Go fast plane | — | — | **starts it** |
| World state, reflex | — | — | via the plane |
| Senior Trader Brain | — | — | yes |
| Risk gate, execution | — | — | yes |

There is exactly one autonomous runtime and it lives in the agent process. The
backend cannot start a second one — there is a test asserting the code to do so
does not exist.

## Does the agent start Go automatically?

Yes. It builds `go/cmd/marketdatad` if the binary is missing, starts it, and
waits for it to take the Redis ownership lease. If the Go toolchain is absent it
says so and tells you to run `ZENTRADE_FAST_PLANE=off npm run agent`, which
starts the trader with its own local reflex protecting instead.

## Configuration

Required in `apps/api/.env`:

```
DATABASE_URL        Postgres
REDIS_URL           Redis
JWT_SECRET          at least 32 characters
FYERS_CLIENT_ID     Fyers app
FYERS_SECRET_KEY    Fyers app
FYERS_REDIRECT_URI  Fyers app
```

Optional:

| | |
|---|---|
| `GROQ_API_KEY` | without it every reasoning call falls back to HOLD |
| `ZENTRADE_ACCOUNT_ID` | defaults to 1 |
| `ZENTRADE_FAST_PLANE` | `shadow` (default), `live`, `off` |
| `PORT` | defaults to 5000 |
| `FRONTEND_URL` | cockpit URL in the banner |

**`ZENTRADE_FAST_PLANE`.** `shadow` runs the Go plane against the real feed and
compares it against the local reflex without acting on it. `live` makes it the
authoritative detector and stops the local reflex dispatching. Shadow is the
default because the plane has not yet run a full live session; move to `live`
after one session with zero divergence, which the cockpit reports.

## Dependencies that must already be running

Postgres and Redis. The preflight and the agent both check them and fail with
the reason rather than starting degraded. Migrations run automatically on
backend start — there is nothing to run by hand.

## Shutdown

`Ctrl-C` in terminal 3. In order: the trader stops taking new work, drains,
reconciles, releases its heartbeat, then the fast plane is stopped and releases
its ownership lease. No orphan processes, no orphan timers, and the next start
finds the role free.

`Ctrl-C` in terminal 2 stops the API: cron jobs stop, the event backbone drains,
bars flush, the Fyers socket closes.

Stopping the backend does not stop the trader, and stopping the trader does not
stop the backend. That is the point of the split.

## If something is wrong

| Symptom | Meaning |
|---|---|
| `TRADER NOT RUNNING` in the cockpit | terminal 3 is not started |
| `FEED STALE` | ticks stopped; new exposure is blocked automatically |
| `MARKET CLOSED` | outside 09:15–15:30 IST, or not a trading day |
| Preflight `access token` FAIL | re-authenticate Fyers |
| Preflight `positions with a thesis` FAIL | a holding cannot be reassessed or protected |
| Agent: `another instance already owns the market-data role` | an agent is already running |
