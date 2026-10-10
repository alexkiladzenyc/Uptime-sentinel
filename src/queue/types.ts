import type { PoolClient } from '../db.js';

export type JobStatus = 'available' | 'running' | 'succeeded' | 'dead';

export interface Job<P = unknown> {
  id: number;
  type: string;
  payload: P;
  status: JobStatus;
  attempts: number;
  max_attempts: number;
  run_at: Date;
  lease_token: string | null;
  lease_expires_at: Date | null;
  locked_by: string | null;
  last_error: string | null;
  dedupe_key: string | null;
  created_at: Date;
  updated_at: Date;
  finished_at: Date | null;
}

/** A job that a worker currently holds a lease on. */
export type ClaimedJob<P = unknown> = Job<P> & { lease_token: string; lease_expires_at: Date };

export interface EnqueueOptions {
  maxAttempts?: number;
  /** Run no earlier than this. Defaults to now. */
  runAt?: Date;
  /** If an available or running job already has this key, nothing is enqueued. */
  dedupeKey?: string;
}

export interface JobContext {
  /** Aborted when the job times out, its lease is lost, or the worker is force-stopped. */
  signal: AbortSignal;
  /**
   * Runs `fn` in a transaction that also marks the job succeeded. If the
   * lease was lost in the meantime the transaction rolls back, so database
   * side effects and completion are atomic: they happen together or not at all.
   */
  completeWith<T>(fn: (client: PoolClient) => Promise<T>): Promise<T>;
}

export type JobHandler<P = unknown> = (job: ClaimedJob<P>, ctx: JobContext) => Promise<void>;

/** Throw this from a handler to skip the remaining retries and dead-letter the job. */
export class PermanentJobError extends Error {
  override name = 'PermanentJobError';
}

/** The worker no longer owns the job (its lease expired and it may have been re-claimed). */
export class LeaseLostError extends Error {
  override name = 'LeaseLostError';
}
