import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as queue from '../../src/queue/queue.js';
import { PermanentJobError, type Job, type JobHandler } from '../../src/queue/types.js';
import { Worker, type WorkerOptions } from '../../src/queue/worker.js';
import { resetDatabase, testPool } from '../helpers/db.js';
import { silentLogger } from '../helpers/logger.js';

const pool = testPool();
let workers: Worker[] = [];

afterAll(() => pool.end());
beforeEach(() => resetDatabase(pool));
afterEach(async () => {
  await Promise.all(workers.map((w) => w.stop(1000)));
  workers = [];
});

function startWorker(
  handlers: Record<string, JobHandler<never>>,
  opts: Partial<WorkerOptions> = {},
) {
  const worker = new Worker({
    pool,
    handlers,
    logger: silentLogger,
    pollIntervalMs: 50,
    reapIntervalMs: 100,
    leaseMs: 2_000,
    backoff: { baseMs: 20, maxMs: 50 },
    ...opts,
  });
  worker.start();
  workers.push(worker);
  return worker;
}

async function waitFor<T>(fn: () => Promise<T | undefined>, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await sleep(25);
  }
}

async function jobWhen(id: number, predicate: (j: Job) => boolean): Promise<Job> {
  return waitFor(async () => {
    const { rows } = await pool.query<Job>('SELECT * FROM jobs WHERE id = $1', [id]);
    return rows[0] && predicate(rows[0]) ? rows[0] : undefined;
  });
}

describe('Worker', () => {
  it('runs handlers and marks jobs succeeded', async () => {
    const seen: unknown[] = [];
    startWorker({ greet: async (job) => void seen.push(job.payload) });
    const id = await queue.enqueue(pool, 'greet', { name: 'ada' });
    await jobWhen(id!, (j) => j.status === 'succeeded');
    expect(seen).toEqual([{ name: 'ada' }]);
  });

  it('retries failures with backoff, then succeeds', async () => {
    let calls = 0;
    startWorker({
      flaky: async () => {
        calls++;
        if (calls < 3) throw new Error(`transient ${calls}`);
      },
    });
    const id = await queue.enqueue(pool, 'flaky', {}, { maxAttempts: 5 });
    const job = await jobWhen(id!, (j) => j.status === 'succeeded');
    expect(job.attempts).toBe(3);
    expect(calls).toBe(3);
  });

  it('dead-letters after max attempts', async () => {
    startWorker({ broken: async () => Promise.reject(new Error('always fails')) });
    const id = await queue.enqueue(pool, 'broken', {}, { maxAttempts: 3 });
    const job = await jobWhen(id!, (j) => j.status === 'dead');
    expect(job).toMatchObject({ attempts: 3, last_error: 'always fails' });
  });

  it('dead-letters immediately on PermanentJobError', async () => {
    startWorker({
      invalid: async () => {
        throw new PermanentJobError('payload is invalid');
      },
    });
    const id = await queue.enqueue(pool, 'invalid', {}, { maxAttempts: 5 });
    expect(await jobWhen(id!, (j) => j.status === 'dead')).toMatchObject({ attempts: 1 });
  });

  it('times out a handler that ignores its abort signal', async () => {
    startWorker({ hang: () => new Promise(() => {}) }, { jobTimeoutMs: 200 });
    const id = await queue.enqueue(pool, 'hang', {}, { maxAttempts: 1 });
    const job = await jobWhen(id!, (j) => j.status === 'dead');
    expect(job.last_error).toBe('job timed out after 200ms');
  });

  it('keeps long jobs alive with heartbeats', async () => {
    startWorker({ slow: () => sleep(1_500) }, { leaseMs: 500 }); // job outlives 3 leases
    const id = await queue.enqueue(pool, 'slow', {}, { maxAttempts: 1 });
    const job = await jobWhen(id!, (j) => j.status === 'succeeded');
    expect(job.attempts).toBe(1); // never reaped and re-run
  });

  it('respects the concurrency limit', async () => {
    let active = 0;
    let peak = 0;
    startWorker(
      {
        work: async () => {
          peak = Math.max(peak, ++active);
          await sleep(50);
          active--;
        },
      },
      { concurrency: 3 },
    );
    const ids = [];
    for (let i = 0; i < 12; i++) ids.push(await queue.enqueue(pool, 'work', { i }));
    for (const id of ids) await jobWhen(id!, (j) => j.status === 'succeeded');
    expect(peak).toBe(3);
  });

  it('commits completeWith effects exactly once', async () => {
    const monitor = await pool.query<{ id: number }>(
      `INSERT INTO monitors (name, url) VALUES ('m', 'https://example.com') RETURNING id`,
    );
    startWorker({
      record: async (_job, ctx) => {
        await ctx.completeWith((c) =>
          c.query('INSERT INTO check_results (monitor_id, ok) VALUES ($1, true)', [
            monitor.rows[0]!.id,
          ]),
        );
      },
    });
    const id = await queue.enqueue(pool, 'record', {});
    await jobWhen(id!, (j) => j.status === 'succeeded');
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM check_results');
    expect(rows[0].n).toBe(1);
  });

  it('dead-letters jobs of unknown types it was asked to run', async () => {
    // Workers only claim types in their handler map, so register the type
    // with no function behind it to simulate a misconfigured deployment.
    const id = await queue.enqueue(pool, 'mystery', {});
    const handlers = { mystery: undefined } as unknown as Record<string, JobHandler<never>>;
    startWorker(handlers);
    const job = await jobWhen(id!, (j) => j.status === 'dead');
    expect(job.last_error).toContain('no handler registered');
  });

  it('finishes in-flight jobs on graceful stop and claims nothing new', async () => {
    let finished = 0;
    const worker = startWorker({
      slow: async () => {
        await sleep(300);
        finished++;
      },
    });
    const first = await queue.enqueue(pool, 'slow', {});
    await jobWhen(first!, (j) => j.status === 'running');
    const stopping = worker.stop(5_000);
    const second = await queue.enqueue(pool, 'slow', {});
    await stopping;

    expect(finished).toBe(1);
    expect((await jobWhen(first!, () => true)).status).toBe('succeeded');
    expect((await jobWhen(second!, () => true)).status).toBe('available');
  });
});
