#!/usr/bin/env node
// Claude Code lifecycle hook for Personal AI Kanban.
//   node src/hooks/hook.ts <session-start|post-tool-use|stop|session-end> [--url URL] [--data-dir DIR]
// Hooks establish that something happened; Claude supplies the meaning (via MCP checkpoints).
// Every path is bounded, never blocks normal coding when the board is offline, and never changes task status.
import fs from 'node:fs';
import path from 'node:path';
import { KanbanClient, ServiceUnavailable } from '../core/client.ts';
import { Outbox, drain } from '../core/outbox.ts';
import { httpSender, sendOrQueue } from '../core/deliver.ts';
import { dataDirFromEnv, recordSessionPid, runtimeDir, writeAtomic } from '../core/runtime.ts';
import { hasProjectInstall, isIgnored, kanbanDisabled, resolveProject } from '../core/project.ts';

const argv = process.argv.slice(2);
const event = argv[0];
const opt = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
if (opt('--data-dir')) process.env.KANBAN_DATA_DIR = opt('--data-dir');
const url = opt('--url') ?? process.env.KANBAN_URL ?? `http://127.0.0.1:${process.env.KANBAN_PORT || 4317}`;
const dataDir = dataDirFromEnv();
// 'global' = registered in ~/.claude/settings.json for every project; 'project' = the older per-repo install.
const scope = opt('--scope') === 'global' ? 'global' : 'project';
const SELF = path.resolve(import.meta.filename);

const BUDGET_MS: Record<string, number> = { 'session-start': 4000, 'post-tool-use': 500, stop: 4000, 'session-end': 1200 };

async function readStdin(timeoutMs = 1000): Promise<any> {
  if (process.stdin.isTTY) return {};
  const chunks: Buffer[] = [];
  let size = 0;
  await new Promise<void>((resolve) => {
    const t = setTimeout(resolve, timeoutMs);
    process.stdin.on('data', (c: Buffer) => { size += c.length; if (size < 2_000_000) chunks.push(c); });
    process.stdin.on('end', () => { clearTimeout(t); resolve(); });
    process.stdin.on('error', () => { clearTimeout(t); resolve(); });
  });
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return {}; }
}

/** Why this hook run should do nothing at all (quietly), or null to proceed. Cheap: env + file reads only. */
function skipReason(input: any): string | null {
  if (kanbanDisabled() || process.env.KANBAN_HOOK_DISABLE === '1') return 'disabled';
  const projectDir = process.env.CLAUDE_PROJECT_DIR || input.cwd || '';
  if (isIgnored(dataDir, [input.cwd, projectDir])) return 'ignored';
  // Avoid double hooks: a project that still has the per-project install keeps it; the global copy steps aside.
  if (scope === 'global' && projectDir && hasProjectInstall(projectDir, SELF)) return 'project-install';
  return null;
}

function health(rt: string, patch: Record<string, unknown>) {
  const f = path.join(rt, 'hook-health.json');
  let cur: Record<string, unknown> = {};
  try { cur = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { /* first run */ }
  try { writeAtomic(f, JSON.stringify({ ...cur, ...patch, lastRunAt: new Date().toISOString(), lastEvent: event })); } catch { /* best effort */ }
}

let outcome = 'noop';
const out = (v: unknown) => { outcome = JSON.stringify(v).slice(0, 200); process.stdout.write(JSON.stringify(v)); };

// Small diagnostic event log (event, session, outcome — never prompts or transcripts). Rotated at 1 MB.
function logEvent(rt: string, sessionId: string, extra: Record<string, unknown> = {}) {
  try {
    const f = path.join(rt, 'hook-events.jsonl');
    if (fs.existsSync(f) && fs.statSync(f).size > 1_000_000) fs.renameSync(f, f + '.1');
    fs.appendFileSync(f, JSON.stringify({ at: new Date().toISOString(), event, sessionId, outcome, ...extra }) + '\n');
  } catch { /* best effort */ }
}

async function main() {
  if (kanbanDisabled() || process.env.KANBAN_HOOK_DISABLE === '1') return;
  const input = await readStdin();
  const sessionId: string = String(input.session_id || '');
  if (!sessionId) return; // nothing we can attribute
  if (skipReason(input)) return; // opted out, or a project-scoped install handles this project
  const rt = runtimeDir(dataDir);
  try { await handle(input, sessionId, rt); } finally { logEvent(rt, sessionId, { stopHookActive: input.stop_hook_active ?? undefined, tool: input.tool_name ?? undefined, source: input.source ?? undefined, reason: input.reason ?? undefined }); }
}

async function handle(input: any, sessionId: string, rt: string) {
  const outbox = new Outbox(dataDir);
  const client = new KanbanClient({ baseUrl: url, client: 'hook', timeoutMs: Math.min(1500, BUDGET_MS[event] ?? 1000) });
  const dirtyFile = path.join(rt, 'dirty', `${sessionId.replace(/[^A-Za-z0-9_-]/g, '_')}.json`);

  switch (event) {
    case 'post-tool-use': {
      // Local only: remember that files changed this turn. No network, no model call.
      let d = { count: 0, tools: [] as string[], firstAt: new Date().toISOString(), lastAt: '' };
      try { d = JSON.parse(fs.readFileSync(dirtyFile, 'utf8')); } catch { /* none yet */ }
      d.count++; d.lastAt = new Date().toISOString();
      const file = input.tool_input?.file_path ? path.basename(String(input.tool_input.file_path)) : '';
      if (file && !d.tools.includes(file)) d.tools = [...d.tools, file].slice(-10);
      writeAtomic(dirtyFile, JSON.stringify(d));
      return;
    }
    case 'session-start': {
      recordSessionPid(sessionId, input.cwd ?? '', rt);
      const { repo, worktree } = resolveProject(input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd());
      const d0 = await drain(outbox, httpSender(url, 1500), 1000).catch(() => null);
      let ctx: any = null;
      let offline = '';
      try {
        ctx = await client.post('/api/sessions/start', { sessionId, cwd: input.cwd ?? '', repo, worktree, source: input.source ?? '' });
        health(rt, { lastError: null, online: true });
      } catch (e) {
        offline = (e as Error).message;
        if (e instanceof ServiceUnavailable) outbox.enqueue({ opId: `start-${sessionId}-${Date.now()}`, method: 'POST', path: '/api/sessions/start', body: { sessionId, cwd: input.cwd ?? '', repo, worktree, source: input.source ?? '' }, client: 'hook' });
        health(rt, { lastError: offline, online: false, lastOfflineAt: new Date().toISOString() });
      }
      const lines = [`Personal AI Kanban: Claude session id is "${sessionId}" (repo "${repo}"). Board: ${url}.`];
      if (offline) {
        lines.push(`The board service is currently unreachable (${offline}). Checkpoints will be queued locally and applied when it returns; ${outbox.counts().pending} update(s) are pending. Do not tell the user the board was updated until a tool result says acknowledged: true.`);
      } else if (ctx.currentTask) {
        const t = ctx.currentTask;
        lines.push(`Current task ${t.id} "${t.title}" [${t.status}], revision ${t.revision}.`, `Summary: ${t.summary || '(none)'}`, `Next action: ${t.nextAction || '(none)'}`);
        if (t.completionConditions?.length) lines.push(`Completion conditions: ${t.completionConditions.join('; ')}`);
        if (t.latestFindings?.length) lines.push(`Latest finding: ${t.latestFindings.at(-1).text}`);
        lines.push('Re-read it with get_task before editing; record_checkpoint after meaningful progress.');
      } else {
        const c = (ctx.candidatesInRepo ?? []).slice(0, 6).map((t: any) => `${t.id} "${t.title}" [${t.status}]`);
        lines.push(c.length ? `No task linked to this session yet. Open tasks in this repo: ${c.join(', ')}. When the user's request matches one, call link_session with it as currentTaskId (ask once if several plausibly match). New commitments: create_task.` : 'No tasks linked yet. When the user states a commitment, create_task and link_session.');
      }
      if (d0?.applied) lines.push(`(${d0.applied} queued update(s) were just delivered to the board.)`);
      out({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: lines.join('\n') } });
      return;
    }
    case 'stop': {
      const d = await drain(outbox, httpSender(url, 1500), 1500).catch(() => null);
      let dirty: { count: number; tools: string[]; firstAt: string; lastAt: string } | null = null;
      try { dirty = JSON.parse(fs.readFileSync(dirtyFile, 'utf8')); } catch { /* clean turn */ }
      let hb: any = null;
      let ctx: any = null;
      try {
        hb = await client.post(`/api/sessions/${encodeURIComponent(sessionId)}/heartbeat`, {}); // sync heartbeat — not meaningful progress
        ctx = await client.get(`/api/sessions/${encodeURIComponent(sessionId)}/context`);
        health(rt, { lastError: null, online: true });
      } catch (e) {
        health(rt, { lastError: (e as Error).message, online: false, lastOfflineAt: new Date().toISOString() });
        const pending = outbox.counts().pending;
        if (pending) out({ systemMessage: `Kanban board offline: ${pending} update(s) queued locally; they will be applied when the board service returns.` });
        return;
      }
      const lastCp = hb?.lastCheckpointAt ?? null;
      const needsCheckpoint = dirty && (!lastCp || lastCp < dirty.lastAt);
      if (input.stop_hook_active || !needsCheckpoint) {
        if (dirty && !needsCheckpoint) fs.rmSync(dirtyFile, { force: true });
        if (d?.applied) out({ systemMessage: `Kanban: delivered ${d.applied} queued update(s).` });
        return;
      }
      fs.rmSync(dirtyFile, { force: true }); // nudge at most once per batch of edits
      const target = ctx?.currentTask ? `task ${ctx.currentTask.id} "${ctx.currentTask.title}"` : null;
      const msg = target
        ? `Kanban board check: ${dirty!.count} file edit(s) this turn (${dirty!.tools.join(', ') || 'files'}) and no board checkpoint since. If this was meaningful progress, a blocker or a new finding for ${target}, call record_checkpoint now with a concise summary, nextAction and findings. If it was not meaningful, do nothing. Ending this response does not make the task done.`
        : `Kanban board check: ${dirty!.count} file edit(s) this turn, but this session is not linked to a task. If this work belongs to a task, call get_session_context and link_session (ask the user once if it is unclear which task), then record_checkpoint. If it is not tracked work, do nothing.`;
      out({ hookSpecificOutput: { hookEventName: 'Stop', additionalContext: msg } });
      return;
    }
    case 'session-end': {
      // Best effort. Never changes task status; the last confirmed checkpoint stays what it was.
      try {
        await sendOrQueue(client, outbox, 'POST', `/api/sessions/${encodeURIComponent(sessionId)}/end`, { opId: `end-${sessionId}-${Date.now()}`, reason: String(input.reason ?? 'other') });
      } catch { /* validation errors are irrelevant at exit */ }
      fs.rmSync(dirtyFile, { force: true });
      try { fs.rmSync(path.join(rt, 'claude-pid', `${process.ppid}.json`), { force: true }); } catch { /* ignore */ }
      health(rt, {});
      return;
    }
    default:
      process.stderr.write(`kanban hook: unknown event ${event}\n`);
  }
}

const budget = BUDGET_MS[event] ?? 2000;
const killer = setTimeout(() => process.exit(0), budget + 500);
killer.unref();
main().catch((e) => { process.stderr.write(`kanban hook error: ${(e as Error).message}\n`); }).finally(() => { clearTimeout(killer); });
