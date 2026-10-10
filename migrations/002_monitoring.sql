CREATE TABLE monitors (
  id                    bigserial PRIMARY KEY,
  name                  text        NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  url                   text        NOT NULL CHECK (length(url) <= 2048),
  interval_seconds      integer     NOT NULL DEFAULT 60 CHECK (interval_seconds BETWEEN 30 AND 86400),
  timeout_ms            integer     NOT NULL DEFAULT 10000 CHECK (timeout_ms BETWEEN 1000 AND 30000),
  failure_threshold     integer     NOT NULL DEFAULT 2 CHECK (failure_threshold BETWEEN 1 AND 10),
  cert_warn_days        integer     NOT NULL DEFAULT 14 CHECK (cert_warn_days BETWEEN 1 AND 90),
  webhook_url           text,
  enabled               boolean     NOT NULL DEFAULT true,
  status                text        NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'up', 'down')),
  consecutive_failures  integer     NOT NULL DEFAULT 0,
  last_checked_at       timestamptz,
  last_status_code      integer,
  last_response_ms      integer,
  last_error            text,
  cert_expires_at       timestamptz,
  next_check_at         timestamptz NOT NULL DEFAULT now(),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX monitors_due_idx ON monitors (next_check_at) WHERE enabled;

CREATE TABLE check_results (
  id              bigserial PRIMARY KEY,
  monitor_id      bigint      NOT NULL REFERENCES monitors (id) ON DELETE CASCADE,
  job_id          bigint,
  checked_at      timestamptz NOT NULL DEFAULT now(),
  ok              boolean     NOT NULL,
  status_code     integer,
  response_ms     integer,
  error           text,
  cert_expires_at timestamptz
);

CREATE INDEX check_results_monitor_idx ON check_results (monitor_id, checked_at DESC);
CREATE INDEX check_results_checked_at_idx ON check_results (checked_at);

CREATE TABLE incidents (
  id          bigserial PRIMARY KEY,
  monitor_id  bigint      NOT NULL REFERENCES monitors (id) ON DELETE CASCADE,
  opened_at   timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  cause       text
);

-- At most one open incident per monitor.
CREATE UNIQUE INDEX incidents_one_open_idx ON incidents (monitor_id) WHERE resolved_at IS NULL;

CREATE TABLE alerts (
  id             bigserial PRIMARY KEY,
  monitor_id     bigint      NOT NULL REFERENCES monitors (id) ON DELETE CASCADE,
  kind           text        NOT NULL CHECK (kind IN ('down', 'recovered', 'cert_expiring')),
  -- e.g. "incident:42:down" or "cert:7:2026-01-31". Guarantees an event is
  -- alerted once even if the check that detected it runs twice.
  dedupe_key     text        NOT NULL UNIQUE,
  message        text        NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  sent_at        timestamptz,
  skipped_reason text
);

CREATE INDEX alerts_monitor_idx ON alerts (monitor_id, created_at DESC);
