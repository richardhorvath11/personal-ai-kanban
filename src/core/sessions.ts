// Session ↔ task association and checkpoints.
import * as z from 'zod';
import type { Board } from './board.ts';
import { nowIso } from './board.ts';
import { KanbanError } from './errors.ts';
import { STATUSES } from './types.ts';
import type { OpContext, Task } from './types.ts';

export interface SessionRow {
  id: string; repo: string; cwd: string; worktree: string; source: string; current_task_id: string | null;
  started_at: string; last_seen_at: string; ended_at: string | null; end_reason: string | null;
  last_checkpoint_at: string | null; last_checkpoint_task: string | null;
}

const sid = z.string().trim().min(1).max(200);
export const CheckpointInput = z.object({
  sessionId: sid,
  taskId: z.string().trim().optional(),
  summary: z.string().trim().min(1, 'summary is required: what meaningful progress happened').max(4000),
  nextAction: z.string().trim().max(1000).optional(),
  findings: z.array(z.string().trim().min(1).max(2000)).max(20).optional(),
  links: z.array(z.object({ url: z.string().min(1).max(2000), label: z.string().max(300).optional() })).max(20).optional(),
  checklistDone: z.array(z.string()).max(50).optional(), // checklist item ids or exact texts
  status: z.enum(STATUSES).optional(),
  waitingReason: z.string().max(1000).optional(),
  completionEvidence: z.string().max(4000).optional(),
  expectedRevision: z.number().int().optional(),
}).strict();
export type CheckpointInputT = z.infer<typeof CheckpointInput>;

const compact = (t: Task) => ({ id: t.id, title: t.title, project: t.project, status: t.status, nextAction: t.nextAction, revision: t.revision });

export class Sessions {
  board: Board;
  constructor(board: Board) { this.board = board; }
  get db() { return this.board.db; }

  get(id: string): SessionRow | null {
    return (this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as unknown as SessionRow) ?? null;
  }
  require(id: string): SessionRow {
    const s = this.get(id);
    if (!s) throw new KanbanError('not_found', `Unknown session ${id}. Call link_session (or start a session with the SessionStart hook) first.`);
    return s;
  }
  linkedTaskIds(id: string): string[] {
    return (this.db.prepare('SELECT task_id FROM session_tasks WHERE session_id = ? ORDER BY linked_at').all(id) as { task_id: string }[]).map((r) => r.task_id);
  }

  /** Register / refresh a session (idempotent upsert). Never touches task status. */
  upsert(input: { sessionId: string; repo?: string; cwd?: string; worktree?: string; source?: string }): SessionRow {
    const id = sid.parse(input.sessionId);
    const ts = nowIso();
    const ex = this.get(id);
    if (!ex) {
      this.db.prepare('INSERT INTO sessions(id, repo, cwd, worktree, source, started_at, last_seen_at) VALUES (?,?,?,?,?,?,?)')
        .run(id, input.repo ?? '', input.cwd ?? '', input.worktree ?? '', input.source ?? '', ts, ts);
    } else {
      this.db.prepare('UPDATE sessions SET repo = COALESCE(NULLIF(?, \'\'), repo), cwd = COALESCE(NULLIF(?, \'\'), cwd), worktree = COALESCE(NULLIF(?, \'\'), worktree), source = COALESCE(NULLIF(?, \'\'), source), last_seen_at = ?, ended_at = NULL, end_reason = NULL WHERE id = ?')
        .run(input.repo ?? '', input.cwd ?? '', input.worktree ?? '', input.source ?? '', ts, id);
    }
    return this.get(id)!;
  }

  link(input: { sessionId: string; taskIds?: string[]; currentTaskId?: string | null; repo?: string; cwd?: string; worktree?: string }, ctx: OpContext) {
    return this.board.idempotent(ctx.opId, 'link_session', () => {
      const s = this.upsert(input);
      const ids = [...new Set([...(input.taskIds ?? []), ...(input.currentTaskId ? [input.currentTaskId] : [])].map((x) => x.trim().toUpperCase()))];
      for (const t of ids) this.board.getTask(t); // validate every target exists
      const before = this.linkedTaskIds(s.id);
      for (const t of ids) if (!before.includes(t)) {
        this.db.prepare('INSERT INTO session_tasks(session_id, task_id, linked_at) VALUES (?,?,?)').run(s.id, t, nowIso());
      }
      let current = s.current_task_id;
      if (input.currentTaskId !== undefined) current = input.currentTaskId ? input.currentTaskId.toUpperCase() : null;
      else if (!current && ids.length === 1) current = ids[0];
      if (current !== s.current_task_id) {
        this.db.prepare('UPDATE sessions SET current_task_id = ? WHERE id = ?').run(current, s.id);
      }
      const linked = this.linkedTaskIds(s.id);
      return { session: { id: s.id, currentTaskId: current, linkedTaskIds: linked, switchedFrom: current !== s.current_task_id ? s.current_task_id : undefined }, taskId: current ?? undefined };
    });
  }

  /** Decide which card a checkpoint targets. Never guesses from titles or the repo directory. */
  resolveTarget(s: SessionRow, explicit?: string): string {
    if (explicit) return this.board.getTask(explicit.toUpperCase()).id;
    if (s.current_task_id) return s.current_task_id;
    const linked = this.linkedTaskIds(s.id);
    if (linked.length === 1) return linked[0];
    const candidates = linked.map((id) => this.board.getTaskOrNull(id)).filter(Boolean).map((t) => compact(t!));
    throw new KanbanError('ambiguous_target', linked.length
      ? `Session ${s.id} is linked to ${linked.length} tasks and none is current. Ask the user which task this work belongs to, then call link_session with currentTaskId.`
      : `Session ${s.id} is not linked to any task. Find or create the task, then call link_session with currentTaskId (ask the user if more than one plausibly matches).`, { candidates });
  }

  checkpoint(raw: unknown, ctx: OpContext) {
    const parsed = CheckpointInput.safeParse(raw);
    if (!parsed.success) throw new KanbanError('validation', z.prettifyError(parsed.error));
    const c = parsed.data;
    return this.board.idempotent(ctx.opId, 'checkpoint', () => {
      const s = this.get(c.sessionId) ?? this.upsert({ sessionId: c.sessionId });
      const taskId = this.resolveTarget(s, c.taskId);
      if (!this.linkedTaskIds(s.id).includes(taskId)) this.db.prepare('INSERT INTO session_tasks(session_id, task_id, linked_at) VALUES (?,?,?)').run(s.id, taskId, nowIso());
      const task = this.board.getTask(taskId);
      const patch: Record<string, unknown> = { summary: c.summary };
      if (c.nextAction !== undefined) patch.nextAction = c.nextAction;
      if (c.status) patch.status = c.status;
      if (c.waitingReason !== undefined) patch.waitingReason = c.waitingReason;
      if (c.links?.length) patch.links = [...task.links, ...c.links.filter((l) => !task.links.some((x) => x.url === l.url)).map((l) => ({ url: l.url, label: l.label ?? '' }))];
      if (c.checklistDone?.length) {
        patch.checklist = task.checklist.map((i) => (c.checklistDone!.includes(i.id) || c.checklistDone!.includes(i.text) ? { ...i, done: true } : i));
      }
      const r = this.board.applyEdit(taskId, patch, { ...ctx, sessionId: s.id }, {
        kind: 'checkpoint', addFindings: c.findings, completionEvidence: c.completionEvidence, expectedRevision: c.expectedRevision,
        summaryNote: c.summary.length > 300 ? c.summary.slice(0, 297) + '…' : c.summary,
      });
      const ts = nowIso();
      this.db.prepare('UPDATE sessions SET last_checkpoint_at = ?, last_checkpoint_task = ?, last_seen_at = ? WHERE id = ?').run(ts, taskId, ts, s.id);
      this.db.prepare('UPDATE tasks SET last_synced_at = ? WHERE id = ?').run(ts, taskId);
      return { task: this.board.getTask(taskId), checkpointAt: ts, sessionId: s.id, activityId: r.activityId };
    });
  }

  /** Response-boundary heartbeat: proves the session is alive. Not meaningful progress. */
  heartbeat(sessionId: string) {
    const s = this.require(sessionId);
    this.db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(nowIso(), s.id);
    if (s.current_task_id) this.board.touchSynced(s.current_task_id);
    return { ok: true, currentTaskId: s.current_task_id, lastCheckpointAt: s.last_checkpoint_at };
  }

  end(sessionId: string, reason: string) {
    const s = this.get(sessionId);
    if (!s) return { ok: true, known: false };
    this.db.prepare('UPDATE sessions SET ended_at = ?, end_reason = ? WHERE id = ?').run(nowIso(), reason.slice(0, 100), s.id);
    // Deliberately no task status change: a closed session is not completion or a blocker.
    return { ok: true, known: true, currentTaskId: s.current_task_id, lastCheckpointAt: s.last_checkpoint_at };
  }

  /** What a (new or resumed) session needs to continue: current task context + candidates in this repo. */
  context(sessionId: string, opts: { repo?: string } = {}) {
    const s = this.get(sessionId);
    const linked = s ? this.linkedTaskIds(s.id).map((id) => this.board.getTaskOrNull(id)).filter(Boolean).map((t) => compact(t!)) : [];
    const current = s?.current_task_id ? this.board.context(s.current_task_id, 5) : null;
    const repo = opts.repo || s?.repo || '';
    const candidates = this.board.listTasks({ project: repo || undefined, status: ['in_progress', 'ready', 'review', 'waiting'], limit: 10 })
      .filter((t) => !linked.some((l) => l.id === t.id)).map(compact);
    return {
      sessionId, known: !!s, repo,
      currentTask: current ? {
        ...compact(current.task), summary: current.task.summary, completionConditions: current.task.completionConditions,
        latestFindings: current.task.findings.slice(-5), dependencies: current.dependencies, recentActivity: current.recentActivity.slice(0, 5).map((a) => ({ at: a.at, actor: a.actor, kind: a.kind, summary: a.summary })),
      } : null,
      linkedTasks: linked,
      candidatesInRepo: candidates,
      lastCheckpointAt: s?.last_checkpoint_at ?? null,
      hint: current ? `Continue ${current.task.id}; re-read it with get_task before editing (revision ${current.task.revision}).`
        : candidates.length ? 'No current task. If the user\'s request matches a candidate, link it; if several plausibly match, ask once. Do not pick by title similarity alone.'
        : 'No tasks for this repository yet. Create one when the user states a commitment.',
    };
  }

  activeSummary() {
    const cutoff = new Date(Date.now() - 2 * 3600_000).toISOString();
    const r = this.db.prepare('SELECT COUNT(*) AS n, MAX(last_checkpoint_at) AS lc FROM sessions WHERE ended_at IS NULL AND last_seen_at > ?').get(cutoff) as { n: number; lc: string | null };
    const lc = this.db.prepare('SELECT MAX(last_checkpoint_at) AS lc FROM sessions').get() as { lc: string | null };
    return { active: r.n, lastCheckpointAt: lc.lc };
  }
}
