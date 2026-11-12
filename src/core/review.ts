// Deterministic background review and "what next" recommendations. No model calls.
import type { Board } from './board.ts';
import type { Settings } from './config.ts';
import type { Task } from './types.ts';
import { daysUntil, describeDue, isPast, todayIn } from './dates.ts';

export type AlertKind = 'overdue' | 'deadline_soon' | 'followup_due' | 'blocked' | 'unblocked' | 'stale' | 'review_pending' | 'pin_conflict';
export const KIND_LABEL: Record<AlertKind, string> = {
  overdue: 'Overdue', deadline_soon: 'Deadline soon', followup_due: 'Follow-up due', blocked: 'Blocked', unblocked: 'Unblocked',
  stale: 'Neglected', review_pending: 'Awaiting review', pin_conflict: 'Pin conflict',
};
const SEVERITY: Record<AlertKind, number> = { overdue: 0, pin_conflict: 1, deadline_soon: 1, followup_due: 2, review_pending: 3, unblocked: 3, stale: 4, blocked: 5 };

export interface Finding { taskId: string; kind: AlertKind; message: string; severity: string }

const daysSince = (iso: string, now: Date) => (now.getTime() - new Date(iso).getTime()) / 86400_000;
const open = (t: Task) => !t.archived && t.status !== 'done';

export function unfinishedDeps(board: Board, t: Task): Task[] {
  return t.dependsOn.map((d) => board.getTaskOrNull(d)).filter((d): d is Task => !!d && d.status !== 'done');
}
export function dependents(board: Board, id: string): Task[] {
  return (board.db.prepare('SELECT task_id FROM deps WHERE depends_on = ?').all(id) as { task_id: string }[])
    .map((r) => board.getTaskOrNull(r.task_id)).filter((t): t is Task => !!t && open(t));
}
const firmSoon = (t: Task, s: Settings, now: Date) => !!t.deadline && t.deadlineKind === 'firm' && daysUntil(t.deadline, t.deadlineTz || s.timezone, now) <= s.deadlineSoonDays;

export function evaluate(board: Board, s: Settings, now = new Date()): Finding[] {
  const tasks = board.listTasks({ limit: 1000 }).filter(open);
  const out: Finding[] = [];
  const tzOf = (t: Task) => t.deadlineTz || s.timezone;
  for (const t of tasks) {
    if (t.deadline && isPast(t.deadline, tzOf(t), now)) out.push({ taskId: t.id, kind: 'overdue', severity: 'high', message: `${t.deadlineKind === 'firm' ? 'Firm deadline' : 'Target'} ${describeDue(t.deadline, tzOf(t), now)} has passed${t.deadlineLabel ? ` (${t.deadlineLabel})` : ''}.` });
    else if (t.deadline && daysUntil(t.deadline, tzOf(t), now) <= (t.deadlineKind === 'firm' ? s.deadlineSoonDays : 1)) {
      out.push({ taskId: t.id, kind: 'deadline_soon', severity: t.deadlineKind === 'firm' ? 'high' : 'normal', message: `${t.deadlineKind === 'firm' ? 'Firm deadline' : 'Flexible target'} ${describeDue(t.deadline, tzOf(t), now)}${t.deadlineLabel ? ` — ${t.deadlineLabel}` : ''}. Status: ${t.status.replace('_', ' ')}.` });
    }
    if (t.status === 'waiting') {
      const due = t.followUpAt && (t.followUpAt.length === 10 ? t.followUpAt <= todayIn(s.timezone, now) : new Date(t.followUpAt) <= now);
      if (due) out.push({ taskId: t.id, kind: 'followup_due', severity: 'normal', message: `Follow-up due ${t.followUpAt!.slice(0, 10)}: check on "${t.waitingReason}"${t.followUpCondition ? ` (${t.followUpCondition})` : ''}. This is a reminder to check — nothing is sent to anyone automatically.` });
      const deps = unfinishedDeps(board, t);
      if (t.waitingOn === 'dependency' && t.dependsOn.length && !deps.length) out.push({ taskId: t.id, kind: 'unblocked', severity: 'normal', message: `All dependencies are done; "${t.title}" can resume.` });
      else out.push({ taskId: t.id, kind: 'blocked', severity: 'info', message: `Waiting: ${t.waitingReason}${deps.length ? ` (open dependencies: ${deps.map((d) => d.id).join(', ')})` : ''}. Time passing does not resolve this; check it when the follow-up is due.` });
    } else if ((t.status === 'ready' || t.status === 'in_progress') && unfinishedDeps(board, t).length) {
      const deps = unfinishedDeps(board, t);
      out.push({ taskId: t.id, kind: 'blocked', severity: 'info', message: `Blocked by ${deps.map((d) => `${d.id} "${d.title}" (${d.status.replace('_', ' ')})`).join(', ')}.` });
    }
    const idle = daysSince(t.lastMeaningfulAt, now);
    if (t.status === 'in_progress' && idle >= s.staleDays) out.push({ taskId: t.id, kind: 'stale', severity: 'normal', message: `In progress but no meaningful progress for ${Math.floor(idle)} days (last: ${t.lastMeaningfulAt.slice(0, 10)}${t.lastSyncedAt && t.lastSyncedAt > t.lastMeaningfulAt ? `; sessions have synced since, which does not count as progress` : ''}).` });
    if (t.status === 'review' && idle >= s.reviewPendingDays) out.push({ taskId: t.id, kind: 'review_pending', severity: 'normal', message: `Ready for your review for ${Math.floor(idle)} days.` });
  }
  // Pin vs commitment conflicts: flag, never override.
  const pinned = tasks.filter((t) => t.pinned && t.status !== 'waiting');
  for (const t of tasks) {
    if (t.pinned || !firmSoon(t, s, now)) continue;
    const ahead = pinned.filter((p) => !(p.deadline && p.deadlineKind === 'firm' && daysUntil(p.deadline, tzOf(p), now) <= daysUntil(t.deadline!, tzOf(t), now)));
    if (ahead.length) out.push({ taskId: t.id, kind: 'pin_conflict', severity: 'high', message: `Your pinned ${ahead.map((p) => `${p.id} "${p.title}"`).join(', ')} ${ahead.length > 1 ? 'are' : 'is'} ordered ahead of this firm commitment due ${describeDue(t.deadline!, tzOf(t), now)}. The pin is kept; unpin or reorder if the deadline should win.` });
  }
  return out.sort((a, b) => SEVERITY[a.kind] - SEVERITY[b.kind]);
}

/** Persist findings as consolidated alerts. `bump` counts a scheduled review pass. */
export function syncAlerts(board: Board, findings: Finding[], now = new Date(), bump = false) {
  const ts = now.toISOString();
  const db = board.db;
  const seen = new Set<string>();
  for (const f of findings) {
    seen.add(`${f.taskId}|${f.kind}`);
    const ex = db.prepare('SELECT id, resolved_at FROM alerts WHERE task_id = ? AND kind = ?').get(f.taskId, f.kind) as { id: number; resolved_at: string | null } | undefined;
    if (!ex) db.prepare('INSERT INTO alerts(task_id, kind, severity, message, first_seen, last_seen) VALUES (?,?,?,?,?,?)').run(f.taskId, f.kind, f.severity, f.message, ts, ts);
    else if (ex.resolved_at) db.prepare('UPDATE alerts SET resolved_at = NULL, message = ?, severity = ?, first_seen = ?, last_seen = ?, count = 1, snoozed_until = NULL WHERE id = ?').run(f.message, f.severity, ts, ts, ex.id);
    else db.prepare(`UPDATE alerts SET message = ?, severity = ?, last_seen = ?${bump ? ', count = count + 1' : ''} WHERE id = ?`).run(f.message, f.severity, ts, ex.id);
  }
  for (const a of db.prepare('SELECT id, task_id, kind FROM alerts WHERE resolved_at IS NULL').all() as { id: number; task_id: string; kind: string }[]) {
    if (!seen.has(`${a.task_id}|${a.kind}`)) db.prepare('UPDATE alerts SET resolved_at = ? WHERE id = ?').run(ts, a.id);
  }
}

export function attention(board: Board, now = new Date(), project?: string) {
  const rows = board.db.prepare('SELECT * FROM alerts WHERE resolved_at IS NULL AND (snoozed_until IS NULL OR snoozed_until <= ?) ORDER BY id').all(now.toISOString()) as Record<string, any>[];
  const items = rows.map((r) => {
    const t = board.getTaskOrNull(r.task_id);
    return { id: r.id as number, taskId: r.task_id as string, title: t?.title ?? '', project: t?.project ?? '', kind: r.kind as AlertKind, kindLabel: KIND_LABEL[r.kind as AlertKind], severity: r.severity, message: r.message, count: r.count, firstSeen: r.first_seen, lastSeen: r.last_seen };
  }).filter((i) => !project || i.project === project);
  items.sort((a, b) => SEVERITY[a.kind] - SEVERITY[b.kind] || a.id - b.id);
  const snoozed = (board.db.prepare('SELECT COUNT(*) AS n FROM alerts WHERE resolved_at IS NULL AND snoozed_until > ?').get(now.toISOString()) as { n: number }).n;
  return { items, snoozed };
}

export interface Recommendation { task: Pick<Task, 'id' | 'title' | 'status' | 'project' | 'nextAction' | 'deadline' | 'pinned'>; headline: string; reasons: string[]; rank: number }

export function recommend(board: Board, s: Settings, now = new Date(), project?: string) {
  const tasks = board.listTasks({ project, limit: 1000 }).filter(open);
  const tzOf = (t: Task) => t.deadlineTz || s.timezone;
  const blocked: { task: Recommendation['task']; reason: string }[] = [];
  const cands: { t: Task; key: number[]; reasons: string[]; headline: string; informative: boolean }[] = [];
  const brief = (t: Task) => ({ id: t.id, title: t.title, status: t.status, project: t.project, nextAction: t.nextAction, deadline: t.deadline, pinned: t.pinned });
  for (const t of tasks) {
    if (t.status === 'waiting') { blocked.push({ task: brief(t), reason: `Waiting: ${t.waitingReason}` }); continue; }
    if (t.status !== 'ready' && t.status !== 'in_progress') continue;
    const deps = unfinishedDeps(board, t);
    if (deps.length) { blocked.push({ task: brief(t), reason: `Blocked by ${deps.map((d) => `${d.id} "${d.title}"`).join(', ')}` }); continue; }
    const reasons: string[] = [];
    let informative = false;
    const verb = t.status === 'in_progress' ? 'Finish' : 'Start';
    let headline = `${verb} "${t.title}"`;
    const own = t.deadline ? daysUntil(t.deadline, tzOf(t), now) : Infinity;
    // Dependents that need this task, with their commitments.
    const needs = dependents(board, t.id).map((d) => ({ d, days: d.deadline ? daysUntil(d.deadline, tzOf(d), now) : Infinity }));
    const urgentDep = needs.filter((n) => (n.d.deadlineKind === 'firm' && n.days < Infinity) || n.d.pinned || n.d.priority === 'high').sort((a, b) => a.days - b.days)[0];
    if (t.pinned) { reasons.push('Pinned by you — your explicit priority is kept first.'); informative = true; }
    if (t.deadline) {
      reasons.push(`${t.deadlineKind === 'firm' ? 'Firm deadline' : 'Flexible target'} ${describeDue(t.deadline, tzOf(t), now)}${t.deadlineLabel ? ` — ${t.deadlineLabel}` : ''}.`);
      informative = true;
      if (t.deadlineKind === 'firm') headline += `: due ${describeDue(t.deadline, tzOf(t), now)}${t.deadlineLabel ? ` for ${t.deadlineLabel}` : ''}`;
    }
    if (urgentDep) {
      const d = urgentDep.d;
      const what = d.deadline ? `${d.deadlineLabel || `its ${d.deadlineKind} deadline`}, due ${describeDue(d.deadline, tzOf(d), now)}` : d.pinned ? 'your pinned work' : 'high-priority work';
      reasons.push(`Unblocks ${d.id} "${d.title}", needed for ${what}.`);
      informative = true;
      if (!(t.deadline && t.deadlineKind === 'firm')) headline += `: it unblocks "${d.title}" needed for ${d.deadlineLabel || (d.deadline ? `its deadline ${d.deadline}` : what)}`;
    }
    if (t.priority === 'high') { reasons.push(`Marked high priority${t.priorityContext ? `: ${t.priorityContext}` : '.'}`); informative = true; }
    if (t.priority === 'low') reasons.push('Marked low priority.');
    if (t.status === 'in_progress') reasons.push(`Already in progress — last meaningful progress ${todayIn(s.timezone, new Date(t.lastMeaningfulAt))}.`);
    if (t.nextAction) reasons.push(`Next action: ${t.nextAction}`);
    const effective = Math.min(t.deadlineKind === 'firm' ? own : Infinity, urgentDep && urgentDep.d.deadlineKind === 'firm' ? urgentDep.days : Infinity);
    // Ordered rule tuple (no invented scores): pin → firm commitment window → unblocks important → high priority → in progress → board order.
    const key = [t.pinned ? 0 : 1, t.pinned ? t.position : 0, effective <= s.deadlineSoonDays ? effective : 1e6, urgentDep ? 0 : 1, t.priority === 'high' ? 0 : t.priority === 'normal' ? 1 : 2, effective, t.status === 'in_progress' ? 0 : 1, t.position];
    cands.push({ t, key, reasons, headline: headline + '.', informative });
  }
  cands.sort((a, b) => { for (let i = 0; i < a.key.length; i++) if (a.key[i] !== b.key[i]) return a.key[i] - b.key[i]; return 0; });
  const conflicts = evaluate(board, s, now).filter((f) => f.kind === 'pin_conflict' && (!project || board.getTaskOrNull(f.taskId)?.project === project)).map((f) => ({ taskId: f.taskId, message: f.message }));
  const informative = cands.some((c) => c.informative);
  return {
    recommendations: cands.slice(0, 10).map((c, i) => ({ task: brief(c.t), headline: c.headline, reasons: c.reasons.length ? c.reasons : ['Ready to start; no deadline, priority or dependency recorded.'], rank: i + 1 })),
    blocked,
    conflicts,
    note: !cands.length ? null : informative ? null : 'Not enough context to rank by urgency: no deadlines, priorities, pins or dependencies are recorded. Showing ready work in board order.',
    evaluatedAt: now.toISOString(),
  };
}
