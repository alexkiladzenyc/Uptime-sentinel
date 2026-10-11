/**
 * A worker process for the chaos test. It runs the real Worker class against
 * the test database with a short lease, so crashes are detected quickly.
 *
 * Job modes:
 *   ok     - sleeps, then commits one row to chaos_effects with completeWith
 *   flaky  - throws on its first attempt, then behaves like ok
 *   poison - always throws; must end up in the dead-letter queue
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { pino } from 'pino';
import { createPool } from '../../src/db.js';
import type { JobHandler } from '../../src/queue/types.js';
import { Worker } from '../../src/queue/worker.js';

interface ChaosPayload {
  mode: 'ok' | 'flaky' | 'poison';
  durationMs: number;
}

const workerId = process.env.WORKER_ID ?? `chaos-${process.pid}`;
const pool = createPool(process.env.TEST_DATABASE_URL!, 8);

const chaos: JobHandler<ChaosPayload> = async (job, ctx) => {
  // Logged outside the job's transaction, so it survives a crash: it counts
  // every time any worker *started* this job.
  await pool.query('INSERT INTO chaos_attempts (job_id, worker_id) VALUES ($1, $2)', [
    job.id,
    workerId,
  ]);
  await sleep(job.payload.durationMs, undefined, { signal: ctx.signal });

  if (job.payload.mode === 'poison') throw new Error('poison job always fails');
  if (job.payload.mode === 'flaky' && job.attempts === 1) throw new Error('flaky first attempt');

  // The side effect and the completion commit together, or not at all.
  await ctx.completeWith((client) =>
    client.query('INSERT INTO chaos_effects (job_id, worker_id) VALUES ($1, $2)', [
      job.id,
      workerId,
    ]),
  );
};

const worker = new Worker({
  pool,
  workerId,
  logger: pino({ level: process.env.CHAOS_LOG_LEVEL ?? 'silent' }),
  handlers: { chaos: chaos as JobHandler<never> },
  concurrency: 4,
  leaseMs: 1_000,
  pollIntervalMs: 50,
  reapIntervalMs: 200,
  jobTimeoutMs: 10_000,
  backoff: { baseMs: 50, maxMs: 200 },
});

process.once('SIGTERM', async () => {
  await worker.stop(5_000);
  await pool.end();
  process.exit(0);
});

worker.start();
process.stdout.write('ready\n');
