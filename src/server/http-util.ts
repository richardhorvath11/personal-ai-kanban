import type { IncomingMessage, ServerResponse } from 'node:http';
import { KanbanError } from '../core/errors.ts';
import type { Actor } from '../core/types.ts';

export const MAX_BODY = 1_000_000;

export async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new KanbanError('validation', 'Request body too large');
    chunks.push(c as Buffer);
  }
  if (!size) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
    return v;
  } catch {
    throw new KanbanError('validation', 'Body must be a JSON object');
  }
}

export function send(res: ServerResponse, status: number, body: unknown) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(data);
}

export interface Guarded { actor: Actor; browser: boolean }

/**
 * Loopback + origin guard.
 * - Host must be our loopback host:port (blocks DNS-rebinding).
 * - A request carrying an Origin must come from our own UI origin.
 * - A request without Origin is a non-browser client; mutations must declare x-kanban-client and use JSON.
 */
export function guard(req: IncomingMessage, port: number, extraOrigins: string[] = []): Guarded {
  const host = (req.headers.host || '').toLowerCase();
  const okHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (!okHosts.includes(host)) throw new KanbanError('forbidden', `Unexpected Host header "${host}"`);
  const origin = req.headers.origin;
  const allowed = [`http://127.0.0.1:${port}`, `http://localhost:${port}`, ...extraOrigins];
  const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(req.method || 'GET');
  if (origin) {
    if (!allowed.includes(origin)) throw new KanbanError('forbidden', `Origin ${origin} is not allowed`);
    if (mutating && !(req.headers['content-type'] || '').includes('application/json')) throw new KanbanError('forbidden', 'Mutations must be JSON');
    return { actor: 'user', browser: true };
  }
  const client = String(req.headers['x-kanban-client'] || '');
  if (mutating) {
    if (!client) throw new KanbanError('forbidden', 'Non-browser mutations must send an x-kanban-client header');
    if (!(req.headers['content-type'] || '').includes('application/json')) throw new KanbanError('forbidden', 'Mutations must be JSON');
  }
  // Sec-Fetch-Site from a browser without Origin (rare) is still treated as untrusted for writes.
  if (mutating && req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin') {
    throw new KanbanError('forbidden', 'Cross-site request rejected');
  }
  const actor: Actor = client === 'mcp' ? 'claude' : client === 'hook' ? 'hook' : client === 'system' ? 'system' : 'user';
  return { actor, browser: false };
}
