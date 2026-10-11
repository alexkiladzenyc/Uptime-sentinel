/**
 * Chaos test: several worker processes drain a known set of jobs while the
 * test repeatedly SIGKILLs random workers (no graceful shutdown, no cleanup)
 * and starts replacements.
 *
 * Invariants checked at the end:
 *   1. No job is lost or stuck: every job is `succeeded` or `dead`.
 *   2. Every non-poison job succeeded; every poison job is dead with its
 *      attempts used up.
 *   3. Each succeeded job's side effect was committed exactly once, even
 *      though some jobs were started more than once (at-least-once
 *      execution + transactional completion = effectively-once effects).
 *   4. The chaos was real: workers were killed while holding running jobs,
 *      and those jobs were re-run by other workers.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, expect, it } from 'vitest';
import * as queue from '../../src/queue/queue.js';
import { TEST_DATABASE_URL, testPool } from '../helpers/db.js';

const JOBS = Number(process.env.CHAOS_JOBS ?? 400);
const WORKERS = Number(process.env.CHAOS_WORKERS ?? 4);
const CHAOS_DURATION_MS = Number(process.env.CHAOS_DURATION_MS ?? 20_000);
const DRAIN_TIMEOUT_MS = 60_000;

const pool = testPool();
const workerScript = path.join(import.meta.dirname, 'chaos-worker.ts');
const alive = new Map<string, ChildProcess>();
let spawned = 0;

function startWorker(): Promise<void> {
  const id = `chaos-worker-${++spawned}`;
  const child = spawn(process.execPath, ['--import', 'tsx', workerScript], {
    env: { ...process.env, TEST_DATABASE_URL, WORKER_ID: id },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  alive.set(id, child);
  child.once('exit', () => alive.delete(id));
  return new Promise((resolve, reject) => {
    child.stdout!.once('data', () => resolve());
    child.once('error', reject);
  });
}

beforeAll(async () => {
  await pool.query(`
    TRUNCATE jobs RESTART IDENTITY;
    DROP TABLE IF EXISTS chaos_attempts, chaos_effects;
    CREATE TABLE chaos_attempts (job_id bigint NOT NULL, worker_id text NOT NULL);
    -- Deliberately no unique constraint: a duplicate effect must be visible.
    CREATE TABLE chaos_effects (job_id bigint NOT NULL, worker_id text NOT NULL);
  `);
});

afterAll(async () => {
  for (const child of alive.values()) child.kill('SIGKILL');
  await pool.end();
});

it(`loses no jobs while workers are repeatedly SIGKILLed`, async () => {
  // 1. A known workload: 85% ok, 10% flaky, 5% poison, 50-300ms each.
  //    Being killed mid-run costs a job an attempt, so non-poison jobs get a
  //    generous budget; poison jobs get 3.
  const modes: Record<number, string> = {};
  for (let i = 0; i < JOBS; i++) {
    const r = i % 20;
    const mode = r === 0 ? 'poison' : r <= 2 ? 'flaky' : 'ok';
    const durationMs = 50 + Math.floor(Math.random() * 250);
    const id = await queue.enqueue(
      pool,
      'chaos',
      { mode, durationMs },
      {
        maxAttempts: mode === 'poison' ? 3 : 25,
      },
    );
    modes[id!] = mode;
  }

  await Promise.all(Array.from({ length: WORKERS }, startWorker));

  // 2. Chaos phase: SIGKILL a random worker every 150-400ms, replace it.
  let kills = 0;
  let killsWithRunningJobs = 0;
  const chaosEnds = Date.now() + CHAOS_DURATION_MS;
  while (Date.now() < chaosEnds) {
    await sleep(150 + Math.random() * 250);
    const unfinished = await countUnfinished();
    if (unfinished === 0) break;

    const ids = [...alive.keys()];
    const victim = ids[Math.floor(Math.random() * ids.length)]!;
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM jobs WHERE status = 'running' AND locked_by = $1`,
      [victim],
    );
    alive.get(victim)!.kill('SIGKILL');
    kills++;
    if (rows[0].n > 0) killsWithRunningJobs++;
    await startWorker();
  }

  // 3. Drain phase: no more kills; leases of the last victims expire and
  //    their jobs are reaped and finished by the survivors.
  const drainDeadline = Date.now() + DRAIN_TIMEOUT_MS;
  while ((await countUnfinished()) > 0 && Date.now() < drainDeadline) await sleep(200);

  // 4. Check the invariants.
  const { rows: jobs } = await pool.query<{
    id: number;
    status: string;
    attempts: number;
    max_attempts: number;
  }>('SELECT id, status, attempts, max_attempts FROM jobs ORDER BY id');
  const { rows: effects } = await pool.query<{ job_id: number; n: number }>(
    'SELECT job_id, count(*)::int AS n FROM chaos_effects GROUP BY job_id',
  );
  const { rows: starts } = await pool.query<{ job_id: number; n: number }>(
    'SELECT job_id, count(*)::int AS n FROM chaos_attempts GROUP BY job_id',
  );
  const effectsByJob = new Map(effects.map((e) => [Number(e.job_id), e.n]));
  const startsByJob = new Map(starts.map((s) => [Number(s.job_id), s.n]));

  const byStatus = (s: string) => jobs.filter((j) => j.status === s);
  const okJobsRerunAfterCrash = jobs.filter(
    (j) => modes[j.id] === 'ok' && (startsByJob.get(j.id) ?? 0) > 1,
  ).length;

  const summary = {
    jobs: jobs.length,
    workersSpawned: spawned,
    kills,
    killsWithRunningJobs,
    succeeded: byStatus('succeeded').length,
    dead: byStatus('dead').length,
    unfinished: jobs.length - byStatus('succeeded').length - byStatus('dead').length,
    totalStarts: starts.reduce((a, s) => a + s.n, 0),
    okJobsRerunAfterCrash,
    duplicateEffects: effects.filter((e) => e.n > 1).length,
  };
  console.log('chaos summary', JSON.stringify(summary));

  expect(jobs).toHaveLength(JOBS);
  // (1) nothing lost or stuck
  expect(summary.unfinished).toBe(0);
  for (const job of jobs) {
    if (modes[job.id] === 'poison') {
      // (2) poison jobs dead-lettered with attempts exhausted
      expect(job).toMatchObject({ status: 'dead', attempts: job.max_attempts });
      expect(effectsByJob.get(job.id) ?? 0).toBe(0);
    } else {
      // (2) everything else succeeded; (3) its effect committed exactly once
      expect(job.status).toBe('succeeded');
      expect(effectsByJob.get(job.id)).toBe(1);
    }
  }
  expect(summary.duplicateEffects).toBe(0);
  // (4) the test actually exercised crash recovery
  expect(killsWithRunningJobs).toBeGreaterThan(0);
  expect(okJobsRerunAfterCrash).toBeGreaterThan(0);
});

async function countUnfinished(): Promise<number> {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM jobs WHERE status IN ('available', 'running')`,
  );
  return rows[0].n;
}
