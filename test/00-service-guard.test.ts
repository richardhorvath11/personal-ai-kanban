// Local-only service: loopback binding, Host/Origin guard, migrations, export.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { api, rawRequest, startSvc, tmpDir, uuid } from './helpers.ts';

test('binds loopback only and guards browser-facing mutations', async () => {
  const dir = tmpDir();
  const svc = await startSvc(dir);
  assert.match(svc.url, /^http:\/\/127\.0\.0\.1:/);
  const body = JSON.stringify({ opId: uuid(), title: 'x' });
  const evil = await fetch(svc.url + '/api/tasks', { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body });
  assert.equal(evil.status, 403);
  const noClient = await fetch(svc.url + '/api/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  assert.equal(noClient.status, 403, 'non-browser mutation without x-kanban-client rejected');
  const form = await fetch(svc.url + '/api/tasks', { method: 'POST', headers: { origin: svc.url, 'content-type': 'text/plain' }, body });
  assert.equal(form.status, 403, 'simple (non-JSON) cross-site style request rejected');
  assert.equal(await rawRequest(svc.url, '/api/tasks', { host: 'attacker.example' }), 403, 'unexpected Host (DNS rebinding) rejected');
  assert.equal(await rawRequest(svc.url, '/api/tasks', { host: `127.0.0.1:${svc.port}` }), 200);
  const okReq = await api(svc.url, 'POST', '/api/tasks', { opId: uuid(), title: 'allowed' });
  assert.equal(okReq.status, 200);
  const exp = await api(svc.url, 'GET', '/api/export');
  assert.equal(exp.json.format, 'personal-ai-kanban/v1');
  assert.equal(exp.json.tasksResolved.length, 1);
  await svc.stop();
  const db = new DatabaseSync(path.join(dir, 'kanban.db'));
  const versions = (db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as { version: number }[]).map((r) => r.version);
  assert.ok(versions.length >= 1 && versions[0] === 1, 'migrations recorded');
  db.close();
});
