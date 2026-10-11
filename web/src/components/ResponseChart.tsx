import { useEffect, useRef, useState } from 'react';
import type { CheckResult } from '../api';
import { formatDateTime } from '../format';

const HEIGHT = 140;
const PAD_TOP = 12;
const PAD_BOTTOM = 18;
const PAD_LEFT = 48;
const FAIL_MARK = 8;

/**
 * Response time per check, oldest on the left. Failed checks have no
 * response time, so they're drawn as a short red mark at the baseline with a
 * cross (shape + color, not color alone). The checks table below the chart
 * is the accessible data view.
 */
export function ResponseChart({ checks }: { checks: CheckResult[] }) {
  const [hover, setHover] = useState<number | null>(null);
  // Draw at the container's real width so axis text stays legible on phones
  // instead of scaling down with a fixed viewBox.
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.max(280, Math.floor(entry.contentRect.width)));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const series = [...checks].reverse();
  if (series.length === 0) {
    return (
      <div className="chart" ref={ref}>
        <p className="muted">No checks yet.</p>
      </div>
    );
  }

  const plotW = width - PAD_LEFT;
  const plotH = HEIGHT - PAD_TOP - PAD_BOTTOM;
  const maxMs = Math.max(100, ...series.map((c) => c.responseMs ?? 0));
  const yMax = niceCeil(maxMs);
  const slot = plotW / Math.max(series.length, 30);
  const barW = Math.max(2, Math.min(14, slot - 2)); // 2px gap between bars
  const y = (ms: number) => PAD_TOP + plotH - (ms / yMax) * plotH;
  const baseline = PAD_TOP + plotH;
  const active = hover === null ? undefined : series[hover];

  return (
    <div className="chart" ref={ref}>
      <div className="chart-legend" aria-hidden="true">
        <span>
          <i className="swatch swatch-series" /> Response time
        </span>
        <span>
          <i className="swatch swatch-fail" /> Failed check
        </span>
      </div>
      <svg
        viewBox={`0 0 ${width} ${HEIGHT}`}
        role="img"
        aria-label={`Response times for the last ${series.length} checks; see the table below for values`}
        onMouseLeave={() => setHover(null)}
      >
        {[0, yMax / 2, yMax].map((v) => (
          <g key={v}>
            <line x1={PAD_LEFT} x2={width} y1={y(v)} y2={y(v)} className="grid" />
            <text x={PAD_LEFT - 6} y={y(v) + 4} className="axis" textAnchor="end">
              {v >= 1000 ? `${v / 1000}s` : `${v}ms`}
            </text>
          </g>
        ))}
        {series.map((c, i) => {
          const x = PAD_LEFT + i * slot + (slot - barW) / 2;
          const failed = !c.ok;
          const top = failed ? baseline - FAIL_MARK : y(Math.max(c.responseMs ?? 0, yMax * 0.01));
          return (
            <g key={i} className={hover === i ? 'bar-hover' : undefined}>
              <path
                d={roundedTop(x, top, barW, baseline - top)}
                className={failed ? 'bar-fail' : 'bar'}
              />
              {failed && (
                <text
                  x={x + barW / 2}
                  y={baseline - FAIL_MARK - 3}
                  className="fail-glyph"
                  textAnchor="middle"
                >
                  ×
                </text>
              )}
              {/* Hit target: the full column, wider than the mark. */}
              <rect
                x={PAD_LEFT + i * slot}
                y={PAD_TOP}
                width={slot}
                height={plotH}
                fill="transparent"
                onMouseEnter={() => setHover(i)}
              />
            </g>
          );
        })}
        <line x1={PAD_LEFT} x2={width} y1={baseline} y2={baseline} className="axis-line" />
      </svg>
      <div className="chart-tooltip" aria-live="polite">
        {active ? (
          <>
            <strong>{formatDateTime(active.checkedAt)}</strong> ·{' '}
            {active.ok
              ? `${active.responseMs} ms · HTTP ${active.statusCode}`
              : `Failed: ${active.error ?? 'unknown error'}`}
          </>
        ) : (
          <span className="muted">Hover a bar for details</span>
        )}
      </div>
    </div>
  );
}

function niceCeil(v: number): number {
  const steps = [100, 200, 250, 500, 1000, 2000, 2500, 5000, 10_000, 20_000, 30_000];
  return steps.find((s) => s >= v) ?? Math.ceil(v / 10_000) * 10_000;
}

/** A bar with 4px rounded top corners, square at the baseline. */
function roundedTop(x: number, y: number, w: number, h: number): string {
  const r = Math.min(4, w / 2, h);
  return `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z`;
}
