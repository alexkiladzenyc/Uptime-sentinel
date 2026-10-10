import type { Pool, PoolClient, Queryable } from '../db.js';
import { backoffDelayMs, DEFAULT_BACKOFF, type BackoffOptions } from './backoff.js';
import type { ClaimedJob, EnqueueOptions, Job, JobStatus } from './types.js';

const MAX_ERROR_LENGTH = 2000;

function truncate(message: string): string {
  return message.length > MAX_ERROR_LENGTH ? `${message.slice(0, MAX_ERROR_LENGTH)}…` : message;
}

/**
 * Inserts a job. Pass a transaction client to enqueue atomically with other
 * writes (the transactional-outbox pattern). Returns null when `dedupeKey`
 * matched an active job.
 */
export async function enqueue(
  db: Queryable,
  type: string,
  payload: unknown,
  opts: EnqueueOptions = {},
): Promise<number | null> {
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO jobs (type, payload, max_attempts, run_at, dedupe_key)
     VALUES ($1, $2, $3, COALESCE($4, now()), $5)
     ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('available', 'running')
     DO NOTHING
     RETURNING id`,
    [
      type,
      JSON.stringify(payload ?? {}),
      opts.maxAttempts ?? 5,
      opts.runAt ?? null,
      opts.dedupeKey ?? null,
    ],
  );
  return rows[0]?.id ?? null;
}

/**
 * Atomically claims up to `limit` due jobs. `SKIP LOCKED` lets many workers
 * poll concurrently without blocking each other or claiming the same row.
 * Each claim increments `attempts` and issues a new lease token.
 */
export async function claim(
  db: Queryable,
  workerId: string,
  limit: number,
  leaseMs: number,
  types?: readonly string[],
): Promise<ClaimedJob[]> {
  const { rows } = await db.query<ClaimedJob>(
    `WITH next AS (
       SELECT id FROM jobs
       WHERE status = 'available' AND run_at <= now()
         AND ($4::text[] IS NULL OR type = ANY($4))
       ORDER BY run_at, id
       LIMIT $2
       FOR UPDATE SKIP LOCKED
     )
     UPDATE jobs j
        SET status = 'running',
            attempts = j.attempts + 1,
            lease_token = gen_random_uuid(),
            lease_expires_at = now() + make_interval(secs => $3 / 1000.0),
            locked_by = $1,
            updated_at = now()
       FROM next
      WHERE j.id = next.id
     RETURNING j.*`,
    [workerId, limit, leaseMs, types ?? null],
  );
  return rows;
}

/** Extends a lease. Returns false if the worker no longer owns the job. */
export async function heartbeat(
  db: Queryable,
  jobId: number,
  leaseToken: string,
  leaseMs: number,
): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE jobs
        SET lease_expires_at = now() + make_interval(secs => $3 / 1000.0), updated_at = now()
      WHERE id = $1 AND lease_token = $2 AND status = 'running'`,
    [jobId, leaseToken, leaseMs],
  );
  return rowCount === 1;
}

/** Marks a job succeeded. Returns false if the lease was lost first. */
export async function complete(db: Queryable, jobId: number, leaseToken: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE jobs
        SET status = 'succeeded', finished_at = now(), updated_at = now(),
            lease_token = NULL, lease_expires_at = NULL, last_error = NULL
      WHERE id = $1 AND lease_token = $2 AND status = 'running'`,
    [jobId, leaseToken],
  );
  return rowCount === 1;
}

export type FailOutcome = 'retry' | 'dead' | 'lease_lost';

/**
 * Records a failed attempt. The job is rescheduled with backoff, or moved to
 * the dead-letter queue when it is out of attempts or `permanent` is set.
 */
export async function fail(
  db: Queryable,
  job: Pick<ClaimedJob, 'id' | 'lease_token' | 'attempts'>,
  error: string,
  opts: { permanent?: boolean; backoff?: BackoffOptions } = {},
): Promise<FailOutcome> {
  const delayMs = backoffDelayMs(job.attempts, opts.backoff ?? DEFAULT_BACKOFF);
  const { rows } = await db.query<{ status: JobStatus }>(
    `UPDATE jobs
        SET status      = CASE WHEN $4 OR attempts >= max_attempts THEN 'dead' ELSE 'available' END,
            run_at      = CASE WHEN $4 OR attempts >= max_attempts THEN run_at
                               ELSE now() + make_interval(secs => $5 / 1000.0) END,
            finished_at = CASE WHEN $4 OR attempts >= max_attempts THEN now() END,
            last_error = $3, lease_token = NULL, lease_expires_at = NULL, updated_at = now()
      WHERE id = $1 AND lease_token = $2 AND status = 'running'
      RETURNING status`,
    [job.id, job.lease_token, truncate(error), opts.permanent ?? false, delayMs],
  );
  const row = rows[0];
  if (!row) return 'lease_lost';
  return row.status === 'dead' ? 'dead' : 'retry';
}

/**
 * Recovers jobs whose worker died or stalled: any running job past its lease
 * goes back to `available` (after a backoff), or to `dead` if that was its
 * last attempt. Safe to run from every worker concurrently.
 */
export async function reapExpired(
  db: Queryable,
  backoff: BackoffOptions = DEFAULT_BACKOFF,
  limit = 100,
): Promise<{ retried: number; dead: number }> {
  const { rows } = await db.query<{ status: JobStatus }>(
    `WITH expired AS (
       SELECT id FROM jobs
       WHERE status = 'running' AND lease_expires_at < now()
       ORDER BY lease_expires_at
       LIMIT $3
       FOR UPDATE SKIP LOCKED
     )
     UPDATE jobs j
        SET status      = CASE WHEN j.attempts >= j.max_attempts THEN 'dead' ELSE 'available' END,
            run_at      = now() + make_interval(secs => LEAST(
                            $2::float8,
                            $1::float8 * power(2, LEAST(GREATEST(j.attempts - 1, 0), 30))
                          ) * (0.5 + random() * 0.5) / 1000.0),
            finished_at = CASE WHEN j.attempts >= j.max_attempts THEN now() END,
            last_error  = format('lease expired after attempt %s (worker %s crashed or stalled)',
                                 j.attempts, j.locked_by),
            lease_token = NULL, lease_expires_at = NULL, updated_at = now()
       FROM expired
      WHERE j.id = expired.id
     RETURNING j.status`,
    [backoff.baseMs, backoff.maxMs, limit],
  );
  const dead = rows.filter((r) => r.status === 'dead').length;
  return { retried: rows.length - dead, dead };
}

/**
 * Moves a dead-lettered job back to the queue with a fresh attempt budget.
 * Returns false if the job is not dead (or if an equivalent job, by dedupe
 * key, is already active).
 */
export async function retryDead(db: Queryable, jobId: number): Promise<boolean> {
  try {
    const { rowCount } = await db.query(
      `UPDATE jobs
          SET status = 'available', attempts = 0, run_at = now(), finished_at = NULL, updated_at = now()
        WHERE id = $1 AND status = 'dead'`,
      [jobId],
    );
    return rowCount === 1;
  } catch (err) {
    if ((err as { code?: string }).code === '23505') return false; // dedupe_key unique violation
    throw err;
  }
}

/**
 * Runs `fn` and marks the job succeeded in the same transaction. Rolls back
 * and throws if the lease token no longer matches.
 */
export async function completeInTransaction<T>(
  pool: Pool,
  jobId: number,
  leaseToken: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Lock the job row first: if a reaper is concurrently expiring this lease,
    // one of us waits for the other instead of both committing.
    const { rowCount } = await client.query(
      `SELECT 1 FROM jobs WHERE id = $1 AND lease_token = $2 AND status = 'running' FOR UPDATE`,
      [jobId, leaseToken],
    );
    if (rowCount !== 1) {
      await client.query('ROLLBACK');
      return { ok: false };
    }
    const value = await fn(client);
    await complete(client, jobId, leaseToken);
    await client.query('COMMIT');
    return { ok: true, value };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export interface QueueStats {
  byStatus: Record<JobStatus, number>;
  byType: { type: string; status: JobStatus; count: number }[];
  oldestAvailableAgeSeconds: number | null;
}

export async function stats(db: Queryable): Promise<QueueStats> {
  const [byType, oldest] = await Promise.all([
    db.query<{ type: string; status: JobStatus; count: number }>(
      `SELECT type, status, count(*)::int AS count FROM jobs GROUP BY type, status ORDER BY type, status`,
    ),
    db.query<{ age: number | null }>(
      `SELECT extract(epoch FROM now() - min(run_at))::float8 AS age
         FROM jobs WHERE status = 'available' AND run_at <= now()`,
    ),
  ]);
  const byStatus: Record<JobStatus, number> = { available: 0, running: 0, succeeded: 0, dead: 0 };
  for (const row of byType.rows) byStatus[row.status] += row.count;
  return {
    byStatus,
    byType: byType.rows,
    oldestAvailableAgeSeconds: oldest.rows[0]?.age ?? null,
  };
}

export async function listJobs(db: Queryable, status: JobStatus, limit = 50): Promise<Job[]> {
  const order = status === 'available' ? 'run_at ASC' : 'updated_at DESC';
  const { rows } = await db.query<Job>(
    `SELECT * FROM jobs WHERE status = $1 ORDER BY ${order}, id DESC LIMIT $2`,
    [status, limit],
  );
  return rows;
}

/** Deletes succeeded jobs older than the retention window, in bounded batches. */
export async function pruneSucceeded(db: Queryable, olderThanHours: number, batch = 1000) {
  const { rowCount } = await db.query(
    `DELETE FROM jobs WHERE id IN (
       SELECT id FROM jobs
       WHERE status = 'succeeded' AND finished_at < now() - make_interval(hours => $1)
       LIMIT $2)`,
    [olderThanHours, batch],
  );
  return rowCount ?? 0;
}
