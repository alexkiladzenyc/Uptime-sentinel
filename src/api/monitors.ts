import type { FastifyInstance } from 'fastify';
import net from 'node:net';
import { z } from 'zod';
import type { Pool } from '../db.js';
import { isDiscordWebhookUrl } from '../monitoring/discord.js';
import { CHECK_MONITOR } from '../monitoring/handlers.js';
import {
  parseTargetUrl,
  resolvePublic,
  SsrfBlockedError,
  type AddressPolicy,
  type Resolver,
} from '../net/safe-fetch.js';
import { enqueue } from '../queue/queue.js';
import { ApiError, parseBody, parseId } from './errors.js';

export interface MonitorRoutesOptions {
  pool: Pool;
  maxMonitors: number;
  resolver?: Resolver;
  addressPolicy?: AddressPolicy;
}

const webhookUrl = z
  .string()
  .trim()
  .refine(isDiscordWebhookUrl, 'must be a Discord webhook URL (https://discord.com/api/webhooks/…)')
  .nullable();

const fields = {
  name: z.string().trim().min(1).max(100),
  url: z.string().trim().min(1).max(2048),
  intervalSeconds: z.number().int().min(30).max(86_400),
  timeoutMs: z.number().int().min(1000).max(30_000),
  failureThreshold: z.number().int().min(1).max(10),
  certWarnDays: z.number().int().min(1).max(90),
  webhookUrl,
};

const createSchema = z.object({
  ...fields,
  intervalSeconds: fields.intervalSeconds.default(60),
  timeoutMs: fields.timeoutMs.default(10_000),
  failureThreshold: fields.failureThreshold.default(2),
  certWarnDays: fields.certWarnDays.default(14),
  webhookUrl: webhookUrl.optional().default(null),
});

const updateSchema = z
  .object({ ...fields, enabled: z.boolean() })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'no fields to update');

const COLUMNS: Record<string, string> = {
  name: 'name',
  url: 'url',
  intervalSeconds: 'interval_seconds',
  timeoutMs: 'timeout_ms',
  failureThreshold: 'failure_threshold',
  certWarnDays: 'cert_warn_days',
  webhookUrl: 'webhook_url',
  enabled: 'enabled',
};

interface MonitorRow {
  id: number;
  name: string;
  url: string;
  interval_seconds: number;
  timeout_ms: number;
  failure_threshold: number;
  cert_warn_days: number;
  webhook_url: string | null;
  enabled: boolean;
  status: string;
  consecutive_failures: number;
  last_checked_at: Date | null;
  last_status_code: number | null;
  last_response_ms: number | null;
  last_error: string | null;
  cert_expires_at: Date | null;
  next_check_at: Date;
  created_at: Date;
}

function toDto(m: MonitorRow) {
  return {
    id: m.id,
    name: m.name,
    url: m.url,
    intervalSeconds: m.interval_seconds,
    timeoutMs: m.timeout_ms,
    failureThreshold: m.failure_threshold,
    certWarnDays: m.cert_warn_days,
    // The webhook token is a secret: show only that one is set.
    hasWebhook: m.webhook_url !== null,
    enabled: m.enabled,
    status: m.status,
    consecutiveFailures: m.consecutive_failures,
    lastCheckedAt: m.last_checked_at,
    lastStatusCode: m.last_status_code,
    lastResponseMs: m.last_response_ms,
    lastError: m.last_error,
    certExpiresAt: m.cert_expires_at,
    nextCheckAt: m.next_check_at,
    createdAt: m.created_at,
  };
}

export async function monitorRoutes(app: FastifyInstance, opts: MonitorRoutesOptions) {
  const { pool } = opts;

  /**
   * Early SSRF feedback for the user. This is a convenience, not the
   * defence: DNS can change after this point, so every check re-validates
   * at connection time.
   */
  async function validateTargetUrl(raw: string): Promise<string> {
    try {
      const url = parseTargetUrl(raw, opts.addressPolicy);
      const host = url.hostname.replace(/^\[|\]$/g, '');
      if (!net.isIP(host)) await resolvePublic(host, opts.resolver, opts.addressPolicy);
      return url.href;
    } catch (err) {
      if (err instanceof SsrfBlockedError) throw new ApiError(400, `url: ${err.message}`);
      throw new ApiError(400, `url: could not resolve host (${(err as Error).message})`);
    }
  }

  async function getMonitor(id: number): Promise<MonitorRow> {
    const { rows } = await pool.query<MonitorRow>('SELECT * FROM monitors WHERE id = $1', [id]);
    if (!rows[0]) throw new ApiError(404, 'monitor not found');
    return rows[0];
  }

  app.get('/api/monitors', async () => {
    const { rows } = await pool.query<MonitorRow>('SELECT * FROM monitors ORDER BY name, id');
    return { monitors: rows.map(toDto) };
  });

  app.post('/api/monitors', async (req, reply) => {
    const body = parseBody(createSchema, req.body);
    const url = await validateTargetUrl(body.url);
    const { rows } = await pool.query<MonitorRow>(
      `INSERT INTO monitors (name, url, interval_seconds, timeout_ms, failure_threshold, cert_warn_days, webhook_url)
       SELECT $1, $2, $3, $4, $5, $6, $7
       WHERE (SELECT count(*) FROM monitors) < $8
       RETURNING *`,
      [
        body.name,
        url,
        body.intervalSeconds,
        body.timeoutMs,
        body.failureThreshold,
        body.certWarnDays,
        body.webhookUrl,
        opts.maxMonitors,
      ],
    );
    if (!rows[0]) throw new ApiError(409, `monitor limit reached (${opts.maxMonitors})`);
    return reply.code(201).send({ monitor: toDto(rows[0]) });
  });

  app.get('/api/monitors/:id', async (req) => {
    const id = parseId(req.params);
    const monitor = await getMonitor(id);
    const [checks, incidents, alerts] = await Promise.all([
      pool.query(
        `SELECT checked_at AS "checkedAt", ok, status_code AS "statusCode",
                response_ms AS "responseMs", error
           FROM check_results WHERE monitor_id = $1 ORDER BY checked_at DESC LIMIT 60`,
        [id],
      ),
      pool.query(
        `SELECT id, opened_at AS "openedAt", resolved_at AS "resolvedAt", cause
           FROM incidents WHERE monitor_id = $1 ORDER BY opened_at DESC LIMIT 20`,
        [id],
      ),
      pool.query(
        `SELECT id, kind, message, created_at AS "createdAt", sent_at AS "sentAt",
                skipped_reason AS "skippedReason"
           FROM alerts WHERE monitor_id = $1 ORDER BY created_at DESC LIMIT 20`,
        [id],
      ),
    ]);
    return {
      monitor: toDto(monitor),
      checks: checks.rows,
      incidents: incidents.rows,
      alerts: alerts.rows,
    };
  });

  app.patch('/api/monitors/:id', async (req) => {
    const id = parseId(req.params);
    const body = parseBody(updateSchema, req.body);
    await getMonitor(id);
    if (body.url !== undefined) body.url = await validateTargetUrl(body.url);

    const sets: string[] = [];
    const values: unknown[] = [id];
    for (const [key, value] of Object.entries(body)) {
      values.push(value);
      sets.push(`${COLUMNS[key]} = $${values.length}`);
    }
    if (body.url !== undefined) {
      // A new target starts with a clean slate.
      sets.push(
        `status = 'pending'`,
        'consecutive_failures = 0',
        'cert_expires_at = NULL',
        'next_check_at = now()',
      );
    } else if (body.enabled === true) {
      sets.push('next_check_at = now()');
    }
    const { rows } = await pool.query<MonitorRow>(
      `UPDATE monitors SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`,
      values,
    );
    return { monitor: toDto(rows[0]!) };
  });

  app.delete('/api/monitors/:id', async (req, reply) => {
    const id = parseId(req.params);
    const { rowCount } = await pool.query('DELETE FROM monitors WHERE id = $1', [id]);
    if (rowCount === 0) throw new ApiError(404, 'monitor not found');
    return reply.code(204).send();
  });

  app.post('/api/monitors/:id/check', async (req, reply) => {
    const id = parseId(req.params);
    await getMonitor(id);
    const jobId = await enqueue(
      pool,
      CHECK_MONITOR,
      { monitorId: id },
      { maxAttempts: 3, dedupeKey: `${CHECK_MONITOR}:${id}` },
    );
    // jobId is null when a check for this monitor is already queued or running.
    return reply.code(202).send({ jobId, alreadyQueued: jobId === null });
  });
}
