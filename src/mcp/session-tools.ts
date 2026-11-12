import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod';
import type { KanbanClient } from '../core/client.ts';
import { STATUSES } from '../core/types.ts';
import { findSessionForProcess } from '../core/runtime.ts';
import { wrap } from './server.ts';
import { checkpointWithOutbox } from './offline.ts';

export function resolveSessionId(explicit?: string): string {
  const s = explicit?.trim() || process.env.KANBAN_SESSION_ID || findSessionForProcess();
  if (!s) throw new Error('session_unknown: pass sessionId (it is in the SessionStart context as "Claude session id"), or install the kanban hooks for this project.');
  return s;
}

export function registerSessionTools(server: McpServer, client: KanbanClient) {
  server.registerTool('get_session_context', {
    title: 'Load session context',
    description: 'Call at the start of work, on resume, and when switching work. Returns the current task for this Claude session (summary, next action, completion conditions, latest findings), other linked tasks and candidate tasks in this repo.',
    inputSchema: { sessionId: z.string().optional(), repo: z.string().optional() },
    annotations: { readOnlyHint: true },
  }, wrap(async (a) => {
    const id = resolveSessionId(a.sessionId);
    return client.get(`/api/sessions/${encodeURIComponent(id)}/context${a.repo ? `?repo=${encodeURIComponent(a.repo)}` : ''}`);
  }));

  server.registerTool('link_session', {
    title: 'Link session to task(s)',
    description: 'Associate this Claude session (and repo/worktree) with task IDs and set the current task. Call when starting or switching work so later checkpoints go to the right card. Do not choose a task only because its title or the repo looks similar; if several plausibly match, ask the user once.',
    inputSchema: {
      opId: z.string().min(8), sessionId: z.string().optional(), taskIds: z.array(z.string()).optional(),
      currentTaskId: z.string().nullable().optional().describe('The task subsequent checkpoints should go to (null clears)'),
      repo: z.string().optional(), cwd: z.string().optional(), worktree: z.string().optional(),
    },
  }, wrap(async (a) => client.post('/api/sessions/link', { ...a, sessionId: resolveSessionId(a.sessionId) })));

  server.registerTool('record_checkpoint', {
    title: 'Record checkpoint',
    description: 'Atomically record meaningful progress on the current task (or taskId): concise summary, next action, new findings, links, checklist items done, and a justified status change. Use after meaningful progress, a blocker, or changed findings — without waiting for the user to ask. Not for trivial chatter. Done requires completionEvidence for the task\'s completion conditions; otherwise use review. If the board is offline, the checkpoint is queued locally and reported as NOT yet acknowledged.',
    inputSchema: {
      opId: z.string().min(8).describe('Unique per checkpoint; reuse when retrying the same checkpoint'),
      sessionId: z.string().optional(), taskId: z.string().optional().describe('Defaults to the session\'s current task'),
      summary: z.string().min(1).max(4000), nextAction: z.string().max(1000).optional(),
      findings: z.array(z.string()).max(20).optional(), links: z.array(z.object({ url: z.string(), label: z.string().optional() })).max(20).optional(),
      checklistDone: z.array(z.string()).optional(), status: z.enum(STATUSES).optional(), waitingReason: z.string().optional(),
      completionEvidence: z.string().optional(), expectedRevision: z.number().int().optional(),
    },
  }, wrap(async (a) => checkpointWithOutbox(client, { ...a, sessionId: resolveSessionId(a.sessionId) })));
}
