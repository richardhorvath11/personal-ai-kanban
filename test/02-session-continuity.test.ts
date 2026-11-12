// Acceptance: Resume work, Task switching (MCP part), findings isolation, project-scoped installer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mcpClient, startSvc, tmpDir, uuid } from './helpers.ts';
import { install, uninstall, MARK_START } from '../src/cli/install.ts';

test('resume: a second session retrieves task, latest finding, completion conditions and next action', async () => {
  const dir = tmpDir();
  let svc = await startSvc(dir);
  const a = await mcpClient(svc.url, { KANBAN_SESSION_ID: 'session-A' });
  const c = await a.call('create_task', { opId: uuid(), title: 'Export feature', project: 'acme-app', status: 'in_progress', completionConditions: ['Large exports paginate', 'Frontend wired'] });
  const id = c.data.task.id;
  const link = await a.call('link_session', { opId: uuid(), currentTaskId: id, repo: 'acme-app' });
  assert.equal(link.isError, false, JSON.stringify(link.data));
  assert.equal(link.data.session.currentTaskId, id);
  const cp = await a.call('record_checkpoint', {
    opId: uuid(), summary: 'API implementation complete. Integration tests passing. Large-export pagination is unresolved.',
    nextAction: 'Fix pagination, then connect the frontend', findings: ['Pagination breaks above 10k rows'],
  });
  assert.equal(cp.isError, false, JSON.stringify(cp.data));
  assert.equal(cp.data.task.id, id);
  await a.close();
  await svc.stop();

  svc = await startSvc(dir); // the next session may happen after a restart
  const b = await mcpClient(svc.url, { KANBAN_SESSION_ID: 'session-B' });
  const ctxB = await b.call('get_session_context', { repo: 'acme-app' });
  assert.equal(ctxB.data.currentTask, null, 'new session has no current task until linked');
  assert.ok(ctxB.data.candidatesInRepo.some((t: any) => t.id === id), 'task offered as a candidate, not auto-linked');
  await b.call('link_session', { opId: uuid(), currentTaskId: id });
  const ctx2 = await b.call('get_session_context', {});
  const cur = ctx2.data.currentTask;
  assert.equal(cur.id, id);
  assert.equal(cur.nextAction, 'Fix pagination, then connect the frontend');
  assert.deepEqual(cur.completionConditions, ['Large exports paginate', 'Frontend wired']);
  assert.equal(cur.latestFindings.at(-1).text, 'Pagination breaks above 10k rows');
  assert.equal(cur.latestFindings.at(-1).sessionId, 'session-A');
  assert.match(cur.summary, /pagination is unresolved/);

  // Session B adds its own finding; A's finding must survive.
  await b.call('record_checkpoint', { opId: uuid(), summary: 'Pagination fixed with cursor paging', findings: ['Cursor paging needs index on created_at'] });
  const t = await b.call('get_task', { taskId: id });
  const texts = t.data.task.findings.map((f: any) => `${f.sessionId}:${f.text}`);
  assert.ok(texts.includes('session-A:Pagination breaks above 10k rows'));
  assert.ok(texts.includes('session-B:Cursor paging needs index on created_at'));
  await b.close();
  await svc.stop();
});

test('task switching directs subsequent checkpoints to the correct card; ambiguity is reported, not guessed', async () => {
  const svc = await startSvc(tmpDir());
  const m = await mcpClient(svc.url, { KANBAN_SESSION_ID: 'session-S' });
  const t1 = (await m.call('create_task', { opId: uuid(), title: 'Export API', project: 'p', status: 'ready' })).data.task.id;
  const t2 = (await m.call('create_task', { opId: uuid(), title: 'Export API docs', project: 'p', status: 'ready' })).data.task.id;
  await m.call('link_session', { opId: uuid(), taskIds: [t1, t2], currentTaskId: t1 });
  await m.call('record_checkpoint', { opId: uuid(), summary: 'Endpoint scaffolded' });
  const sw = await m.call('link_session', { opId: uuid(), currentTaskId: t2 });
  assert.equal(sw.data.session.switchedFrom, t1);
  await m.call('record_checkpoint', { opId: uuid(), summary: 'Docs outline written', nextAction: 'Add examples' });
  const a = (await m.call('get_task', { taskId: t1 })).data.task;
  const b = (await m.call('get_task', { taskId: t2 })).data.task;
  assert.equal(a.summary, 'Endpoint scaffolded');
  assert.equal(b.summary, 'Docs outline written');
  assert.equal(b.nextAction, 'Add examples');

  // Clear current with two linked tasks → checkpoint must not guess.
  await m.call('link_session', { opId: uuid(), currentTaskId: null });
  const amb = await m.call('record_checkpoint', { opId: uuid(), summary: 'Something' });
  assert.equal(amb.isError, true);
  assert.match(amb.data.error, /ambiguous_target/);
  assert.equal(amb.data.details.candidates.length, 2);
  // A fresh session with no links gets told to link/create, also no guessing by repo.
  const other = await mcpClient(svc.url, { KANBAN_SESSION_ID: 'session-T' });
  const none = await other.call('record_checkpoint', { opId: uuid(), summary: 'x' });
  assert.equal(none.isError, true);
  assert.match(none.data.error, /not linked to any task/);
  await other.close();
  await m.close();
  await svc.stop();
});

test('installer merges into project config, preserves existing settings, and uninstalls cleanly', () => {
  const proj = tmpDir('kanban-proj-');
  fs.mkdirSync(path.join(proj, '.claude'));
  const otherHook = { type: 'command', command: '/usr/local/bin/other-hook' };
  fs.writeFileSync(path.join(proj, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(ls:*)'] }, hooks: { Stop: [{ hooks: [otherHook] }] } }));
  fs.writeFileSync(path.join(proj, '.mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
  fs.writeFileSync(path.join(proj, 'CLAUDE.md'), '# My project\n\nExisting rules.\n');
  install(proj, { url: 'http://127.0.0.1:4999', dataDir: path.join(proj, 'data') });
  install(proj, { url: 'http://127.0.0.1:4999', dataDir: path.join(proj, 'data') }); // idempotent re-install
  const mcp = JSON.parse(fs.readFileSync(path.join(proj, '.mcp.json'), 'utf8'));
  assert.ok(mcp.mcpServers.other && mcp.mcpServers.kanban);
  assert.equal(mcp.mcpServers.kanban.env.KANBAN_URL, 'http://127.0.0.1:4999');
  const settings = JSON.parse(fs.readFileSync(path.join(proj, '.claude', 'settings.json'), 'utf8'));
  assert.deepEqual(settings.permissions, { allow: ['Bash(ls:*)'] });
  assert.ok(JSON.stringify(settings.hooks.Stop).includes('/usr/local/bin/other-hook'), 'existing hook preserved');
  const md = fs.readFileSync(path.join(proj, 'CLAUDE.md'), 'utf8');
  assert.ok(md.startsWith('# My project'));
  assert.equal(md.split(MARK_START).length, 2, 'block present exactly once');
  uninstall(proj);
  const mcp2 = JSON.parse(fs.readFileSync(path.join(proj, '.mcp.json'), 'utf8'));
  assert.deepEqual(mcp2, { mcpServers: { other: { command: 'x' } } });
  const s2 = JSON.parse(fs.readFileSync(path.join(proj, '.claude', 'settings.json'), 'utf8'));
  assert.deepEqual(s2, { permissions: { allow: ['Bash(ls:*)'] }, hooks: { Stop: [{ hooks: [otherHook] }] } });
  assert.equal(fs.readFileSync(path.join(proj, 'CLAUDE.md'), 'utf8').trim(), '# My project\n\nExisting rules.');
});
