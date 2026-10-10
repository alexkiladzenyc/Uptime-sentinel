import { describe, expect, it } from 'vitest';
import { backoffDelayMs } from '../../src/queue/backoff.js';

const opts = { baseMs: 1000, maxMs: 60_000 };

describe('backoffDelayMs', () => {
  it('doubles the delay per attempt', () => {
    const noJitter = () => 1;
    expect(backoffDelayMs(1, opts, noJitter)).toBe(1000);
    expect(backoffDelayMs(2, opts, noJitter)).toBe(2000);
    expect(backoffDelayMs(3, opts, noJitter)).toBe(4000);
    expect(backoffDelayMs(4, opts, noJitter)).toBe(8000);
  });

  it('keeps at least half of the exponential delay (equal jitter)', () => {
    expect(backoffDelayMs(3, opts, () => 0)).toBe(2000);
    expect(backoffDelayMs(3, opts, () => 0.5)).toBe(3000);
  });

  it('caps the delay at maxMs', () => {
    expect(backoffDelayMs(20, opts, () => 1)).toBe(60_000);
    expect(backoffDelayMs(10_000, opts, () => 1)).toBe(60_000);
  });

  it('stays within [exp/2, exp] for random jitter', () => {
    for (let i = 0; i < 1000; i++) {
      const delay = backoffDelayMs(3, opts);
      expect(delay).toBeGreaterThanOrEqual(2000);
      expect(delay).toBeLessThanOrEqual(4000);
    }
  });
});
