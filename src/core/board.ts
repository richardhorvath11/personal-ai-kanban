// Shared domain rules. The HTTP service, UI, MCP adapter and background review all go through here.
import type { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import * as z from 'zod';
import { KanbanError } from './errors.ts';
import { STATUSES, STATUS_LABEL } from './types.ts';
import type { ActivityEntry, Change, OpContext, Status, Task } from './types.ts';

const isoDate = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/, 'Use YYYY-MM-DD (date-only) or a full ISO datetime');

export const TaskFields = z.object({
  title: z.string().trim().min(1).max(300),
  project: z.string().trim().max(200),
  status: z.enum(STATUSES),
  outcome: z.string().max(4000),
  completionConditions: z.array(z.string().trim().min(1).max(500)).max(50),
  summary: z.string().max(4000),
  nextAction: z.string().max(1000),
  checklist: z.array(z.object({ id: z.string().optional(), text: z.string().trim().min(1).max(500), done: z.boolean().default(false) })).max(200),
  links: z.array(z.object({ id: z.string().optional(), url: z.string().trim().min(1).max(2000), label: z.string().max(300).default('') })).max(100),
  dependsOn: z.array(z.string().trim().min(1)).max(50),
  deadline: isoDate.nullable(),
  deadlineKind: z.enum(['firm', 'flexible']).nullable(),
  deadlineTz: z.string().max(100).nullable(),
  deadlineLabel: z.string().max(200),
  priority: z.enum(['high', 'normal', 'low']),
  priorityContext: z.string().max(1000),
  pinned: z.boolean(),
  position: z.number().finite(),
  waitingReason: z.string().max(1000),
  waitingOn: z.enum(['', 'dependency', 'person', 'external']),
  followUpAt: isoDate.nullable(),
  followUpCondition: z.string().max(500),
  archived: z.boolean(),
});
export const TaskPatch = TaskFields.partial().strict();
export type TaskPatchInput = z.input<typeof TaskPatch>;

export interface EditOptions {
  expectedRevision?: number;
  addFindings?: string[];
  removeFindingIds?: string[];
  confirmDone?: boolean; // user confirmed the task is done (UI)
  completionEvidence?: string; // Claude: recorded results showing completion conditions are met
  kind?: string; // activity kind override (e.g. 'checkpoint')
  summaryNote?: string; // human-readable activity summary override
  meaningful?: boolean; // default true; heartbeats are not meaningful
  setFindings?: Task['findings']; // internal (undo)
}

const JSON_COLS = ['completion_conditions', 'checklist', 'findings', 'links'] as const;
const FIELD_TO_COL: Record<string, string> = {
  title: 'title', project: 'project', status: 'status', outcome: 'outcome', completionConditions: 'completion_conditions',
  summary: 'summary', nextAction: 'next_action', checklist: 'checklist', findings: 'findings', links: 'links',
  deadline: 'deadline', deadlineKind: 'deadline_kind', deadlineTz: 'deadline_tz', deadlineLabel: 'deadline_label',
  priority: 'priority', priorityContext: 'priority_context', pinned: 'pinned', position: 'position',
  waitingReason: 'waiting_reason', waitingOn: 'waiting_on', followUpAt: 'follow_up_at', followUpCondition: 'follow_up_condition',
  archived: 'archived',
};
const ARRAY_FIELDS = new Set(['completionConditions', 'checklist', 'findings', 'links', 'dependsOn']);
const FIELD_LABEL: Record<string, string> = {
  title: 'Title', project: 'Project', status: 'Status', outcome: 'Outcome', completionConditions: 'Completion conditions',
  summary: 'Summary', nextAction: 'Next action', checklist: 'Checklist', findings: 'Findings', links: 'Links', dependsOn: 'Dependencies',
  deadline: 'Deadline', deadlineKind: 'Deadline type', deadlineTz: 'Time zone', deadlineLabel: 'Deadline label', priority: 'Priority',
  priorityContext: 'Priority context', pinned: 'Pin', position: 'Order', waitingReason: 'Waiting reason', waitingOn: 'Waiting on',
  followUpAt: 'Follow-up date', followUpCondition: 'Follow-up condition', archived: 'Archived',
};

export const nowIso = () => new Date().toISOString();
const newId = () => crypto.randomUUID().slice(0, 8);
const itemKey = (x: unknown): string => (x && typeof x === 'object' && 'id' in x ? String((x as { id: unknown }).id) : JSON.stringify(x));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

type Row = Record<string, unknown>;

export class Board {
  db: DatabaseSync;
  defaultTz: string;
  // Hook for rules that react to edits (e.g. dependency completion), installed by later layers.
  afterChange: ((task: Task, before: Task | null, ctx: OpContext) => void) | null = null;

  constructor(db: DatabaseSync, defaultTz = 'UTC') {
    this.db = db;
    this.defaultTz = defaultTz;
  }

  // ---------- transactions & idempotency ----------
  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /** Run `fn` at most once per operation ID. A retry returns the stored acknowledgement with duplicate=true. */
  idempotent<T extends object>(opId: string | undefined, kind: string, fn: () => T & { taskId?: string }): T & { duplicate: boolean; opId: string } {
    const id = opId?.trim() || `op_${crypto.randomUUID()}`;
    if (id.length > 200) throw new KanbanError('validation', 'opId too long');
    return this.tx(() => {
      const prior = this.db.prepare('SELECT kind, result FROM operations WHERE op_id = ?').get(id) as { kind: string; result: string } | undefined;
      if (prior) {
        if (prior.kind !== kind) throw new KanbanError('validation', `opId ${id} was already used for a different operation (${prior.kind})`);
        const stored = JSON.parse(prior.result);
        // Return the *current* task state alongside the original acknowledgement.
        if (stored.task?.id) { const cur = this.getTaskOrNull(stored.task.id); if (cur) stored.task = cur; }
        return { ...stored, duplicate: true, opId: id };
      }
      const result = fn();
      this.db.prepare('INSERT INTO operations(op_id, kind, task_id, result, at) VALUES (?, ?, ?, ?, ?)')
        .run(id, kind, (result as { task?: Task }).task?.id ?? result.taskId ?? null, JSON.stringify(result), nowIso());
      return { ...result, duplicate: false, opId: id };
    });
  }

  // ---------- reads ----------
  private rowToTask(r: Row): Task {
    const deps = (this.db.prepare('SELECT depends_on FROM deps WHERE task_id = ? ORDER BY depends_on').all(r.id as string) as { depends_on: string }[]).map((d) => d.depends_on);
    const j = (k: string) => JSON.parse((r[k] as string) || '[]');
    return {
      id: r.id as string, title: r.title as string, project: r.project as string, status: r.status as Status,
      outcome: r.outcome as string, completionConditions: j('completion_conditions'), summary: r.summary as string,
      nextAction: r.next_action as string, checklist: j('checklist'), findings: j('findings'), links: j('links'), dependsOn: deps,
      deadline: (r.deadline as string) ?? null, deadlineKind: (r.deadline_kind as Task['deadlineKind']) ?? null,
      deadlineTz: (r.deadline_tz as string) ?? null, deadlineLabel: r.deadline_label as string,
      priority: r.priority as Task['priority'], priorityContext: r.priority_context as string, pinned: !!r.pinned,
      position: Number(r.position), waitingReason: r.waiting_reason as string, waitingOn: r.waiting_on as Task['waitingOn'],
      followUpAt: (r.follow_up_at as string) ?? null, followUpCondition: r.follow_up_condition as string, archived: !!r.archived,
      createdAt: r.created_at as string, updatedAt: r.updated_at as string, lastMeaningfulAt: r.last_meaningful_at as string,
      lastSyncedAt: (r.last_synced_at as string) ?? null, revision: Number(r.revision),
    };
  }

  getTaskOrNull(id: string): Task | null {
    const r = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Row | undefined;
    return r ? this.rowToTask(r) : null;
  }

  getTask(id: string): Task {
    const t = this.getTaskOrNull(String(id ?? '').trim());
    if (!t) throw new KanbanError('not_found', `No task with id "${id}". Use find_tasks to look up the right ID.`);
    return t;
  }

  listTasks(filter: { project?: string; status?: Status | Status[]; text?: string; includeArchived?: boolean; archivedOnly?: boolean; limit?: number } = {}): Task[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (filter.archivedOnly) where.push('archived = 1');
    else if (!filter.includeArchived) where.push('archived = 0');
    if (filter.project) { where.push('project = ?'); args.push(filter.project); }
    const statuses = filter.status ? (Array.isArray(filter.status) ? filter.status : [filter.status]) : [];
    if (statuses.length) { where.push(`status IN (${statuses.map(() => '?').join(',')})`); args.push(...statuses); }
    if (filter.text?.trim()) {
      where.push('(title LIKE ? OR summary LIKE ? OR next_action LIKE ? OR outcome LIKE ? OR findings LIKE ? OR id = ?)');
      const like = `%${filter.text.trim()}%`;
      args.push(like, like, like, like, like, filter.text.trim().toUpperCase());
    }
    const sql = `SELECT * FROM tasks ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY pinned DESC, position ASC, created_at ASC LIMIT ?`;
    args.push(Math.min(filter.limit ?? 500, 1000));
    return (this.db.prepare(sql).all(...args) as Row[]).map((r) => this.rowToTask(r));
  }

  projects(): string[] {
    return (this.db.prepare("SELECT DISTINCT project FROM tasks WHERE project != '' ORDER BY project").all() as { project: string }[]).map((r) => r.project);
  }

  activity(filter: { taskId?: string; sinceId?: number; sinceAt?: string; limit?: number } = {}): ActivityEntry[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (filter.taskId) { where.push('task_id = ?'); args.push(filter.taskId); }
    if (filter.sinceId != null) { where.push('id > ?'); args.push(filter.sinceId); }
    if (filter.sinceAt) { where.push('at > ?'); args.push(filter.sinceAt); }
    args.push(Math.min(filter.limit ?? 200, 2000));
    const rows = this.db.prepare(`SELECT * FROM activity ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`).all(...args) as Row[];
    return rows.map((r) => ({
      id: Number(r.id), taskId: r.task_id as string, at: r.at as string, actor: r.actor as ActivityEntry['actor'],
      sessionId: (r.session_id as string) ?? null, kind: r.kind as string, summary: r.summary as string,
      changes: JSON.parse(r.changes as string), sourceNote: r.source_note as string, opId: (r.op_id as string) ?? null,
      undoOf: (r.undo_of as number) ?? null, undoneBy: (r.undone_by as number) ?? null,
    }));
  }

  /** Context for resuming work: task + dependency state + recent changes. */
  context(id: string, recent = 8) {
    const task = this.getTask(id);
    const dependencies = task.dependsOn.map((d) => {
      const t = this.getTaskOrNull(d);
      return t ? { id: t.id, title: t.title, status: t.status, done: t.status === 'done' } : { id: d, title: '(missing)', status: null, done: false };
    });
    const dependents = (this.db.prepare('SELECT task_id FROM deps WHERE depends_on = ?').all(id) as { task_id: string }[])
      .map((r) => this.getTaskOrNull(r.task_id)).filter(Boolean).map((t) => ({ id: t!.id, title: t!.title, status: t!.status }));
    return { task, dependencies, dependents, recentActivity: this.activity({ taskId: id, limit: recent }) };
  }

  // ---------- writes ----------
  private nextTaskId(): string {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'task_seq'").get() as { value: string };
    const n = Number(row.value) + 1;
    this.db.prepare("UPDATE meta SET value = ? WHERE key = 'task_seq'").run(String(n));
    return `T-${n}`;
  }

  private writeTask(t: Task) {
    const cols = Object.values(FIELD_TO_COL);
    const vals = Object.keys(FIELD_TO_COL).map((f) => {
      const v = (t as unknown as Record<string, unknown>)[f];
      const col = FIELD_TO_COL[f];
      if ((JSON_COLS as readonly string[]).includes(col)) return JSON.stringify(v ?? []);
      if (typeof v === 'boolean') return v ? 1 : 0;
      return v as string | number | null;
    });
    this.db.prepare(`UPDATE tasks SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ?, last_meaningful_at = ?, last_synced_at = ?, revision = ? WHERE id = ?`)
      .run(...vals, t.updatedAt, t.lastMeaningfulAt, t.lastSyncedAt, t.revision, t.id);
    this.db.prepare('DELETE FROM deps WHERE task_id = ?').run(t.id);
    for (const d of t.dependsOn) this.db.prepare('INSERT INTO deps(task_id, depends_on) VALUES (?, ?)').run(t.id, d);
  }

  private logActivity(taskId: string, ctx: OpContext, kind: string, summary: string, changes: Change[], revision: number, undoOf: number | null = null): number {
    const r = this.db.prepare('INSERT INTO activity(task_id, at, actor, session_id, kind, summary, changes, source_note, op_id, revision, undo_of) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(taskId, nowIso(), ctx.actor, ctx.sessionId ?? null, kind, summary.slice(0, 2000), JSON.stringify(changes), (ctx.sourceNote ?? '').slice(0, 500), ctx.opId ?? null, revision, undoOf);
    return Number(r.lastInsertRowid);
  }

  private normalizeItems(field: string, v: unknown): unknown {
    if (field === 'checklist' || field === 'links') return (v as { id?: string }[]).map((i) => ({ ...i, id: i.id || newId() }));
    if (field === 'dependsOn') return [...new Set(v as string[])].map((s) => s.toUpperCase());
    return v;
  }

  private validateDeps(taskId: string, deps: string[]) {
    for (const d of deps) {
      if (d === taskId) throw new KanbanError('validation', 'A task cannot depend on itself');
      if (!this.getTaskOrNull(d)) throw new KanbanError('not_found', `Dependency ${d} does not exist`);
    }
    // Reject cycles: walk from each dependency back to taskId.
    const seen = new Set<string>();
    const walk = (id: string): boolean => {
      if (id === taskId) return true;
      if (seen.has(id)) return false;
      seen.add(id);
      return (this.db.prepare('SELECT depends_on FROM deps WHERE task_id = ?').all(id) as { depends_on: string }[]).some((r) => walk(r.depends_on));
    };
    for (const d of deps) if (walk(d)) throw new KanbanError('validation', `Dependency on ${d} would create a cycle`);
  }

  private checkTransition(before: Task, next: Task, ctx: OpContext, opts: EditOptions) {
    if (before.archived && next.archived) throw new KanbanError('invalid_transition', `${before.id} is archived; restore it before editing.`);
    if (before.status === next.status) return;
    if (ctx.actor === 'hook') throw new KanbanError('invalid_transition', 'Lifecycle hooks never change task status. A Stop or SessionEnd is not proof of progress or completion.');
    if (next.status === 'waiting' && !next.waitingReason.trim()) {
      throw new KanbanError('invalid_transition', 'Moving to Waiting requires a waitingReason (what or who is blocking progress).');
    }
    if (next.status === 'done') {
      if (ctx.actor === 'user') {
        if (!opts.confirmDone) throw new KanbanError('invalid_transition', 'Marking Done needs confirmDone: true (user confirmation).');
      } else {
        if (next.completionConditions.length === 0) {
          throw new KanbanError('invalid_transition', `${before.id} has no completion conditions recorded, so it cannot be marked Done automatically. Move it to Review and ask the user to confirm.`);
        }
        if (!opts.completionEvidence?.trim()) {
          throw new KanbanError('invalid_transition', `Done requires completionEvidence showing these conditions are met: ${next.completionConditions.map((c) => `"${c}"`).join(', ')}. If an output is ready but not accepted, move it to Review instead.`);
        }
      }
    }
  }

  private diff(before: Task, after: Task): Change[] {
    const changes: Change[] = [];
    for (const f of [...Object.keys(FIELD_TO_COL), 'dependsOn']) {
      const a = (before as unknown as Record<string, unknown>)[f];
      const b = (after as unknown as Record<string, unknown>)[f];
      if (same(a, b)) continue;
      if (ARRAY_FIELDS.has(f)) {
        const am = new Map((a as unknown[]).map((x) => [itemKey(x), x]));
        const bm = new Map((b as unknown[]).map((x) => [itemKey(x), x]));
        const added = [...bm].filter(([k]) => !am.has(k)).map(([, v]) => v);
        const removed = [...am].filter(([k]) => !bm.has(k)).map(([, v]) => v);
        const modified = [...bm].filter(([k, v]) => am.has(k) && !same(am.get(k), v)).map(([k, v]) => ({ before: am.get(k), after: v }));
        if (added.length || removed.length || modified.length) changes.push({ field: f, added, removed, modified });
        else changes.push({ field: f, before: a, after: b }); // reorder only
      } else changes.push({ field: f, before: a, after: b });
    }
    return changes;
  }

  describe(changes: Change[]): string {
    return changes.map((c) => {
      const label = FIELD_LABEL[c.field] ?? c.field;
      if ('before' in c) {
        if (c.field === 'status') return `Status: ${STATUS_LABEL[c.before as Status]} → ${STATUS_LABEL[c.after as Status]}`;
        if (c.field === 'pinned') return c.after ? 'Pinned' : 'Unpinned';
        if (c.field === 'archived') return c.after ? 'Archived' : 'Restored';
        if (typeof c.after === 'string' && (c.after as string).length < 80) return `${label}: "${c.after}"`;
        return `${label} updated`;
      }
      const parts = [];
      if (c.added.length) parts.push(`+${c.added.length}`);
      if (c.removed.length) parts.push(`-${c.removed.length}`);
      if (c.modified.length) parts.push(`~${c.modified.length}`);
      return `${label} ${parts.join(' ')}`;
    }).join('; ');
  }

  createTask(input: TaskPatchInput & { title: string }, ctx: OpContext) {
    return this.idempotent(ctx.opId, 'create_task', () => {
      const parsed = TaskPatch.safeParse(input);
      if (!parsed.success) throw new KanbanError('validation', z.prettifyError(parsed.error));
      const p = parsed.data;
      if (!p.title) throw new KanbanError('validation', 'title is required');
      if (p.status === 'done') throw new KanbanError('invalid_transition', 'Tasks cannot be created as Done.');
      if (p.status === 'waiting' && !p.waitingReason?.trim()) throw new KanbanError('invalid_transition', 'A Waiting task needs a waitingReason.');
      const id = this.nextTaskId();
      const ts = nowIso();
      const maxPos = (this.db.prepare('SELECT COALESCE(MAX(position), 0) AS m FROM tasks').get() as { m: number }).m;
      this.db.prepare("INSERT INTO tasks(id, title, status, created_at, updated_at, last_meaningful_at) VALUES (?, ?, 'inbox', ?, ?, ?)").run(id, p.title, ts, ts, ts);
      const blank = this.getTask(id);
      const t: Task = { ...blank, position: maxPos + 1, deadlineTz: p.deadline ? (p.deadlineTz ?? this.defaultTz) : null };
      for (const [k, v] of Object.entries(p)) (t as unknown as Record<string, unknown>)[k] = this.normalizeItems(k, v);
      if (t.deadline && !t.deadlineKind) t.deadlineKind = 'flexible';
      if (t.dependsOn.length) this.validateDeps(id, t.dependsOn);
      this.writeTask(t);
      const task = this.getTask(id);
      this.logActivity(id, ctx, 'created', `Created in ${STATUS_LABEL[task.status]}${task.project ? ` (${task.project})` : ''}`, [], task.revision);
      this.afterChange?.(task, null, ctx);
      return { task };
    });
  }

  /** Validated edit. Stale revisions are rejected only if they touch fields changed since that revision. */
  editTask(id: string, patchInput: TaskPatchInput, ctx: OpContext, opts: EditOptions = {}) {
    return this.idempotent(ctx.opId, opts.kind ?? 'edit_task', () => this.applyEdit(id, patchInput, ctx, opts));
  }

  /** Edit without its own idempotency wrapper (callers inside idempotent()). */
  applyEdit(id: string, patchInput: TaskPatchInput, ctx: OpContext, opts: EditOptions = {}) {
    const parsed = TaskPatch.safeParse(patchInput ?? {});
    if (!parsed.success) throw new KanbanError('validation', z.prettifyError(parsed.error));
    const patch = parsed.data;
    const before = this.getTask(id);
    if (opts.expectedRevision != null && opts.expectedRevision !== before.revision) {
      if (opts.expectedRevision > before.revision) throw new KanbanError('validation', `expectedRevision ${opts.expectedRevision} is newer than current revision ${before.revision}`);
      const touched = new Set<string>();
      for (const a of this.db.prepare('SELECT changes FROM activity WHERE task_id = ? AND revision > ?').all(id, opts.expectedRevision) as { changes: string }[]) {
        for (const c of JSON.parse(a.changes) as Change[]) touched.add(c.field);
      }
      const wanted = new Set(Object.keys(patch));
      if (opts.removeFindingIds?.length) wanted.add('findings');
      const clash = [...wanted].filter((f) => touched.has(f) || (f === 'status' && touched.has('status')));
      if (clash.length) {
        throw new KanbanError('conflict', `Task ${id} changed since revision ${opts.expectedRevision} (now ${before.revision}); conflicting fields: ${clash.join(', ')}. Refresh with get_task and reapply.`, { currentRevision: before.revision, conflictingFields: clash, task: before });
      }
    }
    const after: Task = structuredClone(before);
    for (const [k, v] of Object.entries(patch)) (after as unknown as Record<string, unknown>)[k] = this.normalizeItems(k, v);
    if (patch.deadline && !after.deadlineTz) after.deadlineTz = this.defaultTz;
    if (patch.deadline && !after.deadlineKind) after.deadlineKind = 'flexible';
    if (patch.deadline === null) { after.deadlineKind = null; after.deadlineTz = null; }
    const ts = nowIso();
    for (const text of opts.addFindings ?? []) {
      const tt = String(text).trim();
      if (!tt) continue;
      if (tt.length > 2000) throw new KanbanError('validation', 'A finding must be under 2000 characters');
      after.findings = [...after.findings, { id: newId(), text: tt, at: ts, actor: ctx.actor, sessionId: ctx.sessionId ?? null }];
    }
    if (opts.removeFindingIds?.length) after.findings = after.findings.filter((f) => !opts.removeFindingIds!.includes(f.id));
    if (opts.setFindings) after.findings = opts.setFindings;
    if (patch.dependsOn) this.validateDeps(id, after.dependsOn);
    this.checkTransition(before, after, ctx, opts);
    if (after.status === 'done' && before.status !== 'done' && opts.completionEvidence?.trim()) {
      after.findings = [...after.findings, { id: newId(), text: `Completion evidence: ${opts.completionEvidence.trim()}`, at: ts, actor: ctx.actor, sessionId: ctx.sessionId ?? null }];
    }
    const changes = this.diff(before, after);
    if (!changes.length && !opts.kind) return { task: before, changes, activityId: null as number | null };
    after.revision = before.revision + (changes.length ? 1 : 0);
    after.updatedAt = ts;
    if (opts.meaningful !== false && changes.length) after.lastMeaningfulAt = ts;
    this.writeTask(after);
    const activityId = this.logActivity(id, ctx, opts.kind ?? 'edit', opts.summaryNote ?? this.describe(changes), changes, after.revision);
    const task = this.getTask(id);
    this.afterChange?.(task, before, ctx);
    return { task, changes, activityId };
  }

  /** Mark that a sync/heartbeat touched this task. Does NOT count as meaningful progress. */
  touchSynced(id: string) {
    this.db.prepare('UPDATE tasks SET last_synced_at = ? WHERE id = ?').run(nowIso(), id);
  }

  /**
   * Undo one activity entry. Field-level: a field is reverted only if it still holds the value that
   * entry set; list items are added/removed individually. Later, unrelated edits are preserved.
   */
  undo(activityId: number, ctx: OpContext) {
    return this.idempotent(ctx.opId, 'undo', () => {
      const entry = this.activity({ sinceId: Number(activityId) - 1, limit: 2000 }).find((a) => a.id === Number(activityId));
      if (!entry) throw new KanbanError('not_found', `No activity entry ${activityId}`);
      if (entry.undoneBy) throw new KanbanError('invalid_transition', `Activity ${activityId} was already undone by #${entry.undoneBy}`);
      const cur = this.getTask(entry.taskId);
      if (entry.kind === 'created') {
        if (cur.archived) throw new KanbanError('invalid_transition', 'Task is already archived');
        const r = this.applyEdit(cur.id, { archived: true }, ctx, { kind: 'undo', summaryNote: `Undo #${activityId} (creation): archived` });
        this.db.prepare('UPDATE activity SET undone_by = ? WHERE id = ?').run(r.activityId, activityId);
        return { task: r.task, reverted: ['archived'], skipped: [] as { field: string; reason: string }[] };
      }
      const next: Task = structuredClone(cur);
      const reverted: string[] = [];
      const skipped: { field: string; reason: string }[] = [];
      for (const c of entry.changes) {
        const field = c.field as keyof Task;
        const curVal = (next as unknown as Record<string, unknown>)[field];
        if ('before' in c) {
          if (same(curVal, c.after)) { (next as unknown as Record<string, unknown>)[field] = c.before; reverted.push(c.field); }
          else skipped.push({ field: c.field, reason: 'changed again later; kept the newer value' });
        } else {
          let list = [...(curVal as unknown[])];
          let did = false;
          for (const a of c.added) { const k = itemKey(a); if (list.some((x) => itemKey(x) === k)) { list = list.filter((x) => itemKey(x) !== k); did = true; } }
          for (const r of c.removed) { const k = itemKey(r); if (!list.some((x) => itemKey(x) === k)) { list.push(r); did = true; } }
          for (const m of c.modified) {
            const k = itemKey(m.after);
            const idx = list.findIndex((x) => itemKey(x) === k);
            if (idx >= 0 && same(list[idx], m.after)) { list[idx] = m.before; did = true; }
            else skipped.push({ field: c.field, reason: `item ${k} changed again later` });
          }
          (next as unknown as Record<string, unknown>)[field] = list;
          if (did) reverted.push(c.field);
        }
      }
      if (!reverted.length) throw new KanbanError('conflict', `Nothing to undo for #${activityId}: every field it changed has been changed again since.`, { skipped });
      const patch: Record<string, unknown> = {};
      for (const f of reverted) if (f !== 'findings') patch[f] = (next as unknown as Record<string, unknown>)[f];
      // Undo is a user correction, so it may revert a Done status without a fresh confirmation prompt.
      const r = this.applyEdit(cur.id, patch as TaskPatchInput, ctx, {
        kind: 'undo', confirmDone: true,
        summaryNote: `Undo #${activityId}: ${reverted.join(', ')}${skipped.length ? ` (kept newer: ${skipped.map((s) => s.field).join(', ')})` : ''}`,
        setFindings: reverted.includes('findings') ? next.findings : undefined,
      });
      this.db.prepare('UPDATE activity SET undone_by = ? WHERE id = ?').run(r.activityId, activityId);
      return { task: this.getTask(cur.id), reverted, skipped };
    });
  }

  exportAll() {
    const tables = (this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
    const out: Record<string, unknown> = { exportedAt: nowIso(), format: 'personal-ai-kanban/v1' };
    for (const t of tables) out[t] = this.db.prepare(`SELECT * FROM "${t}"`).all();
    out.tasksResolved = this.listTasks({ includeArchived: true, limit: 1000 });
    return out;
  }
}
