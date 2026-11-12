import type { Plugin } from './service.ts';
import { ctxFrom } from './service.ts';
import { Sessions } from '../core/sessions.ts';
import { KanbanError } from '../core/errors.ts';

export const sessionsPlugin: Plugin = (svc) => {
  const sessions = new Sessions(svc.board);
  (svc as any).sessions = sessions;
  svc.features.push('sessions');
  const prev = svc.healthExtra;
  svc.healthExtra = () => ({ ...prev(), sessions: sessions.activeSummary() });
  const str = (v: unknown, name: string) => { if (typeof v !== 'string' || !v.trim()) throw new KanbanError('validation', `${name} is required`); return v.trim(); };
  return [
    { method: 'POST', pattern: /^\/api\/sessions\/start$/, handler: (r) => {
      const b = r.body as Record<string, string>;
      const s = sessions.upsert({ sessionId: str(b.sessionId, 'sessionId'), repo: b.repo, cwd: b.cwd, worktree: b.worktree, source: b.source });
      return sessions.context(s.id, { repo: s.repo });
    } },
    { method: 'POST', pattern: /^\/api\/sessions\/link$/, handler: (r) => sessions.link(r.body as any, ctxFrom(r)) },
    { method: 'POST', pattern: /^\/api\/sessions\/checkpoint$/, handler: (r) => {
      const { opId: _o, sourceNote: _s, ...rest } = r.body;
      return sessions.checkpoint(rest, ctxFrom(r));
    } },
    { method: 'GET', pattern: /^\/api\/sessions\/([^/]+)\/context$/, handler: (r) => sessions.context(r.params[0], { repo: r.query.get('repo') || undefined }) },
    { method: 'POST', pattern: /^\/api\/sessions\/([^/]+)\/heartbeat$/, handler: (r) => sessions.heartbeat(r.params[0]) },
    { method: 'POST', pattern: /^\/api\/sessions\/([^/]+)\/end$/, handler: (r) => sessions.end(r.params[0], String(r.body.reason ?? 'other')) },
  ];
};
