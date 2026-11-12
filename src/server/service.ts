// The one local service that owns durable storage. Binds to 127.0.0.1 only.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { Board } from '../core/board.ts';
import { openDb } from '../core/db.ts';
import { KanbanError } from '../core/errors.ts';
import type { Config } from '../core/config.ts';
import type { OpContext, Status } from '../core/types.ts';
import { STATUSES } from '../core/types.ts';
import { guard, readJson, send } from './http-util.ts';
import type { Guarded } from './http-util.ts';

export interface Req {
  method: string;
  params: string[];
  query: URLSearchParams;
  body: Record<string, unknown>;
  who: Guarded;
}
export type Handler = (r: Req) => unknown | Promise<unknown>;
export interface Route { method: string; pattern: RegExp; handler: Handler }

export interface Service {
  config: Config;
  board: Board;
  server: http.Server;
  port: number;
  url: string;
  routes: Route[];
  startedAt: string;
  features: string[];
  healthExtra: () => Record<string, unknown>;
  close: () => Promise<void>;
  onClose: (() => void)[];
}

const UI_DIR = path.join(import.meta.dirname, '..', '..', 'dist', 'ui');
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png' };

export function ctxFrom(r: Req, extra: Partial<OpContext> = {}): OpContext {
  const b = r.body;
  return {
    actor: r.who.actor,
    sessionId: (typeof b.sessionId === 'string' ? b.sessionId : null) ?? extra.sessionId ?? null,
    sourceNote: typeof b.sourceNote === 'string' ? b.sourceNote : extra.sourceNote,
    opId: typeof b.opId === 'string' ? b.opId : extra.opId,
    ...extra,
  };
}

const parseStatus = (s: string | null): Status[] | undefined => {
  if (!s) return undefined;
  const list = s.split(',').map((x) => x.trim()).filter(Boolean) as Status[];
  for (const x of list) if (!STATUSES.includes(x)) throw new KanbanError('validation', `Unknown status "${x}". Use one of ${STATUSES.join(', ')}`);
  return list;
};

function taskRoutes(svc: Service): Route[] {
  const b = svc.board;
  return [
    { method: 'GET', pattern: /^\/api\/health$/, handler: () => ({ ok: true, mode: svc.config.mode, dataDir: svc.config.dataDir, startedAt: svc.startedAt, settings: svc.config.settings, features: svc.features, ...svc.healthExtra() }) },
    { method: 'GET', pattern: /^\/api\/tasks$/, handler: (r) => ({
      tasks: b.listTasks({
        project: r.query.get('project') || undefined, status: parseStatus(r.query.get('status')), text: r.query.get('q') || undefined,
        includeArchived: r.query.get('archived') === 'all', archivedOnly: r.query.get('archived') === 'only', limit: Number(r.query.get('limit')) || undefined,
      }),
    }) },
    { method: 'POST', pattern: /^\/api\/tasks$/, handler: (r) => {
      const { opId: _o, sessionId: _s, sourceNote: _n, actor: _a, ...fields } = r.body;
      return b.createTask(fields as never, ctxFrom(r));
    } },
    { method: 'GET', pattern: /^\/api\/tasks\/([^/]+)$/, handler: (r) => b.context(r.params[0], Number(r.query.get('recent')) || 8) },
    { method: 'PATCH', pattern: /^\/api\/tasks\/([^/]+)$/, handler: (r) => {
      const body = r.body as Record<string, any>;
      return b.editTask(r.params[0], body.patch ?? {}, ctxFrom(r), {
        expectedRevision: body.expectedRevision, addFindings: body.addFindings, removeFindingIds: body.removeFindingIds,
        confirmDone: r.who.actor === 'user' ? !!body.confirmDone : false, completionEvidence: body.completionEvidence,
      });
    } },
    { method: 'POST', pattern: /^\/api\/tasks\/([^/]+)\/undo$/, handler: (r) => {
      if (r.who.actor !== 'user') throw new KanbanError('forbidden', 'Undo is a user correction');
      return b.undo(Number(r.body.activityId), ctxFrom(r));
    } },
    { method: 'GET', pattern: /^\/api\/activity$/, handler: (r) => ({
      activity: b.activity({ taskId: r.query.get('taskId') || undefined, sinceAt: r.query.get('since') || undefined, limit: Number(r.query.get('limit')) || 100 }),
    }) },
    { method: 'GET', pattern: /^\/api\/projects$/, handler: () => ({ projects: b.projects() }) },
    { method: 'GET', pattern: /^\/api\/export$/, handler: () => b.exportAll() },
  ];
}

export type Plugin = (svc: Service) => Route[] | void;

export async function startService(config: Config, plugins: Plugin[] = []): Promise<Service> {
  const db = openDb(config.dataDir, config.mode);
  const board = new Board(db, config.settings.timezone);
  const extraOrigins = (process.env.KANBAN_DEV_ORIGINS || '').split(',').filter(Boolean);
  const svc = { config, board, routes: [] as Route[], startedAt: new Date().toISOString(), onClose: [] as (() => void)[], features: [] as string[], healthExtra: () => ({}) } as unknown as Service;
  svc.routes.push(...taskRoutes(svc));
  for (const p of plugins) { const r = p(svc); if (r) svc.routes.push(...r); }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    try {
      if (!url.pathname.startsWith('/api/')) return serveStatic(url.pathname, res);
      const who = guard(req, svc.port, extraOrigins);
      const method = req.method || 'GET';
      for (const route of svc.routes) {
        if (route.method !== method) continue;
        const m = route.pattern.exec(url.pathname);
        if (!m) continue;
        const body = method === 'GET' ? {} : await readJson(req);
        const out = await route.handler({ method, params: m.slice(1).map(decodeURIComponent), query: url.searchParams, body, who });
        return send(res, 200, out ?? { ok: true });
      }
      throw new KanbanError('not_found', `No route ${method} ${url.pathname}`);
    } catch (e) {
      if (e instanceof KanbanError) return send(res, e.httpStatus, e.toJSON());
      console.error('[kanban] internal error', e);
      return send(res, 500, { error: { code: 'internal', message: (e as Error).message } });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => resolve());
  });
  svc.server = server;
  svc.port = (server.address() as AddressInfo).port;
  svc.url = `http://127.0.0.1:${svc.port}`;
  svc.close = async () => {
    for (const fn of svc.onClose) fn();
    await new Promise<void>((r) => server.close(() => r()));
    server.closeAllConnections?.();
    db.close();
  };
  return svc;
}

function serveStatic(pathname: string, res: http.ServerResponse) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  let file = path.join(UI_DIR, path.normalize(rel));
  if (!file.startsWith(UI_DIR)) { res.writeHead(400); return res.end(); }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(UI_DIR, 'index.html');
  if (!fs.existsSync(file)) {
    res.writeHead(503, { 'content-type': 'text/plain' });
    return res.end('UI not built. Run: npm run build:ui');
  }
  res.writeHead(200, {
    'content-type': MIME[path.extname(file)] || 'application/octet-stream',
    'x-frame-options': 'DENY',
    'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
  });
  fs.createReadStream(file).pipe(res);
}
