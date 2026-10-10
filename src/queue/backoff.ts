export interface BackoffOptions {
  /** Delay before the first retry, before jitter. */
  baseMs: number;
  /** Upper bound on the delay, before jitter. */
  maxMs: number;
}

export const DEFAULT_BACKOFF: BackoffOptions = { baseMs: 5_000, maxMs: 15 * 60_000 };

/**
 * Exponential backoff with "equal jitter": half of the exponential delay is
 * fixed, the other half is random. Retries never fire immediately, and
 * workers that failed together do not retry in lockstep.
 *
 * @param attempt the attempt that just failed, starting at 1.
 */
export function backoffDelayMs(
  attempt: number,
  opts: BackoffOptions = DEFAULT_BACKOFF,
  random: () => number = Math.random,
): number {
  const exponent = Math.max(0, attempt - 1);
  // Cap the exponent first so 2 ** exponent can't overflow to Infinity.
  const exp = Math.min(opts.maxMs, opts.baseMs * 2 ** Math.min(exponent, 30));
  const half = exp / 2;
  return Math.round(half + random() * half);
}
