// Background review (deadlines, follow-ups, stale work, pending reviews, pin conflicts) + next-work view.
import type { Plugin } from './service.ts';
import { KanbanError } from '../core/errors.ts';
import { attention, evaluate, KIND_LABEL, recommend, syncAlerts, unfinishedDeps, dependents } from '../core/review.ts';
import { resolveDate } from '../core/dates.ts';
import type { Task } from '../core/types.ts';

export const attentionPlugin: Plugin = (svc) => {
  const { board, config } = svc;
  const s = config.settings;
  svc.features.push('attention');
  let lastReviewAt: string | null = null;

  const at = (q: URLSearchParams) => {
    const v = q.get('at');
    if (!v) return null;
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) throw new KanbanError('validation', 'at must be an ISO datetime');
    return d;
  };

  const runReview = (bump: boolean) => {
    const now = new Date();
    const f = evaluate(board, s, now);
    board.tx(() => {
      syncAlerts(board, f, now, bump);
      if (bump) board.db.prepare('INSERT INTO review_runs(at, evaluated_at, alerts) VALUES (?,?,?)').run(new Date().toISOString(), now.toISOString(), f.length);
    });
    if (bump) lastReviewAt = now.toISOString();
    return f;
  };
  const last = board.db.prepare('SELECT MAX(at) AS at FROM review_runs').get() as { at: string | null };
  lastReviewAt = last.at;
  queueMicrotask(() => runReview(true)); // catch up on start (the laptop may have been closed)
  const timer = setInterval(() => runReview(true), Math.max(1, s.reviewIntervalMinutes) * 60_000);
  timer.unref();
  svc.onClose.push(() => clearInterval(timer));

  // When a dependency completes, re-evaluate readiness of tasks waiting on it.
  const prev = board.afterChange;
  board.afterChange = (task: Task, before: Task | null, ctx) => {
    prev?.(task, before, ctx);
    if (task.status !== 'done' || before?.status === 'done') return;
    for (const d of dependents(board, task.id)) {
      if (d.status === 'waiting' && d.waitingOn === 'dependency' && !unfinishedDeps(board, d).length) {
        board.applyEdit(d.id, { status: 'ready' }, { actor: 'system', sourceNote: `dependency ${task.id} completed` }, { kind: 'edit', summaryNote: `Ready: dependency ${task.id} "${task.title}" completed` });
      }
    }
  };

  return [
    { method: 'GET', pattern: /^\/api\/next$/, handler: (r) => recommend(board, s, at(r.query) ?? new Date(), r.query.get('project') || undefined) },
    { method: 'GET', pattern: /^\/api\/attention$/, handler: (r) => {
      const when = at(r.query);
      if (when) { // read-only preview at another time
        const items = evaluate(board, s, when).map((f, i) => ({ id: -1 - i, ...f, kindLabel: KIND_LABEL[f.kind], count: 1, title: board.getTaskOrNull(f.taskId)?.title ?? '' }));
        return { items, snoozed: 0, lastReviewAt, previewAt: when.toISOString() };
      }
      runReview(false);
      return { ...attention(board, new Date(), r.query.get('project') || undefined), lastReviewAt };
    } },
    { method: 'POST', pattern: /^\/api\/review\/run$/, handler: () => ({ findings: runReview(true).length, lastReviewAt }) },
    { method: 'POST', pattern: /^\/api\/alerts\/(\d+)\/snooze$/, handler: (r) => {
      if (r.who.actor !== 'user') throw new KanbanError('forbidden', 'Only the user can snooze alerts');
      const hours = Number(r.body.hours ?? 24);
      if (!(hours > 0 && hours <= 24 * 60)) throw new KanbanError('validation', 'hours must be between 0 and 1440');
      const until = new Date(Date.now() + hours * 3600_000).toISOString();
      const res = board.db.prepare('UPDATE alerts SET snoozed_until = ? WHERE id = ? AND resolved_at IS NULL').run(until, Number(r.params[0]));
      if (!res.changes) throw new KanbanError('not_found', 'No open alert with that id');
      return { snoozedUntil: until };
    } },
    { method: 'GET', pattern: /^\/api\/resolve-date$/, handler: (r) => resolveDate(r.query.get('text') ?? '', r.query.get('tz') || s.timezone) },
  ];
};
