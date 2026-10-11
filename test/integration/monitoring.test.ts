import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DiscordError, type DiscordSender } from '../../src/monitoring/discord.js';
import {
  CHECK_MONITOR,
  createMonitoringHandlers,
  type MonitoringDeps,
} from '../../src/monitoring/handlers.js';
import { pruneOldData, scheduleDueChecks } from '../../src/monitoring/scheduler.js';
import type { Resolver } from '../../src/net/safe-fetch.js';
import * as queue from '../../src/queue/queue.js';
import { Worker } from '../../src/queue/worker.js';
import { resetDatabase, testPool } from '../helpers/db.js';
import { silentLogger } from '../helpers/logger.js';

const pool = testPool();
const WEBHOOK =
  'https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz0123';
const fixtures = path.join(import.meta.dirname, '..', 'fixtures');
const cert = readFileSync(path.join(fixtures, 'localhost-cert.pem'));
const key = readFileSync(path.join(fixtures, 'localhost-key.pem'));

// The monitored "site": a local server whose status code the test controls.
let siteStatus = 200;
let site: http.Server;
let tlsSite: https.Server;
let sitePort = 0;
let tlsPort = 0;

const resolver: Resolver = async (host) => {
  if (host === 'site.test' || host === 'localhost') return [{ address: '127.0.0.1', family: 4 }];
  if (host === 'internal.test') return [{ address: '10.0.0.5', family: 4 }];
  throw new Error(`ENOTFOUND ${host}`);
};
const fetchOptions = { resolver, addressPolicy: (ip: string) => ip === '127.0.0.1', ca: cert };

let sent: string[] = [];
let discordBehaviour: 'ok' | 'fail' = 'ok';
const fakeDiscord: DiscordSender = async (_url, content) => {
  if (discordBehaviour === 'fail') throw new DiscordError('Discord responded 503', 503);
  sent.push(content);
};

let worker: Worker | undefined;
function startWorker(overrides: Partial<MonitoringDeps> = {}) {
  worker = new Worker({
    pool,
    logger: silentLogger,
    handlers: createMonitoringHandlers({
      pool,
      sendDiscord: fakeDiscord,
      fetchOptions,
      defaultWebhookUrl: WEBHOOK,
      ...overrides,
    }),
    pollIntervalMs: 25,
    reapIntervalMs: 100,
    backoff: { baseMs: 10, maxMs: 20 },
  });
  worker.start();
}

beforeEach(async () => {
  await resetDatabase(pool);
  siteStatus = 200;
  sent = [];
  discordBehaviour = 'ok';
  site = http.createServer((_req, res) => res.writeHead(siteStatus).end('hi'));
  tlsSite = https.createServer({ cert, key }, (_req, res) => res.end('secure'));
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
  await new Promise<void>((r) => tlsSite.listen(0, '127.0.0.1', r));
  sitePort = (site.address() as AddressInfo).port;
  tlsPort = (tlsSite.address() as AddressInfo).port;
});
afterEach(async () => {
  await worker?.stop(1000);
  worker = undefined;
  await new Promise((r) => site.close(r));
  await new Promise((r) => tlsSite.close(r));
});
afterAll(() => pool.end());

async function createMonitor(fields: Record<string, unknown> = {}): Promise<number> {
  const values = {
    name: 'Site',
    url: `http://site.test:${sitePort}/`,
    failure_threshold: 2,
    ...fields,
  };
  const cols = Object.keys(values);
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO monitors (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})
     RETURNING id`,
    Object.values(values),
  );
  return rows[0]!.id;
}

/**
 * Enqueues one check and waits until it, and any jobs that are due because
 * of it (alerts), have finished. Jobs waiting in backoff are not waited for.
 */
async function runCheck(monitorId: number): Promise<void> {
  const id = await queue.enqueue(pool, CHECK_MONITOR, { monitorId }, { maxAttempts: 1 });
  await waitIdle(id!);
}

async function waitIdle(jobId: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await pool.query(
      `SELECT
         (SELECT status FROM jobs WHERE id = $1) AS status,
         (SELECT count(*)::int FROM jobs WHERE status IN ('available', 'running') AND run_at <= now()) AS pending`,
      [jobId],
    );
    if (['succeeded', 'dead'].includes(rows[0].status) && rows[0].pending === 0) return;
    if (Date.now() > deadline)
      throw new Error(`job ${jobId} did not finish: ${JSON.stringify(rows[0])}`);
    await sleep(20);
  }
}

async function monitorRow(id: number) {
  return (await pool.query('SELECT * FROM monitors WHERE id = $1', [id])).rows[0];
}

describe('check_monitor', () => {
  it('records a successful check', async () => {
    startWorker();
    const id = await createMonitor();
    await runCheck(id);

    expect(await monitorRow(id)).toMatchObject({
      status: 'up',
      consecutive_failures: 0,
      last_status_code: 200,
      last_error: null,
    });
    const { rows } = await pool.query('SELECT * FROM check_results WHERE monitor_id = $1', [id]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ok: true, status_code: 200 });
    expect(sent).toEqual([]);
  });

  it('opens an incident and alerts once after the failure threshold, then alerts on recovery', async () => {
    startWorker();
    const id = await createMonitor({ failure_threshold: 2 });
    await runCheck(id); // up

    siteStatus = 503;
    await runCheck(id); // 1st failure: below threshold
    expect(await monitorRow(id)).toMatchObject({ status: 'up', consecutive_failures: 1 });
    expect(sent).toHaveLength(0);

    await runCheck(id); // 2nd failure: down
    await runCheck(id); // still down: no second alert
    expect(await monitorRow(id)).toMatchObject({ status: 'down', consecutive_failures: 3 });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('is DOWN');
    expect(sent[0]).toContain('HTTP 503');

    siteStatus = 200;
    await runCheck(id);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain('is back UP');

    const incidents = await pool.query('SELECT * FROM incidents WHERE monitor_id = $1', [id]);
    expect(incidents.rows).toHaveLength(1);
    expect(incidents.rows[0].resolved_at).toBeInstanceOf(Date);
    const alerts = await pool.query('SELECT kind, sent_at FROM alerts ORDER BY id');
    expect(alerts.rows.map((a) => a.kind)).toEqual(['down', 'recovered']);
    expect(alerts.rows.every((a) => a.sent_at instanceof Date)).toBe(true);
  });

  it('treats a URL that resolves to a private address as down (SSRF guard)', async () => {
    startWorker();
    const id = await createMonitor({ url: 'http://internal.test/', failure_threshold: 1 });
    await runCheck(id);
    const row = await monitorRow(id);
    expect(row.status).toBe('down');
    expect(row.last_error).toContain('resolves to 10.0.0.5, which is not publicly routable');
  });

  it('records the TLS expiry and warns once per certificate', async () => {
    // The fixture certificate is valid for ~100 years; a huge warning window
    // makes it count as "expiring soon".
    startWorker();
    const id = await createMonitor({ url: `https://localhost:${tlsPort}/`, cert_warn_days: 90 });
    await runCheck(id);
    const row = await monitorRow(id);
    expect(row.cert_expires_at.getUTCFullYear()).toBeGreaterThan(2100);
    expect(sent).toHaveLength(0);

    // 2126 is > 90 days away, so simulate time passing by moving "now".
    await worker!.stop(1000);
    const nearExpiry = new Date(row.cert_expires_at.getTime() - 5 * 86_400_000);
    startWorker({ now: () => nearExpiry });
    await runCheck(id);
    await runCheck(id);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/TLS certificate expires in [45] day/);
  });

  it('does nothing for a monitor deleted after the check was queued', async () => {
    startWorker();
    const id = await createMonitor();
    await pool.query('DELETE FROM monitors WHERE id = $1', [id]);
    await runCheck(id);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM check_results');
    expect(rows[0].n).toBe(0);
  });
});

describe('send_alert', () => {
  it('retries Discord failures with backoff and dead-letters after max attempts', async () => {
    discordBehaviour = 'fail';
    startWorker();
    const id = await createMonitor({ failure_threshold: 1 });
    siteStatus = 500;
    await runCheck(id);

    // The alert job is now retrying in the background; wait for it to give up.
    const deadline = Date.now() + 10_000;
    let rows;
    do {
      await sleep(20);
      ({ rows } = await pool.query(`SELECT * FROM jobs WHERE type = 'send_alert'`));
    } while (rows[0].status !== 'dead' && Date.now() < deadline);
    expect(rows[0]).toMatchObject({ status: 'dead', attempts: 8 });
    expect(rows[0].last_error).toBe('Discord responded 503');
    const alert = await pool.query('SELECT sent_at FROM alerts');
    expect(alert.rows[0].sent_at).toBeNull();

    // Operator fixes the webhook and retries the dead job from the DLQ.
    discordBehaviour = 'ok';
    expect(await queue.retryDead(pool, rows[0].id)).toBe(true);
    await waitIdle(rows[0].id);
    expect(sent).toHaveLength(1);
  });

  it('skips the alert when no webhook is configured', async () => {
    startWorker({ defaultWebhookUrl: undefined });
    const id = await createMonitor({ failure_threshold: 1 });
    siteStatus = 500;
    await runCheck(id);
    const { rows } = await pool.query('SELECT sent_at, skipped_reason FROM alerts');
    expect(rows).toEqual([{ sent_at: null, skipped_reason: 'no webhook configured' }]);
    expect(sent).toEqual([]);
  });

  it('dead-letters immediately when the webhook is not a Discord URL', async () => {
    startWorker();
    const id = await createMonitor({ failure_threshold: 1, webhook_url: 'http://10.0.0.1/hook' });
    siteStatus = 500;
    await runCheck(id);
    const { rows } = await pool.query(
      `SELECT status, attempts, last_error FROM jobs WHERE type = 'send_alert'`,
    );
    expect(rows[0]).toMatchObject({ status: 'dead', attempts: 1 });
    expect(rows[0].last_error).toContain('not a Discord webhook URL');
  });
});

describe('scheduler', () => {
  it('enqueues due monitors once and pushes next_check_at forward', async () => {
    const due = await createMonitor({ interval_seconds: 60 });
    await createMonitor({ next_check_at: new Date(Date.now() + 60_000) });
    await createMonitor({ enabled: false });

    // Concurrent schedulers (one per worker process) must not double-enqueue.
    const counts = await Promise.all([1, 2, 3, 4].map(() => scheduleDueChecks(pool)));
    expect(counts.reduce((a, b) => a + b, 0)).toBe(1);

    const { rows } = await pool.query(`SELECT payload FROM jobs WHERE type = $1`, [CHECK_MONITOR]);
    expect(rows).toEqual([{ payload: { monitorId: due } }]);
    const next = (await monitorRow(due)).next_check_at.getTime();
    expect(next).toBeGreaterThan(Date.now() + 55_000);
  });

  it('does not stack a second check while one is still pending', async () => {
    const id = await createMonitor({ interval_seconds: 30 });
    expect(await scheduleDueChecks(pool)).toBe(1);
    await pool.query(`UPDATE monitors SET next_check_at = now() - interval '1 second'`);
    expect(await scheduleDueChecks(pool)).toBe(0);
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM jobs WHERE payload->>'monitorId' = $1`,
      [String(id)],
    );
    expect(rows[0].n).toBe(1);
  });

  it('prunes old check results and succeeded jobs', async () => {
    const id = await createMonitor();
    await pool.query(
      `INSERT INTO check_results (monitor_id, ok, checked_at)
       VALUES ($1, true, now() - interval '40 days'), ($1, true, now())`,
      [id],
    );
    const pruned = await pruneOldData(pool);
    expect(pruned.checkResults).toBe(1);
  });
});
