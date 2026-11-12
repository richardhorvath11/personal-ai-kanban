// Acceptance: Priority control, Waiting and freshness, Correction and undo (API level).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, mcpClient, startSvc, tmpDir, ui, uuid } from './helpers.ts';
import { todayIn } from '../src/core/dates.ts';

const plusDays = (n: number) => new Date(Date.now() + n * 86400_000).toISOString();

async function seedExportScenario(url: string) {
  const m = await mcpClient(url, { KANBAN_SESSION_ID: 'prio' });
  const fri = await m.call('resolve_date', { text: 'Friday' });
  assert.equal(fri.data.ok, true);
  const apiT = (await m.call('create_task', { opId: uuid(), title: 'Export API', project: 'acme', status: 'in_progress', completionConditions: ['Endpoint paginates large exports'] })).data.task.id;
  const fe = (await m.call('create_task', { opId: uuid(), title: 'Export frontend', project: 'acme', status: 'ready', dependsOn: [apiT], deadline: fri.data.value, deadlineKind: 'firm', deadlineLabel: "Friday's demo" })).data.task.id;
  const inv = (await m.call('create_task', { opId: uuid(), title: 'Investigate intermittent test failures', project: 'acme', status: 'inbox' })).data.task.id;
  return { m, apiT, fe, inv, friday: fri.data.value as string };
}

test('priority control: pins persist and come first; recommendations explain deadlines/dependencies; conflicts flagged', async () => {
  const dir = tmpDir();
  let svc = await startSvc(dir);
  const { m, apiT, fe, inv } = await seedExportScenario(svc.url);
  let next = (await m.call('get_next_work', {})).data;
  assert.equal(next.recommendations[0].task.id, apiT);
  assert.match(next.recommendations[0].headline, /Finish "Export API": it unblocks "Export frontend" needed for Friday's demo/);
  assert.ok(next.recommendations[0].reasons.some((r: string) => /Unblocks T-\d+ "Export frontend", needed for Friday's demo, due \w{3} \d{4}-\d{2}-\d{2} \((in \d+ days|tomorrow|today)\)/.test(r)));
  assert.ok(next.blocked.some((b: any) => b.task.id === fe && /Blocked by/.test(b.reason)), 'blocked work visible but not executable');
  assert.ok(!next.recommendations.some((r: any) => r.task.id === inv), 'inbox items are not committed work');
  // User pins an unrelated task (UI, browser origin).
  const pinT = (await ui(svc.url, 'POST', '/api/tasks', { opId: uuid(), title: 'Refactor billing (my call)', project: 'acme', status: 'ready' })).json.task;
  await ui(svc.url, 'PATCH', `/api/tasks/${pinT.id}`, { opId: uuid(), expectedRevision: pinT.revision, patch: { pinned: true } });
  await svc.stop();
  svc = await startSvc(dir); // pin persists across restart
  const m2 = await mcpClient(svc.url);
  next = (await m2.call('get_next_work', {})).data;
  assert.equal(next.recommendations[0].task.id, pinT.id, 'pinned task stays first');
  assert.equal(next.recommendations[0].task.pinned, true);
  assert.match(next.recommendations[0].reasons[0], /Pinned by you/);
  assert.equal(next.recommendations[1].task.id, apiT);
  assert.ok(next.conflicts.some((c: any) => c.taskId === fe && /pinned .*Refactor billing.*ordered ahead of this firm commitment/.test(c.message) && /pin is kept/.test(c.message)));
  // Dependency completes → frontend becomes executable and is re-evaluated.
  const cur = (await m2.call('get_task', { taskId: apiT })).data.task;
  await m2.call('edit_task', { taskId: apiT, opId: uuid(), expectedRevision: cur.revision, changes: { status: 'done' }, completionEvidence: 'Pagination tests green for 1M rows' });
  next = (await m2.call('get_next_work', {})).data;
  const feRec = next.recommendations.find((r: any) => r.task.id === fe);
  assert.ok(feRec, 'frontend now recommended');
  assert.match(feRec.headline, /Start "Export frontend": due .* for Friday's demo/);
  // Relative deadlines: ambiguous wording asks instead of inventing a commitment.
  const amb = (await m2.call('resolve_date', { text: 'next friday' })).data;
  assert.equal(amb.ok, false);
  assert.match(amb.question, /mean/);
  await m.close(); await m2.close();
  await svc.stop();
});

test('insufficient context is stated plainly', async () => {
  const svc = await startSvc(tmpDir());
  await api(svc.url, 'POST', '/api/tasks', { opId: uuid(), title: 'A', status: 'ready' });
  await api(svc.url, 'POST', '/api/tasks', { opId: uuid(), title: 'B', status: 'ready' });
  const next = (await api(svc.url, 'GET', '/api/next')).json;
  assert.match(next.note, /Not enough context/);
  assert.deepEqual(next.recommendations.map((r: any) => r.task.title), ['A', 'B']);
  await svc.stop();
});

test('waiting and freshness: due follow-ups and neglected work surface; heartbeats are not progress; blocked work not recommended', async () => {
  const svc = await startSvc(tmpDir());
  const u = svc.url;
  const w = (await api(u, 'POST', '/api/tasks', { opId: uuid(), title: 'Vendor quote', status: 'waiting', waitingReason: 'Waiting for vendor quote', waitingOn: 'person', followUpAt: todayIn('America/Chicago') })).json.task;
  const ip = (await api(u, 'POST', '/api/tasks', { opId: uuid(), title: 'Long refactor', status: 'in_progress' })).json.task;
  const att = (await ui(u, 'GET', '/api/attention')).json;
  const fu = att.items.find((i: any) => i.taskId === w.id && i.kind === 'followup_due');
  assert.ok(fu, 'due follow-up surfaces');
  assert.match(fu.message, /nothing is sent to anyone automatically/);
  // Polling/heartbeats from a linked session must not make the task look active.
  await api(u, 'POST', '/api/sessions/link', { opId: uuid(), sessionId: 'poller', currentTaskId: ip.id }, 'mcp');
  const before = (await api(u, 'GET', `/api/tasks/${ip.id}`)).json.task;
  for (let i = 0; i < 3; i++) await api(u, 'POST', '/api/sessions/poller/heartbeat', {}, 'hook');
  const afterHb = (await api(u, 'GET', `/api/tasks/${ip.id}`)).json.task;
  assert.equal(afterHb.lastMeaningfulAt, before.lastMeaningfulAt);
  assert.notEqual(afterHb.lastSyncedAt, before.lastSyncedAt);
  assert.equal(afterHb.revision, before.revision);
  const later = (await api(u, 'GET', `/api/attention?at=${encodeURIComponent(plusDays(5))}`)).json;
  const stale = later.items.find((i: any) => i.taskId === ip.id && i.kind === 'stale');
  assert.ok(stale, 'neglected in-progress work surfaces after the freshness threshold');
  assert.match(stale.message, /does not count as progress/);
  // Time passing alone does not resolve an external blocker.
  const blockedLater = later.items.find((i: any) => i.taskId === w.id && i.kind === 'blocked');
  assert.ok(blockedLater);
  const next = (await api(u, 'GET', `/api/next?at=${encodeURIComponent(plusDays(10))}`)).json;
  assert.ok(!next.recommendations.some((r: any) => r.task.id === w.id));
  assert.ok(next.blocked.some((b: any) => b.task.id === w.id));
  // Repeats consolidate; snooze hides.
  await api(u, 'POST', '/api/review/run', {}); await api(u, 'POST', '/api/review/run', {});
  const again = (await ui(u, 'GET', '/api/attention')).json;
  const fu2 = again.items.filter((i: any) => i.taskId === w.id && i.kind === 'followup_due');
  assert.equal(fu2.length, 1);
  assert.ok(fu2[0].count >= 2, 'consolidated repeat');
  const sn = await ui(u, 'POST', `/api/alerts/${fu2[0].id}/snooze`, { hours: 24 });
  assert.equal(sn.status, 200);
  const snoozed = (await ui(u, 'GET', '/api/attention')).json;
  assert.ok(!snoozed.items.some((i: any) => i.id === fu2[0].id));
  assert.equal(snoozed.snoozed, 1);
  // A dependency-waiting task returns to Ready when its dependency completes.
  const dep = (await api(u, 'POST', '/api/tasks', { opId: uuid(), title: 'Dep', status: 'in_progress' })).json.task;
  const wd = (await api(u, 'POST', '/api/tasks', { opId: uuid(), title: 'After dep', status: 'waiting', waitingReason: 'needs Dep', waitingOn: 'dependency', dependsOn: [dep.id] })).json.task;
  await ui(u, 'PATCH', `/api/tasks/${dep.id}`, { opId: uuid(), expectedRevision: dep.revision, patch: { status: 'done' }, confirmDone: true });
  const wd2 = (await api(u, 'GET', `/api/tasks/${wd.id}`)).json;
  assert.equal(wd2.task.status, 'ready');
  assert.match(wd2.recentActivity[0].summary, /dependency .* completed/);
  await svc.stop();
});

test('correction and undo: undo respects intervening edits', async () => {
  const svc = await startSvc(tmpDir());
  const u = svc.url;
  const t = (await ui(u, 'POST', '/api/tasks', { opId: uuid(), title: 'Undo me', status: 'ready', nextAction: 'Plan A', summary: 's0' })).json.task;
  const e1 = (await ui(u, 'PATCH', `/api/tasks/${t.id}`, { opId: uuid(), expectedRevision: t.revision, patch: { nextAction: 'Plan B (mistake)', status: 'in_progress' } })).json;
  const e2 = (await ui(u, 'PATCH', `/api/tasks/${t.id}`, { opId: uuid(), expectedRevision: e1.task.revision, patch: { summary: 'Real progress' } })).json;
  const act = (await ui(u, 'GET', `/api/tasks/${t.id}?recent=20`)).json.recentActivity;
  const mistake = act.find((a: any) => /Plan B/.test(a.summary));
  const r = await ui(u, 'POST', `/api/tasks/${t.id}/undo`, { opId: uuid(), activityId: mistake.id });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.task.nextAction, 'Plan A');
  assert.equal(r.json.task.status, 'ready');
  assert.equal(r.json.task.summary, 'Real progress', 'intervening edit kept');
  // Field changed again later → that field is not clobbered.
  const t2 = r.json.task;
  const a1 = (await ui(u, 'PATCH', `/api/tasks/${t.id}`, { opId: uuid(), expectedRevision: t2.revision, patch: { title: 'Title v2', priority: 'high' } })).json;
  await ui(u, 'PATCH', `/api/tasks/${t.id}`, { opId: uuid(), expectedRevision: a1.task.revision, patch: { title: 'Title v3' } });
  const act2 = (await ui(u, 'GET', `/api/tasks/${t.id}?recent=20`)).json.recentActivity;
  const v2 = act2.find((a: any) => /Title v2/.test(a.summary));
  const r2 = (await ui(u, 'POST', `/api/tasks/${t.id}/undo`, { opId: uuid(), activityId: v2.id })).json;
  assert.equal(r2.task.title, 'Title v3');
  assert.equal(r2.task.priority, 'normal');
  assert.deepEqual(r2.skipped.map((s: any) => s.field), ['title']);
  // Undo a Claude checkpoint: its finding goes, the user's later finding stays.
  await api(u, 'POST', '/api/sessions/link', { opId: uuid(), sessionId: 'undo-s', currentTaskId: t.id }, 'mcp');
  const cp = (await api(u, 'POST', '/api/sessions/checkpoint', { opId: uuid(), sessionId: 'undo-s', summary: 'Wrong conclusion', findings: ['Bogus finding'] }, 'mcp')).json;
  await ui(u, 'PATCH', `/api/tasks/${t.id}`, { opId: uuid(), expectedRevision: cp.task.revision, patch: {}, addFindings: ['User finding'] });
  const r3 = (await ui(u, 'POST', `/api/tasks/${t.id}/undo`, { opId: uuid(), activityId: cp.activityId })).json;
  assert.deepEqual(r3.task.findings.map((f: any) => f.text), ['User finding']);
  assert.equal(r3.task.summary, 'Real progress');
  // Archive is recoverable.
  const arch = (await ui(u, 'PATCH', `/api/tasks/${t.id}`, { opId: uuid(), expectedRevision: r3.task.revision, patch: { archived: true } })).json;
  assert.equal(arch.task.archived, true);
  const act3 = (await ui(u, 'GET', `/api/tasks/${t.id}?recent=1`)).json.recentActivity;
  const r4 = (await ui(u, 'POST', `/api/tasks/${t.id}/undo`, { opId: uuid(), activityId: act3[0].id })).json;
  assert.equal(r4.task.archived, false);
  // Only the user may undo.
  const notUser = await api(u, 'POST', `/api/tasks/${t.id}/undo`, { opId: uuid(), activityId: act3[0].id }, 'mcp');
  assert.equal(notUser.status, 403);
  await svc.stop();
});
