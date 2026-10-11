import { useState } from 'react';
import { api, type JobStatus } from '../api';
import { formatDateTime } from '../format';
import { usePolling } from '../hooks';

const STATUSES: JobStatus[] = ['available', 'running', 'succeeded', 'dead'];
const LABELS: Record<JobStatus, string> = {
  available: 'Queued',
  running: 'Running',
  succeeded: 'Succeeded',
  dead: 'Dead-lettered',
};

export function QueuePage() {
  const stats = usePolling(api.queueStats, 3000);
  const [view, setView] = useState<JobStatus>('dead');
  const jobs = usePolling(() => api.listJobs(view), 3000);
  const [message, setMessage] = useState<string>();

  async function act(fn: () => Promise<unknown>, done: string) {
    try {
      await fn();
      setMessage(done);
    } catch (err) {
      setMessage((err as Error).message);
    }
    await Promise.all([stats.reload(), jobs.reload()]);
  }

  const counts = stats.data?.byStatus;
  const lag = stats.data?.oldestAvailableAgeSeconds;

  return (
    <>
      <header className="page-header">
        <div>
          <h1>Job queue</h1>
          <p className="muted">
            The Postgres-backed queue that runs every check and alert.{' '}
            {lag !== null && lag !== undefined && `Oldest due job waiting ${lag.toFixed(1)}s.`}
          </p>
        </div>
      </header>
      {stats.error && <div className="notice notice-error">{stats.error}</div>}
      {message && <div className="notice">{message}</div>}

      <section className="tiles" role="tablist" aria-label="Job status">
        {STATUSES.map((s) => (
          <button
            key={s}
            role="tab"
            aria-selected={view === s}
            className={`tile tile-button ${view === s ? 'selected' : ''} ${s === 'dead' && counts?.dead ? 'tile-alert' : ''}`}
            onClick={() => {
              setView(s);
              void jobs.reload();
            }}
          >
            <div className="tile-label">{LABELS[s]}</div>
            <div className="tile-value">{counts ? counts[s] : '—'}</div>
          </button>
        ))}
      </section>

      <section className="card">
        <h2>{view === 'dead' ? 'Dead-letter queue' : `${LABELS[view]} jobs`}</h2>
        {jobs.data?.jobs.length === 0 ? (
          <p className="muted">
            {view === 'dead'
              ? 'Nothing here. Jobs land here after exhausting their retries.'
              : 'No jobs.'}
          </p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th className="num">ID</th>
                  <th>Type</th>
                  <th className="num">Attempts</th>
                  <th>{view === 'available' ? 'Runs at' : 'Updated'}</th>
                  <th>{view === 'running' ? 'Worker' : 'Last error'}</th>
                  {view === 'dead' && <th />}
                </tr>
              </thead>
              <tbody>
                {jobs.data?.jobs.map((j) => (
                  <tr key={j.id}>
                    <td className="num">{j.id}</td>
                    <td>
                      <code>{j.type}</code>
                      <div className="url">{JSON.stringify(j.payload)}</div>
                    </td>
                    <td className="num">
                      {j.attempts}/{j.maxAttempts}
                    </td>
                    <td>{formatDateTime(view === 'available' ? j.runAt : j.updatedAt)}</td>
                    <td className={view === 'running' ? 'url' : 'error-text'}>
                      {view === 'running' ? j.lockedBy : (j.lastError ?? '')}
                    </td>
                    {view === 'dead' && (
                      <td className="row-actions">
                        <button
                          onClick={() => act(() => api.retryJob(j.id), `Job ${j.id} re-queued.`)}
                        >
                          Retry
                        </button>
                        <button
                          className="danger"
                          onClick={() => act(() => api.deleteJob(j.id), `Job ${j.id} deleted.`)}
                        >
                          Delete
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
