import { safeFetch, type SafeFetchOptions } from '../net/safe-fetch.js';

export interface CheckOutcome {
  ok: boolean;
  statusCode: number | null;
  responseMs: number | null;
  error: string | null;
  certExpiresAt: Date | null;
}

export type CheckFetchOptions = Omit<SafeFetchOptions, 'timeoutMs' | 'signal'>;

/**
 * Checks one URL. A site being down is a normal result, not an exception:
 * network errors, TLS errors, blocked addresses and non-2xx/3xx statuses all
 * come back as `ok: false` with a readable error.
 */
export async function checkUrl(
  url: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  fetchOptions: CheckFetchOptions = {},
): Promise<CheckOutcome> {
  try {
    const res = await safeFetch(url, { ...fetchOptions, timeoutMs, signal });
    const ok = res.status >= 200 && res.status < 400;
    return {
      ok,
      statusCode: res.status,
      responseMs: res.responseTimeMs,
      error: ok ? null : `HTTP ${res.status}`,
      certExpiresAt: res.certificate?.validTo ?? null,
    };
  } catch (err) {
    // If the job itself was cancelled (timeout, shutdown) surface that to the
    // worker instead of recording a bogus "site down" result.
    if (signal?.aborted) throw err;
    return {
      ok: false,
      statusCode: null,
      responseMs: null,
      error: describeError(err),
      certExpiresAt: null,
    };
  }
}

function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const code = (err as NodeJS.ErrnoException).code;
  const message = err.message || err.name;
  return code && !message.includes(code) ? `${code}: ${message}` : message;
}
