import { loadConfig } from '../config.js';
import { createPool } from '../db.js';
import { createLogger } from '../logger.js';
import { createMonitoringHandlers } from '../monitoring/handlers.js';
import { createSchedulerTick } from '../monitoring/scheduler.js';
import { Worker } from '../queue/worker.js';

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL, 'worker');
// One connection per concurrent job, plus headroom for heartbeats, the
// reaper and the scheduler.
const pool = createPool(config.DATABASE_URL, config.WORKER_CONCURRENCY + 3);

const worker = new Worker({
  pool,
  logger,
  handlers: createMonitoringHandlers({ pool, defaultWebhookUrl: config.DISCORD_WEBHOOK_URL }),
  concurrency: config.WORKER_CONCURRENCY,
  pollIntervalMs: config.WORKER_POLL_INTERVAL_MS,
  leaseMs: config.JOB_LEASE_MS,
  onTick: config.SCHEDULER_ENABLED ? createSchedulerTick(pool, logger) : undefined,
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    logger.info({ signal, activeJobs: worker.activeJobs }, 'draining worker');
    await worker.stop();
    await pool.end();
    logger.info('worker stopped');
    process.exit(0);
  });
}

worker.start();
logger.info({ workerId: worker.id, concurrency: config.WORKER_CONCURRENCY }, 'worker started');
