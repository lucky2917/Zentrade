# Migration: what the brain replaces

The brain is not an addition to the JS product. It replaces the part of it
that decides trades. Nothing is removed until the brain earns it, and this
file records which is which so the boundary is a decision rather than an
assumption made later under pressure.

## Retired once the brain clears its acceptance bar

These implement the premise the frozen architecture rejects, that an LLM makes
the trading decision:

| Component | Why it goes |
|---|---|
| `apps/api/src/services/aiEngine.js` | Four Groq agents deliberate and the synthesizer decides. In the frozen architecture the LLM annotates and explains; a calibrated model decides. |
| `us_agent/` (AI-Trader, TradingAgents) | Both are LLM-decides-trades systems. AI-Trader additionally ships no license, so it cannot be built on regardless. |
| `apps/api/src/services/screener.js`, `alertService.js` | The lane-driven auto-analysis path exists to feed aiEngine. It has no purpose once aiEngine is gone. |

**Retirement condition:** the brain passes the acceptance table in the frozen
spec, out of sample, after realistic costs, plus six months of forward paper
trading. Not before. Until then both systems run and the old one is the only
one that has ever produced a decision.

## Kept, because the brain depends on it

| Component | Why it stays |
|---|---|
| M11-M17 measurement chain | Journal, outcomes, regimes, calibration, memory, reflection. This is the foundation the brain builds on. Retiring it would delete the only record of what the system has ever decided and how it turned out. |
| Fyers market data (`services/fyers/`) | The brain consumes NSE archives for history, but live intraday has to come from somewhere, and this already works within its rate budget. |
| Product surface | Auth, portfolio, orders, watchlist, charts, PWA. Unrelated to how decisions are made. |

## The distinction

The decision layer is replaced. The measurement layer is inherited. Confusing
the two would throw away the part of the existing system that is hardest to
rebuild and most valuable to the brain.
