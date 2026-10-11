export type MonitorStatus = 'pending' | 'up' | 'down';
export type JobStatus = 'available' | 'running' | 'succeeded' | 'dead';

export interface Monitor {
  id: number;
  name: string;
  url: string;
  intervalSeconds: number;
  timeoutMs: number;
  failureThreshold: number;
  certWarnDays: number;
  hasWebhook: boolean;
  enabled: boolean;
  status: MonitorStatus;
  consecutiveFailures: number;
  lastCheckedAt: string | null;
  lastStatusCode: number | null;
  lastResponseMs: number | null;
  lastError: string | null;
  certExpiresAt: string | null;
  nextCheckAt: string;
  createdAt: string;
}

export interface CheckResult {
  checkedAt: string;
  ok: boolean;
  statusCode: number | null;
  responseMs: number | null;
  error: string | null;
}

export interface Incident {
  id: number;
  openedAt: string;
  resolvedAt: string | null;
  cause: string | null;
}

export interface Alert {
  id: number;
  kind: 'down' | 'recovered' | 'cert_expiring';
  message: string;
  createdAt: string;
  sentAt: string | null;
  skippedReason: string | null;
}

export interface MonitorDetail {
  monitor: Monitor;
  checks: CheckResult[];
  incidents: Incident[];
  alerts: Alert[];
}

export interface QueueStats {
  byStatus: Record<JobStatus, number>;
  byType: { type: string; status: JobStatus; count: number }[];
  oldestAvailableAgeSeconds: number | null;
}

export interface Job {
  id: number;
  type: string;
  payload: unknown;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  runAt: string;
  lockedBy: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export interface MonitorInput {
  name: string;
  url: string;
  intervalSeconds?: number;
  failureThreshold?: number;
  certWarnDays?: number;
  webhookUrl?: string | null;
  enabled?: boolean;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data as T;
}

export const api = {
  listMonitors: () => request<{ monitors: Monitor[] }>('GET', '/api/monitors'),
  getMonitor: (id: number) => request<MonitorDetail>('GET', `/api/monitors/${id}`),
  createMonitor: (input: MonitorInput) =>
    request<{ monitor: Monitor }>('POST', '/api/monitors', input),
  updateMonitor: (id: number, input: Partial<MonitorInput>) =>
    request<{ monitor: Monitor }>('PATCH', `/api/monitors/${id}`, input),
  deleteMonitor: (id: number) => request<void>('DELETE', `/api/monitors/${id}`),
  checkNow: (id: number) =>
    request<{ jobId: number | null; alreadyQueued: boolean }>('POST', `/api/monitors/${id}/check`),
  queueStats: () => request<QueueStats>('GET', '/api/queue/stats'),
  listJobs: (status: JobStatus) =>
    request<{ jobs: Job[] }>('GET', `/api/queue/jobs?status=${status}&limit=100`),
  retryJob: (id: number) => request<{ ok: true }>('POST', `/api/queue/jobs/${id}/retry`),
  deleteJob: (id: number) => request<void>('DELETE', `/api/queue/jobs/${id}`),
};
