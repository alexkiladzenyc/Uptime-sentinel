import type { MonitorStatus } from '../api';

const LABELS: Record<MonitorStatus | 'paused', { icon: string; label: string }> = {
  up: { icon: '●', label: 'Up' },
  down: { icon: '▲', label: 'Down' },
  pending: { icon: '○', label: 'Pending' },
  paused: { icon: '❚❚', label: 'Paused' },
};

/** Status is always shown as icon + text, never color alone. */
export function StatusBadge({ status, enabled }: { status: MonitorStatus; enabled: boolean }) {
  const key = enabled ? status : 'paused';
  const { icon, label } = LABELS[key];
  return (
    <span className={`badge badge-${key}`}>
      <span aria-hidden="true">{icon}</span> {label}
    </span>
  );
}

export function CertBadge({ days, warnDays }: { days: number | null; warnDays: number }) {
  if (days === null) return <span className="muted">—</span>;
  if (days < 0) return <span className="badge badge-down">▲ Expired</span>;
  if (days <= warnDays) return <span className="badge badge-warn">⚠ {days}d</span>;
  return <span>{days}d</span>;
}
