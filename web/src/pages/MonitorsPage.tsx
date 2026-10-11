import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { CertBadge, StatusBadge } from '../components/StatusBadge';
import { daysUntil, formatInterval, timeAgo } from '../format';
import { usePolling } from '../hooks';

export function MonitorsPage() {
  const { data, error, reload } = usePolling(api.listMonitors);
  const monitors = data?.monitors ?? [];
  const down = monitors.filter((m) => m.enabled && m.status === 'down').length;
  const up = monitors.filter((m) => m.enabled && m.status === 'up').length;

  return (
    <>
      <header className="page-header">
        <div>
          <h1>Monitors</h1>
          <p className="muted">
            {data ? `${monitors.length} monitored · ${up} up · ${down} down` : 'Loading…'}
          </p>
        </div>
      </header>

      {error && <div className="notice notice-error">Could not load monitors: {error}</div>}

      <AddMonitorForm onCreated={reload} />

      {data && monitors.length === 0 ? (
        <div className="empty">
          <h2>No monitors yet</h2>
          <p className="muted">Add a URL above. Checks start within a few seconds.</p>
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Status</th>
                <th>Name</th>
                <th className="hide-sm">Every</th>
                <th className="num">Response</th>
                <th className="num hide-sm">TLS expiry</th>
                <th className="hide-sm">Last check</th>
              </tr>
            </thead>
            <tbody>
              {monitors.map((m) => (
                <tr key={m.id}>
                  <td>
                    <StatusBadge status={m.status} enabled={m.enabled} />
                  </td>
                  <td>
                    <Link to={`/monitors/${m.id}`} className="strong">
                      {m.name}
                    </Link>
                    <div className="url">{m.url}</div>
                  </td>
                  <td className="hide-sm">{formatInterval(m.intervalSeconds)}</td>
                  <td className="num">
                    {m.lastError && m.status !== 'up' ? (
                      <span className="error-text" title={m.lastError}>
                        {m.lastStatusCode ? `HTTP ${m.lastStatusCode}` : 'error'}
                      </span>
                    ) : m.lastResponseMs !== null ? (
                      `${m.lastResponseMs} ms`
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="num hide-sm">
                    <CertBadge days={daysUntil(m.certExpiresAt)} warnDays={m.certWarnDays} />
                  </td>
                  <td className="hide-sm muted">{timeAgo(m.lastCheckedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function AddMonitorForm({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('https://');
  const [intervalSeconds, setIntervalSeconds] = useState(60);
  const [webhookUrl, setWebhookUrl] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await api.createMonitor({
        name: name || new URL(url).hostname,
        url,
        intervalSeconds,
        webhookUrl: webhookUrl.trim() || null,
      });
      setName('');
      setUrl('https://');
      setWebhookUrl('');
      onCreated();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card add-form" onSubmit={submit}>
      <div className="field grow">
        <label htmlFor="url">URL</label>
        <input id="url" type="url" required value={url} onChange={(e) => setUrl(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="name">Name</label>
        <input
          id="name"
          placeholder="defaults to host"
          maxLength={100}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor="interval">Check every</label>
        <select
          id="interval"
          value={intervalSeconds}
          onChange={(e) => setIntervalSeconds(Number(e.target.value))}
        >
          <option value={30}>30 seconds</option>
          <option value={60}>1 minute</option>
          <option value={300}>5 minutes</option>
          <option value={900}>15 minutes</option>
          <option value={3600}>1 hour</option>
        </select>
      </div>
      <div className="field grow">
        <label htmlFor="webhook">Discord webhook (optional)</label>
        <input
          id="webhook"
          type="url"
          placeholder="https://discord.com/api/webhooks/…"
          value={webhookUrl}
          onChange={(e) => setWebhookUrl(e.target.value)}
        />
      </div>
      <button type="submit" className="primary" disabled={busy}>
        {busy ? 'Adding…' : 'Add monitor'}
      </button>
      {error && <p className="form-error">{error}</p>}
    </form>
  );
}
