// Small HTTP client used by the MCP adapter, hooks and CLI. Never talks to anything but loopback.
import { serviceUrl } from './config.ts';

export class ServiceUnavailable extends Error {}
export class ServiceError extends Error {
  status: number;
  code: string;
  details: unknown;
  constructor(status: number, code: string, message: string, details: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export interface ClientOptions { baseUrl?: string; client: 'mcp' | 'hook' | 'cli' | 'system'; timeoutMs?: number }

export class KanbanClient {
  baseUrl: string;
  client: string;
  timeoutMs: number;
  constructor(opts: ClientOptions) {
    this.baseUrl = (opts.baseUrl ?? serviceUrl()).replace(/\/$/, '');
    if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(this.baseUrl)) throw new Error(`Refusing non-loopback service URL ${this.baseUrl}`);
    this.client = opts.client;
    this.timeoutMs = opts.timeoutMs ?? 4000;
  }

  async request<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.baseUrl + path, {
        method,
        headers: { 'x-kanban-client': this.client, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new ServiceUnavailable(`Kanban service at ${this.baseUrl} is unreachable (${(e as Error).name === 'TimeoutError' ? 'timeout' : (e as Error).message})`);
    }
    const text = await res.text();
    let json: any = {};
    try { json = text ? JSON.parse(text) : {}; } catch { json = { error: { code: 'bad_response', message: text.slice(0, 200) } }; }
    if (!res.ok) {
      if (res.status >= 500 && res.status !== 503) throw new ServiceUnavailable(`Kanban service error ${res.status}: ${json?.error?.message ?? ''}`);
      throw new ServiceError(res.status, json?.error?.code ?? 'error', json?.error?.message ?? `HTTP ${res.status}`, json?.error?.details);
    }
    return json as T;
  }
  get<T = any>(p: string) { return this.request<T>('GET', p); }
  post<T = any>(p: string, b: unknown) { return this.request<T>('POST', p, b); }
  patch<T = any>(p: string, b: unknown) { return this.request<T>('PATCH', p, b); }
}
