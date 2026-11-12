// Acceptance (fixture-based hook checks, NOT a live Claude Code run): Automatic checkpoint (hook side),
// Safe completion, Retry after outage, Concurrent updates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { api, freePort, mcpClient, runHook, startSvc, tmpDir, uuid, waitFor } from './helpers.ts';
import { Outbox } from '../src/core/outbox.ts';

test('[fixture] hooks: SessionStart loads context, edits + Stop nudge a checkpoint once, no nudge after checkpoint', async () => {
  const dir = tmpDir();
  const svc = await startSvc(dir);
  const o = { url: svc.url, dataDir: dir };
  const sid = 'fixture-session-1';
  const mcp = await mcpClient(svc.url, { KANBAN_SESSION_ID: sid, KANBAN_DATA_DIR: dir });
  const id = (await mcp.call('create_task', { opId: uuid(), title: 'Export API', project: 'personal-ai-kanban', status: 'in_progress', completionConditions: ['tests pass'] })).data.task.id;

  const start = await runHook('session-start', { session_id: sid, cwd: process.cwd(), source: 'startup' }, o);
  assert.equal(start.code, 0, start.err);
  const ctxText = start.json.hookSpecificOutput.additionalContext as string;
  assert.match(ctxText, new RegExp(`session id is "${sid}"`));
  assert.match(ctxText, new RegExp(`${id} "Export API"`), 'candidate offered, not linked');
  assert.ok(fs.existsSync(path.join(dir, 'runtime', 'claude-pid', `${process.pid}.json`)), 'pid → session map written for the MCP adapter');

  await mcp.call('link_session', { opId: uuid(), currentTaskId: id });
  // A clean turn (no edits) → Stop says nothing.
  const quiet = await runHook('stop', { session_id: sid, stop_hook_active: false, last_assistant_message: 'Sure.' }, o);
  assert.equal(quiet.out, '');
  // Edits, then Stop without a checkpoint → nudge Claude (additionalContext), once.
  await runHook('post-tool-use', { session_id: sid, tool_name: 'Edit', tool_input: { file_path: '/x/src/export.ts' } }, o);
  await runHook('post-tool-use', { session_id: sid, tool_name: 'Write', tool_input: { file_path: '/x/test/export.test.ts' } }, o);
  const nudge = await runHook('stop', { session_id: sid, stop_hook_active: false }, o);
  const msg = nudge.json.hookSpecificOutput.additionalContext as string;
  assert.equal(nudge.json.hookSpecificOutput.hookEventName, 'Stop');
  assert.match(msg, /2 file edit\(s\).*export\.ts, export\.test\.ts/);
  assert.match(msg, new RegExp(`record_checkpoint.*${id}|${id}.*record_checkpoint`));
  const again = await runHook('stop', { session_id: sid, stop_hook_active: true }, o);
  assert.equal(again.out, '', 'stop_hook_active → no loop');
  // Edits followed by a checkpoint in the same turn → no nudge.
  await runHook('post-tool-use', { session_id: sid, tool_name: 'Edit', tool_input: { file_path: '/x/a.ts' } }, o);
  await new Promise((r) => setTimeout(r, 5));
  const cp = await mcp.call('record_checkpoint', { opId: uuid(), summary: 'Export endpoint implemented' }); // adapter finds session via env
  assert.equal(cp.data.acknowledged, true);
  const after = await runHook('stop', { session_id: sid, stop_hook_active: false }, o);
  assert.equal(after.out, '');
  assert.ok(start.ms < 4000 && nudge.ms < 4000, 'hooks are bounded');
  await mcp.close();
  await svc.stop();
});

test('[fixture] safe completion: Stop / SessionEnd never mark Done; Done needs conditions + evidence', async () => {
  const dir = tmpDir();
  const svc = await startSvc(dir);
  const o = { url: svc.url, dataDir: dir };
  const sid = 'fixture-session-2';
  const mcp = await mcpClient(svc.url, { KANBAN_SESSION_ID: sid, KANBAN_DATA_DIR: dir });
  const id = (await mcp.call('create_task', { opId: uuid(), title: 'Ship export', status: 'in_progress', completionConditions: ['Deployed to staging', 'Demo accepted'] })).data.task.id;
  await mcp.call('link_session', { opId: uuid(), currentTaskId: id });
  await runHook('session-start', { session_id: sid, cwd: process.cwd(), source: 'startup' }, o);
  await runHook('post-tool-use', { session_id: sid, tool_name: 'Edit', tool_input: { file_path: 'a.ts' } }, o);
  await runHook('stop', { session_id: sid, stop_hook_active: false, last_assistant_message: 'All done! The feature is complete.' }, o);
  const end = await runHook('session-end', { session_id: sid, reason: 'prompt_input_exit' }, o);
  assert.equal(end.code, 0);
  let t = (await mcp.call('get_task', { taskId: id })).data;
  assert.equal(t.task.status, 'in_progress', 'response/session end did not change status');
  assert.ok(!t.recentActivity.some((a: any) => a.changes.some((c: any) => c.field === 'status')), 'no status change recorded');
  // A hook client can never change status, even if it tries directly.
  const hookTry = await api(svc.url, 'PATCH', `/api/tasks/${id}`, { opId: uuid(), patch: { status: 'done' } }, 'hook');
  assert.equal(hookTry.status, 422);
  // Claude without evidence → rejected; to Review is fine; with evidence → Done.
  const noEv = await mcp.call('record_checkpoint', { opId: uuid(), summary: 'Finished', status: 'done' });
  assert.equal(noEv.isError, true);
  assert.match(noEv.data.error, /completionEvidence/);
  const rev = await mcp.call('record_checkpoint', { opId: uuid(), summary: 'Output ready for inspection', status: 'review' });
  assert.equal(rev.data.task.status, 'review');
  const ok = await mcp.call('record_checkpoint', { opId: uuid(), summary: 'Deployed and accepted', status: 'done', completionEvidence: 'Staging deploy #42 green; user accepted demo in chat' });
  assert.equal(ok.data.task.status, 'done');
  // Session end on an unknown/ended session is harmless.
  await mcp.close();
  await svc.stop();
});

test('retry after outage: checkpoint queues while service is down, survives process exit, applies exactly once', async () => {
  const dir = tmpDir();
  const port = await freePort();
  let svc = await startSvc(dir, { port });
  const sid = 'outage-session';
  const setup = await mcpClient(svc.url, { KANBAN_SESSION_ID: sid, KANBAN_DATA_DIR: dir });
  const id = (await setup.call('create_task', { opId: uuid(), title: 'Large export', status: 'in_progress' })).data.task.id;
  await setup.call('link_session', { opId: uuid(), currentTaskId: id });
  await setup.close();
  await svc.stop(); // outage begins

  const url = `http://127.0.0.1:${port}`;
  const m = await mcpClient(url, { KANBAN_SESSION_ID: sid, KANBAN_DATA_DIR: dir });
  const opId = uuid();
  const q = await m.call('record_checkpoint', { opId, summary: 'Pagination fixed while board was down', findings: ['Use keyset pagination'] });
  assert.equal(q.isError, false);
  assert.equal(q.data.acknowledged, false, 'never reported as synced before acknowledgement');
  assert.equal(q.data.queued, true);
  await m.close(); // MCP adapter process exits
  const end = await runHook('session-end', { session_id: sid, reason: 'other' }, { url, dataDir: dir }); // hook process exits too
  assert.equal(end.code, 0);
  const ob = new Outbox(dir);
  assert.equal(ob.counts().pending, 2, 'both updates persisted on disk');
  const queued = ob.list().find((x) => x.opId === opId)!;

  svc = await startSvc(dir, { port }); // recovery: service drains on start-up
  await waitFor(async () => new Outbox(dir).counts().pending === 0);
  const ctx = (await api(svc.url, 'GET', `/api/tasks/${id}?recent=50`)).json;
  assert.equal(ctx.task.summary, 'Pagination fixed while board was down');
  assert.equal(ctx.task.findings.filter((f: any) => f.text === 'Use keyset pagination').length, 1);
  const cps = ctx.recentActivity.filter((a: any) => a.kind === 'checkpoint');
  assert.equal(cps.length, 1);
  // Duplicate delivery (e.g. crash between apply and ack) must not apply twice.
  ob.enqueue(queued);
  const retry = (await api(svc.url, 'POST', '/api/sync/retry', {})).json;
  assert.equal(retry.pending, 0);
  const ctx2 = (await api(svc.url, 'GET', `/api/tasks/${id}?recent=50`)).json;
  assert.equal(ctx2.recentActivity.filter((a: any) => a.kind === 'checkpoint').length, 1, 'no duplicate activity');
  assert.equal(ctx2.task.findings.length, 1, 'no duplicate finding');
  assert.equal(ctx2.task.revision, ctx.task.revision);
  // A queued update the service rejects is kept in failed/ and surfaced, not silently dropped.
  ob.enqueue({ opId: uuid(), method: 'POST', path: '/api/sessions/checkpoint', body: { sessionId: sid, taskId: 'T-999', summary: 'orphan' }, client: 'mcp' });
  await api(svc.url, 'POST', '/api/sync/retry', {});
  const health = (await api(svc.url, 'GET', '/api/health')).json;
  assert.equal(health.sync.failed, 1);
  assert.match(health.sync.lastError, /not_found/);
  const failed = (await api(svc.url, 'GET', '/api/sync/failed')).json.failed;
  assert.equal(failed[0].body.summary, 'orphan');
  await svc.stop();
});

test('concurrent updates: stale conflicting edits rejected with current revision; retries never duplicate', async () => {
  const svc = await startSvc(tmpDir());
  const A = await mcpClient(svc.url, { KANBAN_SESSION_ID: 'c-A' });
  const B = await mcpClient(svc.url, { KANBAN_SESSION_ID: 'c-B' });
  const createOp = uuid();
  const c1 = await A.call('create_task', { opId: createOp, title: 'Concurrency', status: 'ready' });
  const c2 = await A.call('create_task', { opId: createOp, title: 'Concurrency', status: 'ready' });
  assert.equal(c2.data.duplicate, true);
  assert.equal(c1.data.task.id, c2.data.task.id);
  assert.equal((await A.call('find_tasks', { text: 'Concurrency' })).data.count, 1, 'retry created no duplicate card');
  const id = c1.data.task.id;
  const base = (await A.call('get_task', { taskId: id })).data.task.revision;
  const e1 = await A.call('edit_task', { taskId: id, opId: uuid(), expectedRevision: base, changes: { nextAction: 'A plan' } });
  assert.equal(e1.isError, false);
  const stale = await B.call('edit_task', { taskId: id, opId: uuid(), expectedRevision: base, changes: { nextAction: 'B plan' } });
  assert.equal(stale.isError, true);
  assert.match(stale.data.error, /conflict/);
  assert.equal(stale.data.details.currentRevision, e1.data.revision);
  assert.deepEqual(stale.data.details.conflictingFields, ['nextAction']);
  const merged = await B.call('edit_task', { taskId: id, opId: uuid(), expectedRevision: base, changes: { outcome: 'Fast exports' } });
  assert.equal(merged.isError, false, 'stale but non-overlapping edit merges');
  const t = (await A.call('get_task', { taskId: id })).data.task;
  assert.equal(t.nextAction, 'A plan');
  assert.equal(t.outcome, 'Fast exports');
  // Same checkpoint opId twice → one activity entry.
  await A.call('link_session', { opId: uuid(), currentTaskId: id });
  const op = uuid();
  const k1 = await A.call('record_checkpoint', { opId: op, summary: 'Halfway', findings: ['f1'] });
  const k2 = await A.call('record_checkpoint', { opId: op, summary: 'Halfway', findings: ['f1'] });
  assert.equal(k2.data.duplicate, true);
  assert.equal(k1.data.task.revision, k2.data.task.revision);
  const ctx = (await A.call('get_task', { taskId: id, recent: 50 })).data;
  assert.equal(ctx.recentActivity.filter((a: any) => a.kind === 'checkpoint').length, 1);
  assert.equal(ctx.task.findings.length, 1);
  await A.close(); await B.close();
  await svc.stop();
});
