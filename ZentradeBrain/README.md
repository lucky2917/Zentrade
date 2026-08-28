# ZenTrade Brain

Paper-trading research system for NSE equities. Python, single language, local first.

Architecture is frozen (v4 + freeze audit). This repository implements it.
The JS product lives separately at `../Zentrade` and shares nothing but the
generated NSE session calendar in `reference/`.

## Layout

    src/zentrade/
      kernel/      money, clock. Imports nothing internal.
      contracts/   pydantic models validated at every boundary
      spine/       point-in-time parquet storage (spine_v1)
      adapters/    data/ (NSE archives, Fyers) and execution/ (paper)
      features/    canonical feature engine
      core/        TRADING CORE process. Sole writer of trading state.
      research/    RESEARCH process. Structurally cannot trade.
      learning/    LEARNING process. Offline, pull-only.
      obs/         journal and dashboard generation
      replay/      replay harness

## Running

    .venv/bin/python -m pytest                        # offline suite
    ZENTRADE_NETWORK_TESTS=1 .venv/bin/python -m pytest   # includes archive fetches

## Invariants enforced by tests

`tests/architecture/` fails the build if research or learning import the Core,
if any module outside `kernel/clock.py` reads a wall clock, if broker secrets
appear outside `core/credentials.py`, or if the session calendar drifts from
the JS kernel it is generated from.
