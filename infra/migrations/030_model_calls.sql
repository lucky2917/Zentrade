-- Where the model calls went.
--
-- Every call the reasoning pipeline makes is already recorded: callGroqSafe
-- pushes a row into a sink carrying the agent, the model, the status, the
-- latency and the token usage, and reason() returns the whole sink as
-- decision.agentRuns. Nothing ever wrote it down. agent_runs has held zero rows
-- for the life of the database, because it belongs to the research path and its
-- request_id foreign key points at decision_requests, which the autonomous
-- trader does not create.
--
-- The cost of that was measurable during the 2026-09-01 session: with 429s
-- arriving and throughput in question, the call rate had to be INFERRED by
-- multiplying decision counts by two, and a retry or a failed call left no
-- trace at all.
--
-- This is the trader's own record, keyed to the decision it was made for.

CREATE TABLE IF NOT EXISTS model_calls (
  id                BIGSERIAL PRIMARY KEY,
  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The decision this call was made for. Not a foreign key: the call is
  -- written whether or not the decision it belonged to ever completed, and a
  -- call that died on a rate limit is exactly the one worth keeping.
  decision_id       VARCHAR(64),
  correlation_id    VARCHAR(64),
  session_date      DATE NOT NULL,
  symbol            VARCHAR(32),
  -- senior_thesis_formation, senior_thesis_challenge, senior_reassess_*
  agent_name        VARCHAR(48) NOT NULL,
  model_id          VARCHAR(64) NOT NULL,
  status            VARCHAR(12) NOT NULL,
  latency_ms        INTEGER,
  prompt_tokens     INTEGER,
  completion_tokens INTEGER,
  -- Present only on a failure, and the reason a call cost budget without
  -- producing a decision.
  error             TEXT,
  called_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_model_calls_session
  ON model_calls (user_id, session_date DESC, called_at DESC);
CREATE INDEX IF NOT EXISTS idx_model_calls_decision
  ON model_calls (decision_id);
CREATE INDEX IF NOT EXISTS idx_model_calls_status
  ON model_calls (user_id, status, called_at DESC);

-- When a symbol was last reasoned about as a CANDIDATE.
--
-- The runtime keeps this in a Map, so a restart forgets it and pays again for a
-- symbol it priced minutes earlier. Observed on 2026-09-01: ALOKINDS and
-- OLAELEC were re-reasoned 442 and 562 seconds apart, both inside the 15 minute
-- cooldown, because a restart fell between them.
CREATE TABLE IF NOT EXISTS candidate_cooldowns (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  symbol      VARCHAR(32) NOT NULL,
  reasoned_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (user_id, symbol)
);
