import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import * as queue from '../../src/queue/queue.js';
import type { Job } from '../../src/queue/types.js';
import { resetDatabase, testPool } from '../helpers/db.js';

const pool = testPool();
const LEASE = 30_000;

afterAll(() => pool.end());
beforeEach(() => resetDatabase(pool));

async function getJob(id: number): Promise<Job> {
  const { rows } = await pool.query<Job>('SELECT * FROM jobs WHERE id = $1', [id]);
  return rows[0]!;
}

/** Moves a job's schedule or lease into the past so tests don't have to wait. */
async function makeDue(id: number) {
  await pool.query(`UPDATE jobs SET run_at = now() - interval '1 second' WHERE id = $1`, [id]);
}
async function expireLease(id: number) {
  await pool.query(`UPDATE jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1`, [
    id,
  ]);
}

describe('enqueue and claim', () => {
  it('claims due jobs in run_at order and issues a lease', async () => {
    const a = await queue.enqueue(pool, 'test', { n: 1 });
    const b = await queue.enqueue(pool, 'test', { n: 2 });
    const later = await queue.enqueue(pool, 'test', {}, { runAt: new Date(Date.now() + 60_000) });

    const claimed = await queue.claim(pool, 'w1', 10, LEASE);
    expect(claimed.map((j) => j.id)).toEqual([a, b]);
    expect(claimed[0]).toMatchObject({ status: 'running', attempts: 1, locked_by: 'w1' });
    expect(claimed[0]!.lease_token).toMatch(/^[0-9a-f-]{36}$/);
    expect((await getJob(later!)).status).toBe('available');
  });

  it('only claims job types the worker handles', async () => {
    await queue.enqueue(pool, 'email', {});
    const sms = await queue.enqueue(pool, 'sms', {});
    const claimed = await queue.claim(pool, 'w1', 10, LEASE, ['sms']);
    expect(claimed.map((j) => j.id)).toEqual([sms]);
  });

  it('never hands the same job to two concurrent claimers', async () => {
    for (let i = 0; i < 200; i++) await queue.enqueue(pool, 'test', { i });

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, w) => queue.claim(pool, `w${w}`, 25, LEASE)),
    );
    const ids = results.flat().map((j) => j.id);
    expect(ids).toHaveLength(200);
    expect(new Set(ids).size).toBe(200);
  });

  it('dedupes by key only while a job is active', async () => {
    const first = await queue.enqueue(pool, 'test', {}, { dedupeKey: 'k' });
    expect(first).not.toBeNull();
    expect(await queue.enqueue(pool, 'test', {}, { dedupeKey: 'k' })).toBeNull();

    const [job] = await queue.claim(pool, 'w1', 1, LEASE);
    expect(await queue.enqueue(pool, 'test', {}, { dedupeKey: 'k' })).toBeNull(); // still running

    await queue.complete(pool, job!.id, job!.lease_token);
    expect(await queue.enqueue(pool, 'test', {}, { dedupeKey: 'k' })).not.toBeNull();
  });
});

describe('complete and fail', () => {
  it('completes a job held by a valid lease', async () => {
    const id = await queue.enqueue(pool, 'test', {});
    const [job] = await queue.claim(pool, 'w1', 1, LEASE);
    expect(await queue.complete(pool, id!, job!.lease_token)).toBe(true);
    const row = await getJob(id!);
    expect(row).toMatchObject({ status: 'succeeded', lease_token: null });
    expect(row.finished_at).toBeInstanceOf(Date);
  });

  it('reschedules a failed job with backoff and records the error', async () => {
    const id = await queue.enqueue(pool, 'test', {}, { maxAttempts: 3 });
    const [job] = await queue.claim(pool, 'w1', 1, LEASE);
    const before = Date.now();
    const outcome = await queue.fail(pool, job!, 'boom', {
      backoff: { baseMs: 10_000, maxMs: 60_000 },
    });

    expect(outcome).toBe('retry');
    const row = await getJob(id!);
    expect(row).toMatchObject({ status: 'available', attempts: 1, last_error: 'boom' });
    // First retry waits between base/2 and base.
    const delay = row.run_at.getTime() - before;
    expect(delay).toBeGreaterThanOrEqual(4_000);
    expect(delay).toBeLessThanOrEqual(11_000);
    expect(await queue.claim(pool, 'w1', 1, LEASE)).toHaveLength(0); // not due yet
  });

  it('dead-letters a job after max_attempts', async () => {
    const id = await queue.enqueue(pool, 'test', {}, { maxAttempts: 2 });
    for (let attempt = 1; attempt <= 2; attempt++) {
      await makeDue(id!);
      const [job] = await queue.claim(pool, 'w1', 1, LEASE);
      expect(job!.attempts).toBe(attempt);
      const outcome = await queue.fail(pool, job!, `fail ${attempt}`);
      expect(outcome).toBe(attempt < 2 ? 'retry' : 'dead');
    }
    expect(await getJob(id!)).toMatchObject({ status: 'dead', attempts: 2, last_error: 'fail 2' });
  });

  it('dead-letters immediately on a permanent error', async () => {
    const id = await queue.enqueue(pool, 'test', {}, { maxAttempts: 5 });
    const [job] = await queue.claim(pool, 'w1', 1, LEASE);
    expect(await queue.fail(pool, job!, 'bad payload', { permanent: true })).toBe('dead');
    expect(await getJob(id!)).toMatchObject({ status: 'dead', attempts: 1 });
  });
});

describe('leases and crash recovery', () => {
  it('heartbeat extends the lease', async () => {
    await queue.enqueue(pool, 'test', {});
    const [job] = await queue.claim(pool, 'w1', 1, 1_000);
    expect(await queue.heartbeat(pool, job!.id, job!.lease_token, 60_000)).toBe(true);
    const row = await getJob(job!.id);
    expect(row.lease_expires_at!.getTime()).toBeGreaterThan(Date.now() + 50_000);
  });

  it('reaps a job whose worker died and lets another worker take it', async () => {
    const id = await queue.enqueue(pool, 'test', {}, { maxAttempts: 3 });
    const [crashed] = await queue.claim(pool, 'dead-worker', 1, LEASE);
    await expireLease(id!);

    expect(await queue.reapExpired(pool, { baseMs: 1, maxMs: 1 })).toEqual({ retried: 1, dead: 0 });
    const reaped = await getJob(id!);
    expect(reaped.status).toBe('available');
    expect(reaped.last_error).toContain('lease expired after attempt 1 (worker dead-worker');

    await makeDue(id!);
    const [takeover] = await queue.claim(pool, 'w2', 1, LEASE);
    expect(takeover).toMatchObject({ id, attempts: 2, locked_by: 'w2' });
    expect(takeover!.lease_token).not.toBe(crashed!.lease_token);
  });

  it('dead-letters a job that keeps crashing its worker (poison pill)', async () => {
    const id = await queue.enqueue(pool, 'test', {}, { maxAttempts: 2 });
    for (let i = 0; i < 2; i++) {
      await makeDue(id!);
      await queue.claim(pool, `w${i}`, 1, LEASE);
      await expireLease(id!);
      await queue.reapExpired(pool, { baseMs: 1, maxMs: 1 });
    }
    expect(await getJob(id!)).toMatchObject({ status: 'dead', attempts: 2 });
  });

  it('rejects stale workers via the fencing token', async () => {
    const id = await queue.enqueue(pool, 'test', {}, { maxAttempts: 3 });
    const [stale] = await queue.claim(pool, 'slow-worker', 1, LEASE);
    await expireLease(id!);
    await queue.reapExpired(pool, { baseMs: 1, maxMs: 1 });
    await makeDue(id!);
    const [fresh] = await queue.claim(pool, 'w2', 1, LEASE);

    // The slow worker wakes up and tries to report in: every write is refused.
    expect(await queue.heartbeat(pool, id!, stale!.lease_token, LEASE)).toBe(false);
    expect(await queue.complete(pool, id!, stale!.lease_token)).toBe(false);
    expect(await queue.fail(pool, stale!, 'late failure')).toBe('lease_lost');
    expect(await getJob(id!)).toMatchObject({ status: 'running', locked_by: 'w2' });

    expect(await queue.complete(pool, id!, fresh!.lease_token)).toBe(true);
  });

  it('does not reap jobs whose lease is still valid', async () => {
    await queue.enqueue(pool, 'test', {});
    await queue.claim(pool, 'w1', 1, LEASE);
    expect(await queue.reapExpired(pool)).toEqual({ retried: 0, dead: 0 });
  });
});

describe('completeInTransaction', () => {
  it('commits side effects and completion together', async () => {
    const id = await queue.enqueue(pool, 'test', {});
    const [job] = await queue.claim(pool, 'w1', 1, LEASE);
    const result = await queue.completeInTransaction(pool, id!, job!.lease_token, async (c) => {
      await c.query(`INSERT INTO monitors (name, url) VALUES ('m', 'https://example.com')`);
      return 'done';
    });
    expect(result).toEqual({ ok: true, value: 'done' });
    expect((await getJob(id!)).status).toBe('succeeded');
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM monitors');
    expect(rows[0].n).toBe(1);
  });

  it('rolls back side effects when the lease was lost', async () => {
    const monitor = await pool.query<{ id: number }>(
      `INSERT INTO monitors (name, url) VALUES ('m', 'https://example.com') RETURNING id`,
    );
    const id = await queue.enqueue(pool, 'test', {});
    const [stale] = await queue.claim(pool, 'w1', 1, LEASE);
    await expireLease(id!);
    await queue.reapExpired(pool, { baseMs: 1, maxMs: 1 });

    let ran = false;
    const result = await queue.completeInTransaction(pool, id!, stale!.lease_token, async (c) => {
      ran = true;
      await c.query('INSERT INTO check_results (monitor_id, ok) VALUES ($1, true)', [
        monitor.rows[0]!.id,
      ]);
    });
    expect(result).toEqual({ ok: false });
    expect(ran).toBe(false);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM check_results');
    expect(rows[0].n).toBe(0);
  });

  it('rolls back side effects when the callback throws', async () => {
    const monitor = await pool.query<{ id: number }>(
      `INSERT INTO monitors (name, url) VALUES ('m', 'https://example.com') RETURNING id`,
    );
    const id = await queue.enqueue(pool, 'test', {});
    const [job] = await queue.claim(pool, 'w1', 1, LEASE);
    await expect(
      queue.completeInTransaction(pool, id!, job!.lease_token, async (c) => {
        await c.query('INSERT INTO check_results (monitor_id, ok) VALUES ($1, true)', [
          monitor.rows[0]!.id,
        ]);
        throw new Error('handler bug');
      }),
    ).rejects.toThrow('handler bug');
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM check_results');
    expect(rows[0].n).toBe(0);
    expect((await getJob(id!)).status).toBe('running');
  });
});

describe('dead-letter management and stats', () => {
  it('retries a dead job with a fresh attempt budget', async () => {
    const id = await queue.enqueue(pool, 'test', {}, { maxAttempts: 1 });
    const [job] = await queue.claim(pool, 'w1', 1, LEASE);
    await queue.fail(pool, job!, 'boom');
    expect(await queue.retryDead(pool, id!)).toBe(true);
    expect(await getJob(id!)).toMatchObject({
      status: 'available',
      attempts: 0,
      finished_at: null,
    });
    expect(await queue.retryDead(pool, id!)).toBe(false); // no longer dead
  });

  it('refuses to retry a dead job when an equivalent one is already queued', async () => {
    const id = await queue.enqueue(pool, 'test', {}, { maxAttempts: 1, dedupeKey: 'k' });
    const [job] = await queue.claim(pool, 'w1', 1, LEASE);
    await queue.fail(pool, job!, 'boom');
    await queue.enqueue(pool, 'test', {}, { dedupeKey: 'k' });
    expect(await queue.retryDead(pool, id!)).toBe(false);
  });

  it('reports counts by status and lists jobs', async () => {
    await queue.enqueue(pool, 'a', {});
    await queue.enqueue(pool, 'b', {}, { maxAttempts: 1 });
    const [job] = await queue.claim(pool, 'w1', 1, LEASE, ['b']);
    await queue.fail(pool, job!, 'nope');

    const s = await queue.stats(pool);
    expect(s.byStatus).toEqual({ available: 1, running: 0, succeeded: 0, dead: 1 });
    expect(s.oldestAvailableAgeSeconds).toBeGreaterThanOrEqual(0);
    const dead = await queue.listJobs(pool, 'dead');
    expect(dead.map((j) => j.type)).toEqual(['b']);
  });

  it('prunes old succeeded jobs only', async () => {
    const id = await queue.enqueue(pool, 'test', {});
    const [job] = await queue.claim(pool, 'w1', 1, LEASE);
    await queue.complete(pool, id!, job!.lease_token);
    expect(await queue.pruneSucceeded(pool, 24)).toBe(0);
    await pool.query(`UPDATE jobs SET finished_at = now() - interval '2 days'`);
    expect(await queue.pruneSucceeded(pool, 24)).toBe(1);
  });
});
