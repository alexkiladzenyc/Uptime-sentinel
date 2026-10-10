-- Job queue. One table holds every job; `status` is the state machine:
--
--   available --claim--> running --complete--> succeeded
--       ^                  |  |
--       |                  |  +--fail (attempts left) / lease expired--> available (run_at in the future)
--       |                  +-----fail (no attempts left) / permanent error--> dead
--       +-------------------------- manual retry ------------------------------+
--
-- `dead` is the dead-letter queue: rows stay there, with their last error,
-- until someone retries or deletes them.

CREATE TABLE jobs (
  id               bigserial PRIMARY KEY,
  type             text        NOT NULL,
  payload          jsonb       NOT NULL DEFAULT '{}'::jsonb,
  status           text        NOT NULL DEFAULT 'available'
                     CHECK (status IN ('available', 'running', 'succeeded', 'dead')),
  attempts         integer     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts     integer     NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
  run_at           timestamptz NOT NULL DEFAULT now(),
  -- A fresh token is issued on every claim. complete/fail/heartbeat must
  -- present it, so a worker whose lease expired cannot overwrite the result
  -- of the worker that took the job over (a fencing token).
  lease_token      uuid,
  lease_expires_at timestamptz,
  locked_by        text,
  last_error       text,
  -- Optional idempotency key: at most one *active* job per key.
  dedupe_key       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz,
  CHECK ((status = 'running') = (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL))
);

-- Claim path: oldest due available job first.
CREATE INDEX jobs_available_idx ON jobs (run_at, id) WHERE status = 'available';
-- Reaper path: running jobs whose lease has expired.
CREATE INDEX jobs_running_lease_idx ON jobs (lease_expires_at) WHERE status = 'running';
-- Dead-letter listing and pruning of finished jobs.
CREATE INDEX jobs_finished_idx ON jobs (status, finished_at) WHERE status IN ('succeeded', 'dead');
-- Deduplication only applies while a job is pending or in flight.
CREATE UNIQUE INDEX jobs_dedupe_active_idx ON jobs (dedupe_key)
  WHERE dedupe_key IS NOT NULL AND status IN ('available', 'running');
