export type MonitorStatus = 'pending' | 'up' | 'down';

export interface MonitorState {
  status: MonitorStatus;
  consecutiveFailures: number;
}

export interface Transition extends MonitorState {
  /** Set when this check changes the monitor's alertable state. */
  event: 'down' | 'recovered' | null;
}

/**
 * Applies one check result to a monitor's state.
 *
 * A monitor goes down only after `failureThreshold` consecutive failures, so
 * a single dropped request does not page anyone. One success brings it back
 * up. A monitor that has never succeeded starts as "pending" and goes down
 * through the same threshold; it is never reported as "recovered" from
 * pending.
 */
export function applyCheckResult(
  prev: MonitorState,
  ok: boolean,
  failureThreshold: number,
): Transition {
  if (ok) {
    return {
      status: 'up',
      consecutiveFailures: 0,
      event: prev.status === 'down' ? 'recovered' : null,
    };
  }
  const consecutiveFailures = prev.consecutiveFailures + 1;
  if (prev.status !== 'down' && consecutiveFailures >= failureThreshold) {
    return { status: 'down', consecutiveFailures, event: 'down' };
  }
  return { status: prev.status, consecutiveFailures, event: null };
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function daysUntil(date: Date, now: Date = new Date()): number {
  return Math.floor((date.getTime() - now.getTime()) / DAY_MS);
}

/** True when a certificate expires within `warnDays` (or already has). */
export function certificateNeedsWarning(
  validTo: Date | undefined | null,
  warnDays: number,
  now: Date = new Date(),
): boolean {
  if (!validTo) return false;
  return validTo.getTime() - now.getTime() <= warnDays * DAY_MS;
}
