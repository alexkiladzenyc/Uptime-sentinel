import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Pool } from '../db.js';
import type { Logger } from '../logger.js';
import { DEFAULT_BACKOFF, type BackoffOptions } from './backoff.js';
import * as queue from './queue.js';
import {
  LeaseLostError,
  PermanentJobError,
  type ClaimedJob,
  type JobContext,
  type JobHandler,
} from './types.js';

export interface WorkerOptions {
  pool: Pool;
  handlers: Record<string, JobHandler<never>>;
  logger: Logger;
  /** Max jobs processed at once by this worker. */
  concurrency?: number;
  /** How long to sleep when the queue is empty. */
  pollIntervalMs?: number;
  /** Lease length. Heartbeats renew it at a third of this interval. */
  leaseMs?: number;
  /** Per-attempt timeout; the handler's AbortSignal fires when it elapses. */
  jobTimeoutMs?: number;
  /** How often this worker looks for expired leases. */
  reapIntervalMs?: number;
  backoff?: BackoffOptions;
  workerId?: string;
  /** Called on every poll loop iteration; used to run the scheduler in-process. */
  onTick?: () => Promise<void>;
  tickIntervalMs?: number;
}

/**
 * Polls the jobs table and runs handlers with bounded concurrency.
 *
 * Delivery is at-least-once: if this process dies mid-job, the lease expires
 * and another worker runs the job again. Handlers must therefore be
 * idempotent, or use `ctx.completeWith` to commit their database effects
 * atomically with completion.
 */
export class Worker {
  readonly id: string;
  private readonly opts: Required<Omit<WorkerOptions, 'onTick' | 'workerId'>> &
    Pick<WorkerOptions, 'onTick'>;
  private readonly inFlight = new Map<
    number,
    { controller: AbortController; done: Promise<void> }
  >();
  private running = false;
  private loopDone: Promise<void> | undefined;
  private wake: AbortController | undefined;

  constructor(options: WorkerOptions) {
    this.id = options.workerId ?? `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
    this.opts = {
      concurrency: 4,
      pollIntervalMs: 1000,
      leaseMs: 30_000,
      jobTimeoutMs: 60_000,
      reapIntervalMs: 5_000,
      backoff: DEFAULT_BACKOFF,
      tickIntervalMs: 5_000,
      ...options,
    };
  }

  get activeJobs(): number {
    return this.inFlight.size;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loopDone = this.loop();
  }

  /**
   * Stops claiming new jobs and waits up to `graceMs` for in-flight jobs.
   * Jobs still running after that are aborted; their leases are left to
   * expire so another worker picks them up.
   */
  async stop(graceMs = 25_000): Promise<void> {
    this.running = false;
    this.wake?.abort();
    await this.loopDone;
    const all = Promise.all([...this.inFlight.values()].map((j) => j.done));
    const timedOut = await Promise.race([all.then(() => false), sleep(graceMs).then(() => true)]);
    if (timedOut) {
      this.opts.logger.warn(
        { jobs: [...this.inFlight.keys()] },
        'grace period over, aborting jobs',
      );
      for (const job of this.inFlight.values()) job.controller.abort(new Error('worker stopping'));
      await all;
    }
  }

  private async loop(): Promise<void> {
    const { logger } = this.opts;
    let lastReap = 0;
    let lastTick = 0;
    while (this.running) {
      try {
        const now = Date.now();
        if (now - lastReap >= this.opts.reapIntervalMs) {
          lastReap = now;
          const reaped = await queue.reapExpired(this.opts.pool, this.opts.backoff);
          if (reaped.retried || reaped.dead)
            logger.warn(reaped, 'recovered jobs with expired leases');
        }
        if (this.opts.onTick && now - lastTick >= this.opts.tickIntervalMs) {
          lastTick = now;
          await this.opts.onTick();
        }

        const free = this.opts.concurrency - this.inFlight.size;
        const jobs =
          free > 0
            ? await queue.claim(
                this.opts.pool,
                this.id,
                free,
                this.opts.leaseMs,
                Object.keys(this.opts.handlers),
              )
            : [];
        for (const job of jobs) this.launch(job);

        // If every free slot was filled there may be more work: poll again right
        // away. Otherwise sleep until the poll interval passes or a slot frees up.
        if (free <= 0 || jobs.length < free) await this.idle(this.opts.pollIntervalMs);
      } catch (err) {
        logger.error({ err }, 'worker loop error');
        await this.idle(this.opts.pollIntervalMs);
      }
    }
  }

  private async idle(ms: number): Promise<void> {
    this.wake = new AbortController();
    await sleep(ms, undefined, { signal: this.wake.signal }).catch(() => undefined);
  }

  private launch(job: ClaimedJob): void {
    const controller = new AbortController();
    const done = this.run(job, controller).finally(() => {
      this.inFlight.delete(job.id);
      this.wake?.abort(); // a slot freed up; poll immediately
    });
    this.inFlight.set(job.id, { controller, done });
  }

  private async run(job: ClaimedJob, controller: AbortController): Promise<void> {
    const { pool, logger, leaseMs } = this.opts;
    const log = logger.child({ jobId: job.id, type: job.type, attempt: job.attempts });
    const handler = this.opts.handlers[job.type] as JobHandler | undefined;

    const timeout = setTimeout(
      () => controller.abort(new Error(`job timed out after ${this.opts.jobTimeoutMs}ms`)),
      this.opts.jobTimeoutMs,
    );
    const heartbeat = setInterval(
      () => {
        queue
          .heartbeat(pool, job.id, job.lease_token, leaseMs)
          .then((owned) => {
            if (!owned) controller.abort(new LeaseLostError('lease lost during heartbeat'));
          })
          .catch((err) => log.warn({ err }, 'heartbeat failed'));
      },
      Math.max(100, Math.floor(leaseMs / 3)),
    );

    let completedInTx = false;
    const ctx: JobContext = {
      signal: controller.signal,
      completeWith: async (fn) => {
        const result = await queue.completeInTransaction(pool, job.id, job.lease_token, fn);
        if (!result.ok) throw new LeaseLostError('lease lost before completion');
        completedInTx = true;
        return result.value;
      },
    };

    try {
      if (!handler) throw new PermanentJobError(`no handler registered for job type "${job.type}"`);
      await Promise.race([handler(job, ctx), rejectOnAbort(controller.signal)]);
      if (!completedInTx && !(await queue.complete(pool, job.id, job.lease_token))) {
        log.warn('job finished but its lease was lost; another worker may re-run it');
        return;
      }
      log.debug('job succeeded');
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      if (error instanceof LeaseLostError || controller.signal.reason instanceof LeaseLostError) {
        log.warn('lease lost; leaving the job to its new owner');
        return;
      }
      const reason =
        controller.signal.aborted && controller.signal.reason instanceof Error
          ? controller.signal.reason.message
          : error.message;
      const outcome = await queue
        .fail(pool, job, reason, {
          permanent: error instanceof PermanentJobError,
          backoff: this.opts.backoff,
        })
        .catch((failErr) => {
          log.error({ err: failErr }, 'could not record job failure; lease will expire');
          return 'lease_lost' as const;
        });
      if (outcome === 'dead') log.error({ err: error }, 'job moved to dead-letter queue');
      else if (outcome === 'retry') log.warn({ err: error }, 'job failed, will retry');
    } finally {
      clearTimeout(timeout);
      clearInterval(heartbeat);
    }
  }
}

/**
 * Rejects when the signal aborts, so a handler that ignores its signal can't
 * hold a job forever. If such a handler later tries to complete, the fencing
 * token check rejects it.
 */
function rejectOnAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const onAbort = () =>
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
}
