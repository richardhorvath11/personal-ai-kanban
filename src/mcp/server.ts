#!/usr/bin/env node
// stdio MCP adapter. It holds no task logic: every call is forwarded to the local kanban service,
// so several Claude sessions can share one board and one set of domain rules.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod';
import { KanbanClient, ServiceError, ServiceUnavailable } from '../core/client.ts';
import { STATUSES } from '../core/types.ts';
import type { Task } from '../core/types.ts';
import { registerSessionTools } from './session-tools.ts';
import { sendOrQueue } from '../core/deliver.ts';
import { getOutbox } from './offline.ts';
import { isIgnored, kanbanDisabled, resolveProject } from '../core/project.ts';
import { dataDirFromEnv } from '../core/runtime.ts';

export const compact = (t: Task) => ({
  id: t.id, title: t.title, project: t.project, status: t.status, nextAction: t.nextAction || null,
  deadline: t.deadline, deadlineKind: t.deadlineKind, pinned: t.pinned, priority: t.priority,
  waitingReason: t.status === 'waiting' ? t.waitingReason : undefined, revision: t.revision, lastMeaningfulAt: t.lastMeaningfulAt,
});

export type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };
export const ok = (v: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(v, null, 1) }] });
export const fail = (msg: string, extra?: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify({ error: msg, ...(extra ? { details: extra } : {}) }, null, 1) }], isError: true });

export function wrap<A>(fn: (a: A) => Promise<unknown>) {
  return async (a: A): Promise<ToolResult> => {
    try {
      return ok(await fn(a));
    } catch (e) {
      if (e instanceof ServiceError) return fail(`${e.code}: ${e.message}`, e.details);
      if (e instanceof ServiceUnavailable) return fail(`board_unavailable: ${e.message}. Nothing was saved by this call.`);
      return fail((e as Error).message);
    }
  };
}

const status = z.enum(STATUSES);
export const taskFieldsShape = {
  title: z.string().min(1).max(300).optional(),
  project: z.string().max(200).optional().describe('Project / repository label, e.g. "acme-api"'),
  status: status.optional(),
  outcome: z.string().max(4000).optional().describe('Desired outcome'),
  completionConditions: z.array(z.string()).optional().describe('Task-specific conditions that must hold for Done'),
  summary: z.string().max(4000).optional().describe('Concise current progress summary'),
  nextAction: z.string().max(1000).optional(),
  checklist: z.array(z.object({ id: z.string().optional(), text: z.string(), done: z.boolean().optional() })).optional(),
  links: z.array(z.object({ id: z.string().optional(), url: z.string(), label: z.string().optional() })).optional(),
  dependsOn: z.array(z.string()).optional().describe('IDs of tasks this one depends on'),
  deadline: z.string().nullable().optional().describe('Explicit YYYY-MM-DD (date-only) or ISO datetime. Resolve relative wording with resolve_date first.'),
  deadlineKind: z.enum(['firm', 'flexible']).nullable().optional(),
  deadlineLabel: z.string().max(200).optional().describe('e.g. "Friday demo"'),
  priority: z.enum(['high', 'normal', 'low']).optional(),
  priorityContext: z.string().max(1000).optional().describe("User's own words about why this matters"),
  pinned: z.boolean().optional().describe('Only set when the user explicitly asks to pin/unpin'),
  waitingReason: z.string().max(1000).optional(),
  waitingOn: z.enum(['', 'dependency', 'person', 'external']).optional(),
  followUpAt: z.string().nullable().optional().describe('YYYY-MM-DD or ISO datetime to check on a waiting item'),
  followUpCondition: z.string().max(500).optional(),
};

export function buildServer(client: KanbanClient, opts: { defaultProject?: string } = {}) {
  const server = new McpServer({ name: 'personal-ai-kanban', version: '0.1.0' }, {
    instructions: 'Personal kanban board shared across Claude sessions. Read task context before resuming work; record concise checkpoints after meaningful progress, blockers or changed findings. Never mark Done unless the task\'s completion conditions are met (pass completionEvidence) — otherwise use Review.',
  });

  server.registerTool('find_tasks', {
    title: 'Find tasks',
    description: 'Search the board by project, status and text. Returns compact results (id, title, status, next action, deadline).',
    inputSchema: {
      project: z.string().optional(), status: z.array(status).optional(), text: z.string().optional(),
      includeArchived: z.boolean().optional(), limit: z.number().int().min(1).max(100).optional(),
    },
    annotations: { readOnlyHint: true },
  }, wrap(async (a) => {
    const q = new URLSearchParams();
    if (a.project) q.set('project', a.project);
    if (a.status?.length) q.set('status', a.status.join(','));
    if (a.text) q.set('q', a.text);
    if (a.includeArchived) q.set('archived', 'all');
    q.set('limit', String(a.limit ?? 30));
    const r = await client.get<{ tasks: Task[] }>(`/api/tasks?${q}`);
    return { count: r.tasks.length, tasks: r.tasks.map(compact) };
  }));

  server.registerTool('get_task', {
    title: 'Read task context',
    description: 'Full context for one task: summary, next action, completion conditions, findings, dependencies and recent changes. Call before resuming work; use the returned revision for edits.',
    inputSchema: { taskId: z.string(), recent: z.number().int().min(0).max(50).optional() },
    annotations: { readOnlyHint: true },
  }, wrap(async (a) => client.get(`/api/tasks/${encodeURIComponent(a.taskId)}?recent=${a.recent ?? 8}`)));

  server.registerTool('create_task', {
    title: 'Create task',
    description: 'Create a durable task. Explicit requests/commitments may be created as ready; tentative ideas go to inbox. Always pass a fresh opId (UUID) and reuse it if you retry, so retries never duplicate.',
    inputSchema: { opId: z.string().min(8).describe('Unique operation ID; reuse on retry'), sessionId: z.string().optional(), sourceNote: z.string().max(500).optional().describe('Short note of the user instruction this came from'), ...taskFieldsShape, title: z.string().min(1).max(300) },
  }, wrap(async ({ opId, sessionId, sourceNote, ...fields }) => {
    if (!fields.project && opts.defaultProject) fields.project = opts.defaultProject; // label from the session's repository
    const r = await sendOrQueue<{ task: Task; duplicate: boolean }>(client, getOutbox(), 'POST', '/api/tasks', { opId, sessionId, sourceNote, ...fields });
    if (!r.acknowledged) return { acknowledged: false, queued: true, opId: r.opId, warning: r.message };
    return { acknowledged: true, duplicate: r.result!.duplicate, task: compact(r.result!.task) };
  }));

  server.registerTool('edit_task', {
    title: 'Edit task',
    description: 'Apply validated field changes. Requires expectedRevision from get_task; a stale revision that conflicts with newer changes is rejected with the current revision. Returns the new revision.',
    inputSchema: {
      taskId: z.string(), opId: z.string().min(8), expectedRevision: z.number().int(), sessionId: z.string().optional(), sourceNote: z.string().max(500).optional(),
      changes: z.object(taskFieldsShape).describe('Only the fields to change'),
      addFindings: z.array(z.string()).optional(), completionEvidence: z.string().optional().describe('Required to move to done: how each completion condition is satisfied'),
    },
  }, wrap(async (a) => {
    const r = await client.patch<{ task: Task; duplicate: boolean }>(`/api/tasks/${encodeURIComponent(a.taskId)}`, {
      opId: a.opId, expectedRevision: a.expectedRevision, sessionId: a.sessionId, sourceNote: a.sourceNote,
      patch: a.changes, addFindings: a.addFindings, completionEvidence: a.completionEvidence,
    });
    return { duplicate: r.duplicate, revision: r.task.revision, task: compact(r.task) };
  }));

  server.registerTool('get_next_work', {
    title: 'What should I pick up next?',
    description: 'Executable next-work candidates with understandable reasons (pins, firm deadlines, dependencies that unblock important work, priority). Blocked work is listed separately and never recommended as executable. Pin conflicts are flagged, not overridden.',
    inputSchema: { project: z.string().optional() },
    annotations: { readOnlyHint: true },
  }, wrap(async (a) => client.get(`/api/next${a.project ? `?project=${encodeURIComponent(a.project)}` : ''}`)));

  server.registerTool('get_attention', {
    title: 'Needs your attention',
    description: 'Deadlines at risk, due follow-ups (reminders to check — never contact anyone automatically), neglected in-progress work, pending reviews, blocked items and pin conflicts.',
    inputSchema: { project: z.string().optional() },
    annotations: { readOnlyHint: true },
  }, wrap(async (a) => client.get(`/api/attention${a.project ? `?project=${encodeURIComponent(a.project)}` : ''}`)));

  server.registerTool('resolve_date', {
    title: 'Resolve a relative date',
    description: 'Turn wording like "Friday", "tomorrow 3pm" or "in 2 weeks" into an explicit date in the user\'s time zone. If it returns ambiguous, ask the user the returned question instead of guessing.',
    inputSchema: { text: z.string().min(1).max(100) },
    annotations: { readOnlyHint: true },
  }, wrap(async (a) => client.get(`/api/resolve-date?text=${encodeURIComponent(a.text)}`)));

  registerSessionTools(server, client);
  return server;
}

/** A server with no tools, for projects that opted out (`kanban ignore`) or when KANBAN_DISABLE=1. */
export function buildDisabledServer(reason: string) {
  return new McpServer({ name: 'personal-ai-kanban', version: '0.1.0' }, {
    instructions: `Personal AI Kanban is turned off here (${reason}). It offers no tools in this session; ignore any kanban instructions.`,
  });
}

if (import.meta.main) {
  // Claude Code sets CLAUDE_PROJECT_DIR for stdio servers; with a user-scope install it is the only way to know the project.
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const off = kanbanDisabled() ? 'KANBAN_DISABLE=1' : isIgnored(dataDirFromEnv(), [projectDir]) ? `project ${projectDir} is on the kanban ignore list` : '';
  const server = off ? buildDisabledServer(off) : buildServer(new KanbanClient({ client: 'mcp' }), { defaultProject: process.env.CLAUDE_PROJECT_DIR ? resolveProject(process.env.CLAUDE_PROJECT_DIR).repo : undefined });
  await server.connect(new StdioServerTransport());
}
