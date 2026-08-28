# Cascade prototype

Built 2026-08-27, before the v4 senior-trader architecture was frozen.

A three-tier runtime where the tier is a cost statement: REFLEX runs on every
symbol every tick for zero tokens, GATE runs only on what changed and decides
what deserves an LLM, DELIBERATE runs only on what GATE escalated and is the
sole tier allowed to spend tokens. A simulated NSE session measured the effect
at 8.1 billion tokens naive versus 2.0 million actual.

## Status: superseded, retained

The frozen v4 architecture does not use these tiers. It has Attention,
Predictor, EV and Portfolio as named components with different contracts, so
this code is not on the implementation path and is not imported anywhere.

It is kept because the ideas survive the design change and are likely to
inform two things:

- **Attention (v4 component 11)** faces the same problem GATE solved: choosing
  what deserves expensive evaluation. The escalation and change-detection
  approach here transfers.
- **Token budgeting** is not yet specified in v4 beyond "the LLM is deferred".
  When the language layer arrives at M23, the refuse-before-the-call design
  and per-agent attribution are the starting point.

One measured result is worth carrying forward regardless: the simulation
escalated 49,563 candidates but the budget only permitted 1,111. A hard cap
doing the limiting means the gate is too loose, and a spending limit rather
than a model is choosing what to think about. Whatever replaces GATE has to be
selective enough that the budget rarely binds.

Not tested, not imported, not maintained. Read it, do not build on it.
