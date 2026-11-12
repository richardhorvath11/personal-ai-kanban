import type { ActivityEntry, Task } from '../core/types.ts';

export class ApiError extends Error {
  status: number;
  code: string;
  details: any;
  constructor(status: number, code: string, message: string, details: any) { super(message); this.status = status; this.code = code; this.details = details; }
}

export const opId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { method, headers: body !== undefined ? { 'content-type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch {
    throw new ApiError(0, 'offline', 'Cannot reach the board service. Is it running? (npm start)', null);
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, json?.error?.code ?? 'error', json?.error?.message ?? `HTTP ${res.status}`, json?.error?.details);
  return json as T;
}

export interface Context { task: Task; dependencies: { id: string; title: string; status: string | null; done: boolean }[]; dependents: { id: string; title: string; status: string }[]; recentActivity: ActivityEntry[] }

export const api = {
  health: () => req<any>('GET', '/api/health'),
  tasks: (q: Record<string, string> = {}) => req<{ tasks: Task[] }>('GET', `/api/tasks?${new URLSearchParams(q)}`),
  projects: () => req<{ projects: string[] }>('GET', '/api/projects'),
  context: (id: string) => req<Context>('GET', `/api/tasks/${encodeURIComponent(id)}?recent=100`),
  create: (fields: Partial<Task> & { title: string }) => req<{ task: Task }>('POST', '/api/tasks', { opId: opId(), ...fields }),
  edit: (id: string, expectedRevision: number, patch: Partial<Task>, extra: Record<string, unknown> = {}) =>
    req<{ task: Task }>('PATCH', `/api/tasks/${encodeURIComponent(id)}`, { opId: opId(), expectedRevision, patch, ...extra }),
  undo: (id: string, activityId: number) => req<{ task: Task; reverted: string[]; skipped: { field: string; reason: string }[] }>('POST', `/api/tasks/${encodeURIComponent(id)}/undo`, { opId: opId(), activityId }),
  activity: (since?: string) => req<{ activity: ActivityEntry[] }>('GET', `/api/activity?${new URLSearchParams(since ? { since, limit: '300' } : { limit: '300' })}`),
  get: <T = any>(path: string) => req<T>('GET', path),
  post: <T = any>(path: string, body: unknown) => req<T>('POST', path, body),
};
