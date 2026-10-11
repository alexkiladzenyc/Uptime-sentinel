import type { Queryable } from '../db.js';
import type { Logger } from '../logger.js';
import { pruneSucceeded } from '../queue/queue.js';
import { CHECK_MONITOR } from './handlers.js';

/**
 * Enqueues a check for every enabled monitor that is due, and pushes each
 * monitor's next_check_at forward, in one statement.
 *
 * Safe to run from any number of processes at once: SKIP LOCKED means two
 * schedulers never pick the same monitor, and the job dedupe key means a
 * monitor never has more than one pending check even if the previous one is
 * still queued (e.g. workers are behind).
 */
export async function scheduleDueChecks(db: Queryable, limit = 500): Promise<number> {
  const { rows } = await db.query<{ id: number }>(
    `WITH due AS (
       SELECT id FROM monitors
       WHERE enabled AND next_check_at <= now()
       ORDER BY next_check_at
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     ),
     bumped AS (
       UPDATE monitors m
          SET next_check_at = now() + make_interval(secs => m.interval_seconds)
         FROM due
        WHERE m.id = due.id
       RETURNING m.id
     )
     INSERT INTO jobs (type, payload, max_attempts, dedupe_key)
     SELECT $2, jsonb_build_object('monitorId', id), 3, $2 || ':' || id FROM bumped
     ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('available', 'running')
     DO NOTHING
     RETURNING id`,
    [limit, CHECK_MONITOR],
  );
  return rows.length;
}

/** Deletes check history and finished jobs past their retention windows. */
export async function pruneOldData(
  db: Queryable,
  opts = { checkResultDays: 30, succeededJobHours: 24 },
): Promise<{ checkResults: number; jobs: number }> {
  const results = await db.query(
    `DELETE FROM check_results WHERE id IN (
       SELECT id FROM check_results
       WHERE checked_at < now() - make_interval(days => $1)
       LIMIT 5000)`,
    [opts.checkResultDays],
  );
  const jobs = await pruneSucceeded(db, opts.succeededJobHours, 5000);
  return { checkResults: results.rowCount ?? 0, jobs };
}

/** Returns a function to call periodically from worker processes. */
export function createSchedulerTick(db: Queryable, logger: Logger, pruneEveryMs = 10 * 60_000) {
  let lastPrune = 0;
  return async () => {
    const scheduled = await scheduleDueChecks(db);
    if (scheduled > 0) logger.debug({ scheduled }, 'scheduled checks');
    if (Date.now() - lastPrune >= pruneEveryMs) {
      lastPrune = Date.now();
      const pruned = await pruneOldData(db);
      if (pruned.checkResults || pruned.jobs) logger.info(pruned, 'pruned old data');
    }
  };
}
