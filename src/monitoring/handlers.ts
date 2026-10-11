import type { Pool, PoolClient } from '../db.js';
import { enqueue } from '../queue/queue.js';
import { PermanentJobError, type JobHandler } from '../queue/types.js';
import { checkUrl, type CheckFetchOptions, type CheckOutcome } from './check.js';
import { isDiscordWebhookUrl, sendDiscordMessage, type DiscordSender } from './discord.js';
import {
  applyCheckResult,
  certificateNeedsWarning,
  daysUntil,
  type MonitorStatus,
} from './state.js';

export const CHECK_MONITOR = 'check_monitor';
export const SEND_ALERT = 'send_alert';

export interface CheckMonitorPayload {
  monitorId: number;
}
export interface SendAlertPayload {
  alertId: number;
}

export interface MonitoringDeps {
  pool: Pool;
  /** Used when a monitor has no webhook of its own. */
  defaultWebhookUrl?: string;
  sendDiscord?: DiscordSender;
  /** Overrides for the HTTP client; tests use these to reach local servers. */
  fetchOptions?: CheckFetchOptions;
  now?: () => Date;
}

interface MonitorRow {
  id: number;
  name: string;
  url: string;
  timeout_ms: number;
  failure_threshold: number;
  cert_warn_days: number;
  enabled: boolean;
  status: MonitorStatus;
  consecutive_failures: number;
  webhook_url: string | null;
}

export function createMonitoringHandlers(deps: MonitoringDeps) {
  const now = deps.now ?? (() => new Date());
  const sendDiscord = deps.sendDiscord ?? sendDiscordMessage;

  const checkMonitor: JobHandler<CheckMonitorPayload> = async (job, ctx) => {
    const monitorId = Number(job.payload?.monitorId);
    if (!Number.isInteger(monitorId)) throw new PermanentJobError('payload.monitorId is missing');

    const { rows } = await deps.pool.query<MonitorRow>('SELECT * FROM monitors WHERE id = $1', [
      monitorId,
    ]);
    const monitor = rows[0];
    if (!monitor || !monitor.enabled) return; // deleted or paused since scheduling

    // The network call happens outside any transaction; only the bookkeeping
    // below is transactional.
    const outcome = await checkUrl(monitor.url, monitor.timeout_ms, ctx.signal, deps.fetchOptions);

    await ctx.completeWith((client) => recordCheck(client, monitorId, job.id, outcome, now()));
  };

  const sendAlert: JobHandler<SendAlertPayload> = async (job, ctx) => {
    const alertId = Number(job.payload?.alertId);
    if (!Number.isInteger(alertId)) throw new PermanentJobError('payload.alertId is missing');

    const { rows } = await deps.pool.query<{
      message: string;
      sent_at: Date | null;
      skipped_reason: string | null;
      webhook_url: string | null;
    }>(
      `SELECT a.message, a.sent_at, a.skipped_reason, m.webhook_url
         FROM alerts a JOIN monitors m ON m.id = a.monitor_id
        WHERE a.id = $1`,
      [alertId],
    );
    const alert = rows[0];
    if (!alert || alert.sent_at || alert.skipped_reason) return; // gone, or already handled

    const webhookUrl = alert.webhook_url ?? deps.defaultWebhookUrl;
    if (!webhookUrl) {
      await ctx.completeWith((c) =>
        c.query(`UPDATE alerts SET skipped_reason = 'no webhook configured' WHERE id = $1`, [
          alertId,
        ]),
      );
      return;
    }
    if (!isDiscordWebhookUrl(webhookUrl)) {
      throw new PermanentJobError('webhook URL is not a Discord webhook URL');
    }

    // If the process dies between this POST and the commit below, the job is
    // retried and Discord receives the message twice. That window is the one
    // place this system is at-least-once from the outside; see docs/decisions.md.
    await sendDiscord(webhookUrl, alert.message, ctx.signal);
    await ctx.completeWith((c) =>
      c.query('UPDATE alerts SET sent_at = now() WHERE id = $1', [alertId]),
    );
  };

  return {
    [CHECK_MONITOR]: checkMonitor,
    [SEND_ALERT]: sendAlert,
  } as Record<string, JobHandler<never>>;
}

/**
 * Stores a check result and applies its consequences: monitor state,
 * incidents, and alerts. Runs in the transaction that completes the job, and
 * alert jobs are enqueued in that same transaction (transactional outbox),
 * so a crash can never leave an incident without its alert or vice versa.
 */
async function recordCheck(
  client: PoolClient,
  monitorId: number,
  jobId: number,
  outcome: CheckOutcome,
  checkedAt: Date,
): Promise<void> {
  // Row lock: serializes concurrent results for the same monitor (e.g. a
  // scheduled check racing a manual "check now").
  const { rows } = await client.query<MonitorRow>(
    'SELECT * FROM monitors WHERE id = $1 FOR UPDATE',
    [monitorId],
  );
  const monitor = rows[0];
  if (!monitor) return;

  await client.query(
    `INSERT INTO check_results
       (monitor_id, job_id, checked_at, ok, status_code, response_ms, error, cert_expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      monitorId,
      jobId,
      checkedAt,
      outcome.ok,
      outcome.statusCode,
      outcome.responseMs,
      outcome.error,
      outcome.certExpiresAt,
    ],
  );

  const next = applyCheckResult(
    { status: monitor.status, consecutiveFailures: monitor.consecutive_failures },
    outcome.ok,
    monitor.failure_threshold,
  );

  await client.query(
    `UPDATE monitors
        SET status = $2, consecutive_failures = $3, last_checked_at = $4,
            last_status_code = $5, last_response_ms = $6, last_error = $7,
            cert_expires_at = COALESCE($8, cert_expires_at), updated_at = now()
      WHERE id = $1`,
    [
      monitorId,
      next.status,
      next.consecutiveFailures,
      checkedAt,
      outcome.statusCode,
      outcome.responseMs,
      outcome.error,
      outcome.certExpiresAt,
    ],
  );

  if (next.event === 'down') {
    const incident = await client.query<{ id: number }>(
      `INSERT INTO incidents (monitor_id, opened_at, cause) VALUES ($1, $2, $3)
       ON CONFLICT (monitor_id) WHERE resolved_at IS NULL DO NOTHING
       RETURNING id`,
      [monitorId, checkedAt, outcome.error],
    );
    const incidentId = incident.rows[0]?.id;
    if (incidentId !== undefined) {
      await createAlert(
        client,
        monitorId,
        'down',
        `incident:${incidentId}:down`,
        `🔴 **${monitor.name}** is DOWN\n${monitor.url}\nReason: ${outcome.error ?? 'unknown'}`,
      );
    }
  } else if (next.event === 'recovered') {
    const incident = await client.query<{ id: number; opened_at: Date }>(
      `UPDATE incidents SET resolved_at = $2
        WHERE monitor_id = $1 AND resolved_at IS NULL
        RETURNING id, opened_at`,
      [monitorId, checkedAt],
    );
    const resolved = incident.rows[0];
    if (resolved) {
      const minutes = Math.max(
        1,
        Math.round((checkedAt.getTime() - resolved.opened_at.getTime()) / 60_000),
      );
      await createAlert(
        client,
        monitorId,
        'recovered',
        `incident:${resolved.id}:recovered`,
        `🟢 **${monitor.name}** is back UP after ~${minutes} min\n${monitor.url}`,
      );
    }
  }

  if (
    outcome.certExpiresAt &&
    certificateNeedsWarning(outcome.certExpiresAt, monitor.cert_warn_days, checkedAt)
  ) {
    const days = daysUntil(outcome.certExpiresAt, checkedAt);
    const expiry = outcome.certExpiresAt.toISOString().slice(0, 10);
    await createAlert(
      client,
      monitorId,
      'cert_expiring',
      // One warning per certificate: a renewed cert has a new expiry date.
      `cert:${monitorId}:${expiry}`,
      days < 0
        ? `⚠️ **${monitor.name}**: TLS certificate EXPIRED on ${expiry}\n${monitor.url}`
        : `⚠️ **${monitor.name}**: TLS certificate expires in ${days} day(s), on ${expiry}\n${monitor.url}`,
    );
  }
}

async function createAlert(
  client: PoolClient,
  monitorId: number,
  kind: 'down' | 'recovered' | 'cert_expiring',
  dedupeKey: string,
  message: string,
): Promise<void> {
  const { rows } = await client.query<{ id: number }>(
    `INSERT INTO alerts (monitor_id, kind, dedupe_key, message) VALUES ($1, $2, $3, $4)
     ON CONFLICT (dedupe_key) DO NOTHING
     RETURNING id`,
    [monitorId, kind, dedupeKey, message],
  );
  const alertId = rows[0]?.id;
  if (alertId !== undefined) {
    await enqueue(
      client,
      SEND_ALERT,
      { alertId },
      { maxAttempts: 8, dedupeKey: `alert:${alertId}` },
    );
  }
}
