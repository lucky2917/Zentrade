# The trader cockpit

A live, read-only operator view of the autonomous system. It exists so that
watching ZenTrade work is possible, and so that what is watched is what the
system actually did.

## Start it

```
cd apps/api
npm run preflight     # will the brain actually trade?
npm run agent         # the fast plane, the brain and the cockpit
```

`npm run agent` is the single command. It checks the dependencies and names what
is missing rather than starting degraded, builds and starts the Go fast market
plane, waits for it to take ownership, then starts the API — which hosts the
Senior Trader Brain and serves the cockpit on the same port. Shutdown is ordered
the other way: the brain stops first, so it never loses its feed mid-decision.

Then open the URL the banner prints — `http://localhost:5000/trader`.

| Command | What it runs |
|---|---|
| `npm run agent` | fast plane + brain + cockpit — **the one to use** |
| `npm run brain` | brain + cockpit, no fast plane |
| `npm start` | API only, no brain |
| `ZENTRADE_FAST_PLANE=off npm run agent` | no Go toolchain needed |

For frontend development, `npm run dev` in `apps/web` serves the cockpit on 5173
with hot reload against the same API.

## The rule the whole design rests on

**Nothing in the cockpit generates activity.** The narrator has no timer, no
synthetic event and no "thinking" animation. It emits only when the runtime
calls it, at points where something genuinely happened. There is a test that
fails if a timer appears in it.

The consequence is the intended experience: a quiet market produces a quiet
screen that says `WAITING FOR MATERIAL CHANGE`, and a material event produces a
burst of real reasoning. The rhythm is the market's, not an animation's.

## Data flow

```
Fyers HSM socket (Node vendor edge)
   └─> price:update ──> marketdatad (Go, separate process)
                          · world state, 64 shards
                          · deterministic reflex
                          · continuous detection
                          · liveness sweep
                          └─> zentrade.marketdata.event.v1
                                ├─ pub/sub  ──> Node bridge ──> protect()
                                └─ list     ──> replay after a restart
                                                      │
AGENT PROCESS                          API PROCESS
runtime event                                 │
  └─> narrator.emit()                         │
        (ring, monotonic seq)                 │
        └─> Redis "cockpit:narration" ──> narrator.ingest()
                                              ├─> socket.io room "cockpit"
                                              └─> GET /internal/cockpit/snapshot

The agent assigns the sequence; the API preserves it. If both assigned their
own, a browser reconnecting to the API would dedupe against numbers the agent
never used. The agent also writes a short-TTL heartbeat, so the cockpit can tell
a quiet trader from a stopped one and says TRADER NOT RUNNING rather than ARMED.
```

**One authoritative detector.** When the plane is `live` its events drive
protection and the Node reflex stops dispatching — it keeps state for
comparison and for the supervisory range, but does not act. Two actors reacting
to one crossing is two exits. There is a test that drives the local lane with a
breaching price while the plane is live and asserts nothing executes.

Fast-plane events are marked `source: "FAST_PLANE"` and render distinctly in the
cockpit while sharing one timeline with reasoning, risk and execution.

Narration is a **side channel**. Every call site is wrapped so a display failure
cannot throw into a decision, and the runtime behaves identically with no
narrator attached — both are tested.

## What is shown

Only structured artifacts the system already produces and journals: the
deterministic TraderState with evidence tiers, the formed thesis, the
adversarial challenge and its counter-thesis, alternative hypotheses,
what-would-change-my-mind, the deterministic synthesis with the 73.55 bps cost
hurdle, the decision, the revalidation, the risk verdict, and the real Phase 1
order states.

**No hidden chain-of-thought is displayed.** The pipeline does not expose one,
so there is none available to render.

Anything the system does not know renders as `UNKNOWN`. Confidence with no
stated basis renders as `INSUFFICIENT BASIS` rather than as a number.

## Refresh and reconnect

Every event carries a monotonic sequence. On reconnect the client sends the
sequence it holds and receives only what came after it, so a refresh cannot
duplicate or lose events. If the client was away long enough for the ring buffer
to roll past it, the server sets `gap` and the client reloads rather than
stitching over a hole in its own history.

Bursts are coalesced onto an animation frame: 200 events cost one render, not
200.

## Read-only, structurally

- The router defines **only GET handlers**, asserted by a test that inspects the
  Express stack and by a test that fires POST/PUT/PATCH/DELETE at the running
  server.
- The cockpit modules import nothing that can place, cancel or amend an order —
  asserted by a source-level test, so a future handler cannot quietly acquire
  the ability.
- `state.js` contains `SELECT` and no `INSERT`, `UPDATE` or `DELETE`.
- The socket stream is gated by the same JWT the HTTP API uses. Not a new
  authentication system: the same secret, the same claims.

## Bugs this work surfaced

**The challenger never produced a counter-thesis.** The architecture claimed one
and `validateChallenge` never extracted one, so the field was silently absent
everywhere. The prompt now asks for it explicitly and the validator extracts it,
with the adverse fallback carrying "not established" rather than nothing.

**Decision narration could abort a decision.** `narrateDecision` and
`decisionCard` were called outside the guarded helper, so a display failure
would have propagated into reasoning. Both are guarded now.

**The cockpit router killed the server at boot.** It was mounted at module scope
with `health` and the account id passed by value, both declared later in the
file — a temporal dead zone error before the process ever listened. Every
dependency is an accessor now. The full regression caught it.
