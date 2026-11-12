// Acceptance: Persistent round trip — create via MCP client, view/edit in the UI (real browser), restart, read via MCP.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browser, ensureUiBuilt, mcpClient, startSvc, tmpDir, ui, uuid } from './helpers.ts';

test('persistent round trip: MCP create → UI view/edit → restart → MCP read', async (t) => {
  ensureUiBuilt();
  const dir = tmpDir();
  let svc = await startSvc(dir);
  const mcp = await mcpClient(svc.url);
  const tools = (await mcp.client.listTools()).tools.map((x) => x.name);
  for (const n of ['find_tasks', 'get_task', 'create_task', 'edit_task']) assert.ok(tools.includes(n), `tool ${n} present`);

  const created = await mcp.call('create_task', { opId: uuid(), title: 'Export feature for Friday demo', project: 'acme-app', status: 'ready', completionConditions: ['CSV export works for large accounts'] });
  assert.equal(created.isError, false, JSON.stringify(created.data));
  const id = created.data.task.id as string;
  await mcp.close();

  const br = await browser();
  if (br) {
    const page = await br.newPage();
    await page.goto(svc.url);
    const card = page.locator(`[data-task-id="${id}"]`);
    await card.waitFor({ timeout: 10000 });
    assert.match(await card.innerText(), /Export feature for Friday demo/);
    await card.click();
    const next = page.getByLabel('Next action');
    await next.fill('Fix pagination, then connect the frontend');
    await page.getByRole('button', { name: /Save/ }).click();
    await page.getByText('Saved').waitFor({ timeout: 5000 });
    await br.close();
  } else {
    t.diagnostic('No Chrome found; editing via the UI HTTP API with a browser Origin instead');
    const c = await ui(svc.url, 'GET', `/api/tasks/${id}`);
    const r = await ui(svc.url, 'PATCH', `/api/tasks/${id}`, { opId: uuid(), expectedRevision: c.json.task.revision, patch: { nextAction: 'Fix pagination, then connect the frontend' } });
    assert.equal(r.status, 200);
  }

  await svc.stop();
  svc = await startSvc(dir); // restart on the same data dir
  const mcp2 = await mcpClient(svc.url);
  const got = await mcp2.call('get_task', { taskId: id });
  assert.equal(got.isError, false);
  assert.equal(got.data.task.nextAction, 'Fix pagination, then connect the frontend');
  assert.equal(got.data.task.title, 'Export feature for Friday demo');
  assert.deepEqual(got.data.task.completionConditions, ['CSV export works for large accounts']);
  const found = await mcp2.call('find_tasks', { project: 'acme-app', text: 'export' });
  assert.equal(found.data.count, 1);
  assert.ok(got.data.recentActivity.some((a: any) => a.actor === 'user' && /Next action/.test(a.summary)), 'UI edit recorded in activity as user');
  await mcp2.close();
  await svc.stop();
});

test('MCP writes validate inputs and reject missing targets / invalid transitions', async () => {
  const svc = await startSvc(tmpDir());
  const mcp = await mcpClient(svc.url);
  const missing = await mcp.call('edit_task', { taskId: 'T-999', opId: uuid(), expectedRevision: 1, changes: { summary: 'x' } });
  assert.equal(missing.isError, true);
  assert.match(missing.data.error, /not_found/);
  const c = await mcp.call('create_task', { opId: uuid(), title: 'Research note' });
  const id = c.data.task.id;
  const bad = await mcp.call('edit_task', { taskId: id, opId: uuid(), expectedRevision: 1, changes: { status: 'waiting' } });
  assert.equal(bad.isError, true);
  assert.match(bad.data.error, /waitingReason/);
  const done = await mcp.call('edit_task', { taskId: id, opId: uuid(), expectedRevision: 1, changes: { status: 'done' } });
  assert.equal(done.isError, true);
  assert.match(done.data.error, /completion conditions/);
  const badDate = await mcp.call('edit_task', { taskId: id, opId: uuid(), expectedRevision: 1, changes: { deadline: 'next friday' } });
  assert.equal(badDate.isError, true);
  await mcp.close();
  await svc.stop();
});
