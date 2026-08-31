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

Use `npm run --silent preflight` to suppress npm's own error block, which it
appends whenever the exit code is non-zero — that code is deliberate, so the
check can be scripted.

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

### The Fyers token, and why one more line is needed

Fyers registers **one** OAuth redirect URI per app, and in this deployment it is
the hosted backend:

```
FYERS_REDIRECT_URI = https://zentrade-server.onrender.com/fyers/callback
```

So when you authenticate — wherever you start from — the auth code is exchanged
*there*, and the token is written to *that* deployment's Redis. A machine
running against its own Redis has no token and never will, however many times
you re-authenticate. That is a property of the Fyers app registration, not a bug
in this system.

Startup handles it. Add the source Redis once:

```
FYERS_TOKEN_SOURCE_REDIS_URL=<the Redis of the deployment that owns the callback>
```

`npm run preflight`, `npm run server` and `npm run agent` each fetch the token
themselves when the local one is missing or expired, preserving its real
remaining life. Only the two auth keys move — never the price cache, the
rate-limit budget or the market-data ownership lease.

`scripts/syncFyersToken.js` remains as a manual escape hatch for fetching a
token without starting anything. You should not need it.

**If you run the backend where the callback lands** (`FYERS_REDIRECT_URI` on
localhost, or on the hosted machine itself), none of this applies: the token is
minted where you are and no source is needed. Startup detects this and says so.

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
| `FRONTEND_URL` | OAuth redirects and email links, not the cockpit URL |
| `FYERS_TOKEN_SOURCE_REDIS_URL` | see above; only when the callback belongs elsewhere |

**`ZENTRADE_FAST_PLANE`.** `shadow` runs the Go plane against the real feed and
compares it against the local reflex without acting on it. `live` makes it the
authoritative detector and stops the local reflex dispatching. Shadow is the
default because the plane has not yet run a full live session; move to `live`
after one session with zero divergence, which the cockpit reports.

## Dependencies that must already be running

Postgres and Redis. The preflight and the agent both check them and fail with
the reason rather than starting degraded. Migrations run automatically on
backend start — there is nothing to run by hand.

## The account is not reset in the morning

There is one paper account. It was opened once at Rs 10,00,000 and it continues
from wherever it was: the starting capital is written at opening and never
updated, and cash only moves when an order fills. A trading day is a reporting
boundary, not an accounting one, so yesterday's closing cash is today's opening
cash by virtue of being the same row. Nothing in the codebase assigns a balance
at startup.

What survives a restart, a crash and a day boundary, all in Postgres:

| | |
|---|---|
| cash, positions, average entry, margin committed | `users.balance_paise`, `portfolio` |
| orders and fills, realised P&L, costs | `orders`, `order_fills` |
| entry theses and every reassessment | `trade_thesis`, `position_reassessments` |
| every decision and its reasoning, traded or not | `decision_records` |
| per-day summaries | `session_summaries` |
| starts, stops, failed reconciliations | `agent_events` |

Each agent start reconciles before it trades:

    cash = starting capital + opening adjustment + realised P&L - costs
           - margin committed to open positions

A mismatch is reported and recorded, never repaired. The balance is the record;
a startup that quietly rewrites it to match its own arithmetic destroys the
evidence of whatever caused the drift. Duplicate orders are impossible across a
restart by construction: `client_order_id` is unique in the database, so a
replayed intent lands on the row that already exists.

The cockpit's Account panel shows equity, cash, both sides of P&L, what is
committed to positions, and whether the account reconciled. The Decision record
panel below it reads back from the database, which is why it is still populated
after a restart.

## Stopping the trader without killing it

```
curl -XPOST localhost:$PORT/internal/brain/halt \
  -H 'Authorization: Bearer <token>' -H 'Content-Type: application/json' \
  -d '{"halted":true,"reason":"feed looks wrong"}'
```

HALTED keeps observation and reconciliation running and refuses everything that
adds or changes exposure. The trader applies it within a couple of seconds and
narrates that it did; `GET` the same path to see both what was requested and
what the trader reports.

The stop is durable, so restarting the agent does not clear it. Send
`{"halted":false}` to resume.

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
| Preflight `access token` FAIL | read the message: it says whether to re-authenticate or to set `FYERS_TOKEN_SOURCE_REDIS_URL` |
| Preflight `positions with a thesis` FAIL | a holding cannot be reassessed or protected |
| Agent: `another instance already owns the market-data role` | an agent is already running |
