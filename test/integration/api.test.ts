import type { FastifyInstance } from 'fastify';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/api/app.js';
import type { Resolver } from '../../src/net/safe-fetch.js';
import * as queue from '../../src/queue/queue.js';
import { resetDatabase, testPool } from '../helpers/db.js';

const pool = testPool();
const WEBHOOK =
  'https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz0123';

const resolver: Resolver = async (host) => {
  const table: Record<string, string[]> = {
    'example.com': ['93.184.215.14'],
    'localhost.example': ['127.0.0.1'],
    'rebind.example': ['93.184.215.14', '169.254.169.254'],
  };
  const ips = table[host];
  if (!ips) throw new Error(`getaddrinfo ENOTFOUND ${host}`);
  return ips.map((address) => ({ address, family: 4 as const }));
};

let app: FastifyInstance;
beforeAll(async () => {
  app = await buildApp({ pool, resolver, maxMonitors: 3 });
});
afterAll(async () => {
  await app.close();
  await pool.end();
});
beforeEach(() => resetDatabase(pool));

async function create(body: Record<string, unknown>) {
  return app.inject({ method: 'POST', url: '/api/monitors', payload: body });
}

describe('monitors API', () => {
  it('creates a monitor with defaults and lists it', async () => {
    const res = await create({ name: 'Example', url: 'https://example.com/health' });
    expect(res.statusCode).toBe(201);
    expect(res.json().monitor).toMatchObject({
      name: 'Example',
      url: 'https://example.com/health',
      intervalSeconds: 60,
      timeoutMs: 10_000,
      failureThreshold: 2,
      certWarnDays: 14,
      hasWebhook: false,
      status: 'pending',
      enabled: true,
    });

    const list = await app.inject({ method: 'GET', url: '/api/monitors' });
    expect(list.json().monitors).toHaveLength(1);
  });

  it.each([
    [{ url: 'https://example.com' }, /name/],
    [{ name: 'x', url: 'ftp://example.com/' }, /scheme "ftp" is not allowed/],
    [{ name: 'x', url: 'http://127.0.0.1:5432/' }, /127\.0\.0\.1 is not publicly routable/],
    [{ name: 'x', url: 'http://169.254.169.254/latest/' }, /not publicly routable/],
    [{ name: 'x', url: 'http://localhost.example/' }, /resolves to 127\.0\.0\.1/],
    [{ name: 'x', url: 'http://rebind.example/' }, /resolves to 169\.254\.169\.254/],
    [{ name: 'x', url: 'http://unknown.example/' }, /could not resolve host/],
    [{ name: 'x', url: 'https://example.com', intervalSeconds: 5 }, /intervalSeconds/],
    [{ name: 'x', url: 'https://example.com', webhookUrl: 'http://10.0.0.1/' }, /Discord webhook/],
  ])('rejects invalid input %j', async (body, message) => {
    const res = await create(body);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(message);
  });

  it('never returns the webhook URL, which contains a secret token', async () => {
    const res = await create({ name: 'x', url: 'https://example.com', webhookUrl: WEBHOOK });
    expect(res.json().monitor.hasWebhook).toBe(true);
    expect(res.body).not.toContain('abcdefghijklmnopqrstuvwxyz0123');
  });

  it('enforces the monitor limit', async () => {
    for (let i = 0; i < 3; i++)
      expect((await create({ name: `m${i}`, url: 'https://example.com' })).statusCode).toBe(201);
    const res = await create({ name: 'one too many', url: 'https://example.com' });
    expect(res.statusCode).toBe(409);
  });

  it('returns monitor details with recent checks and incidents', async () => {
    const { monitor } = (await create({ name: 'x', url: 'https://example.com' })).json();
    await pool.query(
      `INSERT INTO check_results (monitor_id, ok, status_code, response_ms) VALUES ($1, true, 200, 87)`,
      [monitor.id],
    );
    const res = await app.inject({ method: 'GET', url: `/api/monitors/${monitor.id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().checks).toEqual([
      expect.objectContaining({ ok: true, statusCode: 200, responseMs: 87 }),
    ]);
    expect(res.json().incidents).toEqual([]);
  });

  it('updates fields and resets state when the URL changes', async () => {
    const { monitor } = (await create({ name: 'x', url: 'https://example.com' })).json();
    await pool.query(
      `UPDATE monitors SET status = 'down', consecutive_failures = 4 WHERE id = $1`,
      [monitor.id],
    );

    const renamed = await app.inject({
      method: 'PATCH',
      url: `/api/monitors/${monitor.id}`,
      payload: { name: 'renamed', enabled: false },
    });
    expect(renamed.json().monitor).toMatchObject({
      name: 'renamed',
      enabled: false,
      status: 'down',
    });

    const moved = await app.inject({
      method: 'PATCH',
      url: `/api/monitors/${monitor.id}`,
      payload: { url: 'https://example.com/v2' },
    });
    expect(moved.json().monitor).toMatchObject({ status: 'pending', consecutiveFailures: 0 });

    const blocked = await app.inject({
      method: 'PATCH',
      url: `/api/monitors/${monitor.id}`,
      payload: { url: 'http://[::1]/' },
    });
    expect(blocked.statusCode).toBe(400);
  });

  it('deletes monitors and 404s on unknown ids', async () => {
    const { monitor } = (await create({ name: 'x', url: 'https://example.com' })).json();
    expect(
      (await app.inject({ method: 'DELETE', url: `/api/monitors/${monitor.id}` })).statusCode,
    ).toBe(204);
    expect(
      (await app.inject({ method: 'GET', url: `/api/monitors/${monitor.id}` })).statusCode,
    ).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/monitors/abc' })).statusCode).toBe(400);
  });

  it('queues a manual check once even if clicked repeatedly', async () => {
    const { monitor } = (await create({ name: 'x', url: 'https://example.com' })).json();
    const first = await app.inject({ method: 'POST', url: `/api/monitors/${monitor.id}/check` });
    const second = await app.inject({ method: 'POST', url: `/api/monitors/${monitor.id}/check` });
    expect(first.json()).toMatchObject({ alreadyQueued: false });
    expect(second.json()).toEqual({ jobId: null, alreadyQueued: true });
  });
});

describe('queue API', () => {
  it('reports stats, lists dead jobs, and retries or deletes them', async () => {
    const jobId = await queue.enqueue(pool, 'send_alert', { alertId: 1 }, { maxAttempts: 1 });
    const [job] = await queue.claim(pool, 'w1', 1, 30_000);
    await queue.fail(pool, job!, 'Discord responded 503');

    const stats = await app.inject({ method: 'GET', url: '/api/queue/stats' });
    expect(stats.json().byStatus).toMatchObject({ dead: 1, available: 0 });

    const dead = await app.inject({ method: 'GET', url: '/api/queue/jobs?status=dead' });
    expect(dead.json().jobs).toEqual([
      expect.objectContaining({ id: jobId, lastError: 'Discord responded 503', attempts: 1 }),
    ]);

    const retry = await app.inject({ method: 'POST', url: `/api/queue/jobs/${jobId}/retry` });
    expect(retry.statusCode).toBe(200);
    const again = await app.inject({ method: 'POST', url: `/api/queue/jobs/${jobId}/retry` });
    expect(again.statusCode).toBe(409);

    const [job2] = await queue.claim(pool, 'w1', 1, 30_000);
    await queue.fail(pool, job2!, 'still broken', { permanent: true });
    const del = await app.inject({ method: 'DELETE', url: `/api/queue/jobs/${jobId}` });
    expect(del.statusCode).toBe(204);
  });

  it('validates the status filter', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/queue/jobs?status=bogus' });
    expect(res.statusCode).toBe(400);
  });
});

describe('app shell', () => {
  it('reports health', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.json()).toEqual({ ok: true });
  });

  it('protects everything but /api/health with basic auth when configured', async () => {
    const secured = await buildApp({
      pool,
      resolver,
      basicAuth: { user: 'admin', password: 's3cret' },
    });
    try {
      expect((await secured.inject({ url: '/api/monitors' })).statusCode).toBe(401);
      const wrong = Buffer.from('admin:nope').toString('base64');
      expect(
        (
          await secured.inject({
            url: '/api/monitors',
            headers: { authorization: `Basic ${wrong}` },
          })
        ).statusCode,
      ).toBe(401);
      const right = Buffer.from('admin:s3cret').toString('base64');
      expect(
        (
          await secured.inject({
            url: '/api/monitors',
            headers: { authorization: `Basic ${right}` },
          })
        ).statusCode,
      ).toBe(200);
      expect((await secured.inject({ url: '/api/health' })).statusCode).toBe(200);
    } finally {
      await secured.close();
    }
  });

  it('serves the web app with client-side routing fallback', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'web-'));
    writeFileSync(path.join(dir, 'index.html'), '<html>spa</html>');
    const withWeb = await buildApp({ pool, resolver, webDistDir: dir });
    try {
      expect((await withWeb.inject({ url: '/' })).body).toBe('<html>spa</html>');
      expect((await withWeb.inject({ url: '/monitors/12' })).body).toBe('<html>spa</html>');
      const missingAsset = await withWeb.inject({ url: '/assets/old-bundle.js' });
      expect(missingAsset.statusCode).toBe(404);
      const missingApi = await withWeb.inject({ url: '/api/nope' });
      expect(missingApi.statusCode).toBe(404);
      expect(missingApi.json()).toEqual({ error: 'not found' });
    } finally {
      await withWeb.close();
    }
  });
});
