import { useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { ResponseChart } from '../components/ResponseChart';
import { CertBadge, StatusBadge } from '../components/StatusBadge';
import { daysUntil, formatDateTime, formatDuration, formatInterval, timeAgo } from '../format';
import { usePolling } from '../hooks';

export function MonitorDetailPage() {
  const id = Number(useParams().id);
  const navigate = useNavigate();
  const { data, error, reload } = usePolling(() => api.getMonitor(id), 5000);
  const [message, setMessage] = useState<string>();

  async function act(fn: () => Promise<unknown>, done?: string) {
    try {
      await fn();
      setMessage(done);
      await reload();
    } catch (err) {
      setMessage((err as Error).message);
    }
  }

  if (error && !data) {
    return (
      <div className="notice notice-error">
        {error} · <Link to="/">Back to monitors</Link>
      </div>
    );
  }
  if (!data) return <p className="muted">Loading…</p>;

  const { monitor: m, checks, incidents, alerts } = data;
  const recentOk = checks.filter((c) => c.ok).length;
  const uptime = checks.length ? ((recentOk / checks.length) * 100).toFixed(1) : null;
  const okTimes = checks.filter((c) => c.ok && c.responseMs !== null).map((c) => c.responseMs!);
  const avgMs = okTimes.length
    ? Math.round(okTimes.reduce((a, b) => a + b, 0) / okTimes.length)
    : null;

  return (
    <>
      <p>
        <Link to="/">← Monitors</Link>
      </p>
      <header className="page-header">
        <div>
          <h1>
            {m.name} <StatusBadge status={m.status} enabled={m.enabled} />
          </h1>
          <a className="url" href={m.url} target="_blank" rel="noreferrer noopener">
            {m.url}
          </a>
        </div>
        <div className="actions">
          <button onClick={() => act(() => api.checkNow(id), 'Check queued.')}>Check now</button>
          <button onClick={() => act(() => api.updateMonitor(id, { enabled: !m.enabled }))}>
            {m.enabled ? 'Pause' : 'Resume'}
          </button>
          <button
            className="danger"
            onClick={() => {
              if (confirm(`Delete "${m.name}" and its history?`)) {
                void api.deleteMonitor(id).then(() => navigate('/'));
              }
            }}
          >
            Delete
          </button>
        </div>
      </header>
      {message && <div className="notice">{message}</div>}

      <section className="tiles">
        <Tile label={`Uptime (last ${checks.length} checks)`} value={uptime ? `${uptime}%` : '—'} />
        <Tile label="Avg response" value={avgMs !== null ? `${avgMs} ms` : '—'} />
        <Tile
          label="TLS certificate"
          value={<CertBadge days={daysUntil(m.certExpiresAt)} warnDays={m.certWarnDays} />}
          note={m.certExpiresAt ? `expires ${formatDateTime(m.certExpiresAt)}` : undefined}
        />
        <Tile
          label="Schedule"
          value={`every ${formatInterval(m.intervalSeconds)}`}
          note={`down after ${m.failureThreshold} failure(s) · ${m.hasWebhook ? 'own webhook' : 'default webhook'}`}
        />
      </section>

      <section className="card">
        <h2>Response time</h2>
        <ResponseChart checks={checks} />
      </section>

      <div className="two-col">
        <section className="card">
          <h2>Incidents</h2>
          {incidents.length === 0 ? (
            <p className="muted">No incidents recorded.</p>
          ) : (
            <ul className="list">
              {incidents.map((i) => (
                <li key={i.id}>
                  <strong>{i.resolvedAt ? 'Resolved' : 'Ongoing'}</strong> · started{' '}
                  {formatDateTime(i.openedAt)} · lasted {formatDuration(i.openedAt, i.resolvedAt)}
                  {i.cause && <div className="muted small">{i.cause}</div>}
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="card">
          <h2>Alerts</h2>
          {alerts.length === 0 ? (
            <p className="muted">No alerts sent.</p>
          ) : (
            <ul className="list">
              {alerts.map((a) => (
                <li key={a.id}>
                  <strong>{a.kind.replace('_', ' ')}</strong> · {formatDateTime(a.createdAt)} ·{' '}
                  {a.sentAt
                    ? 'delivered'
                    : a.skippedReason
                      ? `skipped (${a.skippedReason})`
                      : 'pending'}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section className="card">
        <h2>Recent checks</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Result</th>
                <th className="num">Status</th>
                <th className="num">Response</th>
              </tr>
            </thead>
            <tbody>
              {checks.slice(0, 20).map((c) => (
                <tr key={c.checkedAt}>
                  <td title={formatDateTime(c.checkedAt)}>{timeAgo(c.checkedAt)}</td>
                  <td>{c.ok ? 'OK' : <span className="error-text">{c.error}</span>}</td>
                  <td className="num">{c.statusCode ?? '—'}</td>
                  <td className="num">{c.responseMs !== null ? `${c.responseMs} ms` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

function Tile({ label, value, note }: { label: string; value: ReactNode; note?: string }) {
  return (
    <div className="tile">
      <div className="tile-label">{label}</div>
      <div className="tile-value">{value}</div>
      {note && <div className="tile-note">{note}</div>}
    </div>
  );
}
