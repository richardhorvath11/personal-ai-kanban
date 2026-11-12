// Acceptance: Local usability (keyboard workflows in a real browser, empty/error states, demo isolation)
// and Correction and undo through the UI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { api, browser, ensureUiBuilt, ROOT, startSvc, tmpDir, track, ui, uuid, waitFor, cleanEnv } from './helpers.ts';

test('keyboard workflows, empty and error states, undo in the UI', async (t) => {
  ensureUiBuilt();
  const br = await browser();
  if (!br) { t.skip('no Chrome/Chromium available'); return; }
  const svc = await startSvc(tmpDir());
  t.after(() => br.close().catch(() => {}));
  const page = await br.newPage();
  await page.goto(svc.url);
  await page.getByText('Your board is empty.').waitFor();
  // n → create dialog, type, Enter
  await page.keyboard.press('n');
  await page.getByRole('dialog', { name: 'New task' }).waitFor();
  await page.keyboard.type('Write release notes');
  await page.keyboard.press('Enter');
  await page.getByLabel(/Task T-1 detail/).waitFor();
  await page.keyboard.press('Escape');
  await page.getByLabel(/Task T-1 detail/).waitFor({ state: 'detached' });
  // focus card, Shift+→ moves Inbox → Ready
  const card = page.locator('[data-task-id="T-1"]');
  await card.focus();
  await page.keyboard.press('Shift+ArrowRight');
  await waitFor(async () => (await api(svc.url, 'GET', '/api/tasks/T-1')).json.task.status === 'ready');
  // Enter opens the detail; status select is the non-drag alternative
  await page.locator('[data-task-id="T-1"]').focus();
  await page.keyboard.press('Enter');
  const detail = page.getByLabel(/Task T-1 detail/);
  await detail.waitFor();
  await detail.getByLabel('Status').selectOption('in_progress');
  await detail.getByLabel('Next action').fill('Collect merged PRs');
  await page.keyboard.press('Control+Enter');
  await page.getByText('Saved').waitFor();
  let task = (await api(svc.url, 'GET', '/api/tasks/T-1')).json.task;
  assert.equal(task.status, 'in_progress');
  assert.equal(task.nextAction, 'Collect merged PRs');
  // A later, unrelated edit; then undo the earlier one from the activity history.
  await detail.getByLabel('New finding').fill('Changelog bot is broken');
  await detail.getByLabel('New finding').press('Enter');
  await page.getByText('Finding added').waitFor();
  const entry = detail.locator('.activity li', { hasText: 'Next action: "Collect merged PRs"' });
  await entry.getByRole('button', { name: 'Undo' }).click();
  await page.getByText(/^Undid #/).waitFor();
  task = (await api(svc.url, 'GET', '/api/tasks/T-1')).json.task;
  assert.equal(task.status, 'ready', 'undone');
  assert.equal(task.nextAction, '', 'undone');
  assert.equal(task.findings[0].text, 'Changelog bot is broken', 'intervening change preserved');
  await page.keyboard.press('Escape');
  // / focuses search; no-match empty state
  await page.keyboard.press('/');
  await page.keyboard.type('zzz-nothing');
  await page.getByText('No tasks match this filter.').waitFor();
  await page.getByLabel('Search tasks').fill('');
  await page.keyboard.press('Escape'); // leave the search box
  // Views by number keys
  await page.keyboard.press('2');
  await page.getByRole('heading', { name: 'What should I pick up next?' }).waitFor();
  await page.keyboard.press('3');
  await page.getByRole('heading', { name: 'Needs your attention' }).waitFor();
  await page.keyboard.press('1');
  // Error state when the service goes away
  await svc.stop();
  await page.getByText(/Board service unreachable/).waitFor({ timeout: 12000 });
});

test('demo data is isolated from real tasks', async (t) => {
  const realDir = tmpDir();
  const demoDir = tmpDir();
  const real = await startSvc(realDir);
  const r = await ui(real.url, 'POST', '/api/demo/seed', {});
  assert.equal(r.status, 403);
  assert.match(r.json.error.message, /only be seeded into the demo board/);
  assert.equal((await api(real.url, 'GET', '/api/tasks')).json.tasks.length, 0);
  await api(real.url, 'POST', '/api/tasks', { opId: uuid(), title: 'Real task' });
  await real.stop();
  const demo = await startSvc(demoDir, { args: ['--demo', '--seed-demo'] });
  const dt = (await api(demo.url, 'GET', '/api/tasks')).json.tasks;
  assert.ok(dt.length >= 4);
  assert.ok(!dt.some((x: any) => x.title === 'Real task'));
  const br = await browser();
  if (br) {
    const page = await br.newPage();
    await page.goto(demo.url);
    await page.getByText('DEMO DATA').waitFor();
    await br.close();
  } else t.diagnostic('no browser: skipped DEMO badge check');
  await demo.stop();
  // A real service refuses a demo database and vice versa.
  for (const [dir, extra] of [[demoDir, []], [realDir, ['--demo']]] as const) {
    const p = track(spawn(process.execPath, [path.join(ROOT, 'src/server/main.ts'), '--port', '0', '--data-dir', dir, ...extra], { env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'] }));
    let err = '';
    p.stderr!.on('data', (d) => (err += d));
    const code = await new Promise<number>((res) => p.on('exit', (c) => res(c ?? -1)));
    assert.notEqual(code, 0);
    assert.match(err, /Refusing to open (real|demo) service on a (demo|real) database/);
  }
});
