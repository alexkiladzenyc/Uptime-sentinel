import { describe, expect, it } from 'vitest';
import {
  applyCheckResult,
  certificateNeedsWarning,
  daysUntil,
  type MonitorState,
} from '../../src/monitoring/state.js';

const state = (status: MonitorState['status'], consecutiveFailures = 0): MonitorState => ({
  status,
  consecutiveFailures,
});

describe('applyCheckResult', () => {
  it('marks a pending monitor up on success without a recovery event', () => {
    expect(applyCheckResult(state('pending'), true, 2)).toEqual({
      status: 'up',
      consecutiveFailures: 0,
      event: null,
    });
  });

  it('waits for the failure threshold before going down', () => {
    const first = applyCheckResult(state('up'), false, 3);
    expect(first).toEqual({ status: 'up', consecutiveFailures: 1, event: null });
    const second = applyCheckResult(first, false, 3);
    expect(second).toEqual({ status: 'up', consecutiveFailures: 2, event: null });
    const third = applyCheckResult(second, false, 3);
    expect(third).toEqual({ status: 'down', consecutiveFailures: 3, event: 'down' });
  });

  it('goes down on the first failure when the threshold is 1', () => {
    expect(applyCheckResult(state('up'), false, 1).event).toBe('down');
  });

  it('emits "down" only once while failures continue', () => {
    const down = applyCheckResult(state('up', 1), false, 2);
    expect(down.event).toBe('down');
    expect(applyCheckResult(down, false, 2)).toEqual({
      status: 'down',
      consecutiveFailures: 3,
      event: null,
    });
  });

  it('resets the failure count on a success between failures (flapping)', () => {
    const blip = applyCheckResult(state('up'), false, 2);
    const ok = applyCheckResult(blip, true, 2);
    expect(ok).toEqual({ status: 'up', consecutiveFailures: 0, event: null });
    expect(applyCheckResult(ok, false, 2).event).toBeNull();
  });

  it('emits "recovered" when a down monitor succeeds', () => {
    expect(applyCheckResult(state('down', 5), true, 2)).toEqual({
      status: 'up',
      consecutiveFailures: 0,
      event: 'recovered',
    });
  });

  it('can take a never-healthy monitor straight from pending to down', () => {
    const r = applyCheckResult(state('pending', 1), false, 2);
    expect(r).toEqual({ status: 'down', consecutiveFailures: 2, event: 'down' });
  });
});

describe('certificate expiry', () => {
  const now = new Date('2026-01-01T00:00:00Z');
  const inDays = (d: number) => new Date(now.getTime() + d * 86_400_000);

  it('warns inside the window and for expired certificates', () => {
    expect(certificateNeedsWarning(inDays(30), 14, now)).toBe(false);
    expect(certificateNeedsWarning(inDays(14), 14, now)).toBe(true);
    expect(certificateNeedsWarning(inDays(3), 14, now)).toBe(true);
    expect(certificateNeedsWarning(inDays(-1), 14, now)).toBe(true);
    expect(certificateNeedsWarning(null, 14, now)).toBe(false);
  });

  it('counts whole days remaining', () => {
    expect(daysUntil(inDays(10.5), now)).toBe(10);
    expect(daysUntil(inDays(-0.5), now)).toBe(-1);
  });
});
