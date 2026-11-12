// Global (user-scope) install: merge into a TEMP HOME that already has hooks/settings/CLAUDE.md/.claude.json,
// idempotency, exact restore on uninstall, and hooks/MCP run from an arbitrary project with no kanban files.
// Never touches the real ~/.claude or ~/.claude.json: every run uses a temp HOME and explicit paths.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ROOT, api, cleanEnv, startSvc, tmpDir, track, uuid } from './helpers.ts';
import { GLOBAL_START } from '../src/cli/install-global.ts';
import { findClaude } from '../src/cli/install-global.ts';

const REAL_HOME = process.env.HOME!;
const CONTROL_HOOK = { type: 'command', command: '/home/box/.control-hook/bin/control-session-hook', timeout: 5 };

/** A fake home that looks like a real one: Control-style Stop/SessionEnd hooks, other settings, a CLAUDE.md, a .claude.json. */
function fakeHome(opts: { claudeJson?: string } = {}) {
  const home = tmpDir('kanban-home-');
  assert.notEqual(path.resolve(home), path.resolve(REAL_HOME));
  fs.mkdirSync(path.join(home, '.claude'));
  // deliberately not in JSON.stringify(…, 2) layout, so a byte-identical restore proves we kept the original bytes
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), `{"enabledPlugins":{"slack@claude-plugins-official":true},"theme":"dark",\n "hooks":{"Stop":[{"hooks":[${JSON.stringify(CONTROL_HOOK)}]}],"SessionEnd":[{"hooks":[${JSON.stringify(CONTROL_HOOK)}]}],"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"/usr/local/bin/guard"}]}]}}`);
  fs.writeFileSync(path.join(home, '.claude', 'CLAUDE.md'), '# My global rules\n\nAlways run the tests.\n');
  fs.writeFileSync(path.join(home, '.claude.json'), opts.claudeJson ?? '{\n  "numStartups": 7,\n  "projects": {},\n  "mcpServers": {\n    "other": {\n      "type": "stdio",\n      "command": "other-server"\n    }\n  }\n}');
  const snap = () => Object.fromEntries(['.claude/settings.json', '.claude/CLAUDE.md', '.claude.json'].map((f) => [f, fs.existsSync(path.join(home, f)) ? fs.readFileSync(path.join(home, f), 'utf8') : null]));
  return { home, before: snap(), snap };
}

/** Run the real CLI with HOME pointed at the fake home and every config-dir override removed. */
function cli(home: string, args: string[], extraEnv: Record<string, string> = {}) {
  const env: Record<string, string> = { ...cleanEnv(), HOME: home, ...extraEnv };
  delete env.XDG_DATA_HOME; delete env.CLAUDE_CONFIG_DIR; delete env.XDG_CONFIG_HOME;
  return execFileSync(process.execPath, [path.join(ROOT, 'src/cli/kanban.ts'), ...args], { env, encoding: 'utf8', cwd: home, stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Make a throwaway git project with a remote and NO kanban/Claude files in it. */
function plainProject(name: string, remote: string) {
  const dir = path.join(tmpDir('kanban-anyproj-'), name + '-checkout');
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: dir });
  fs.mkdirSync(path.join(dir, 'src'));
  return dir;
}

/** Spawn exactly the hook handler that install wrote into settings.json (command + args), like Claude Code would. */
async function runInstalledHook(home: string, event: string, payload: Record<string, unknown>, env: Record<string, string> = {}) {
  const s = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
  const h = s.hooks[event].flatMap((g: any) => g.hooks).find((x: any) => (x.args ?? []).some((a: string) => a.endsWith('src/hooks/hook.ts')));
  assert.ok(h, `our ${event} hook is installed`);
  assert.ok(path.isAbsolute(h.command) && path.isAbsolute(h.args[0]), 'absolute paths to this repo');
  const proc = spawn(h.command, h.args, { cwd: String(payload.cwd ?? home), env: { ...cleanEnv(), HOME: home, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  track(proc);
  let out = '', err = '';
  proc.stdout.on('data', (d) => (out += d));
  proc.stderr.on('data', (d) => (err += d));
  const t0 = Date.now();
  proc.stdin.end(JSON.stringify({ hook_event_name: event, ...payload }));
  const code = await new Promise<number>((r) => proc.on('exit', (c) => r(c ?? -1)));
  return { code, out, err, ms: Date.now() - t0, json: out.trim() ? JSON.parse(out) : null };
}

async function installedMcp(home: string, env: Record<string, string>) {
  const cj = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
  const e = cj.mcpServers.kanban;
  const transport = new StdioClientTransport({ command: e.command, args: e.args, env: { ...cleanEnv(), HOME: home, ...e.env, ...env }, stderr: 'pipe' });
  const client = new Client({ name: 'kanban-global-test', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

test('global install merges into an existing home, is idempotent, and uninstall restores every file byte-for-byte', () => {
  const { home, before, snap } = fakeHome();
  const out1 = cli(home, ['install', '--global', '--mcp-via', 'file', '--url', 'http://127.0.0.1:4999']);
  assert.match(out1, /Installed Personal AI Kanban for every Claude Code project/);
  const s = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
  assert.deepEqual(s.enabledPlugins, { 'slack@claude-plugins-official': true });
  assert.equal(s.theme, 'dark');
  for (const ev of ['Stop', 'SessionEnd']) {
    assert.deepEqual(s.hooks[ev][0], { hooks: [CONTROL_HOOK] }, `existing ${ev} hook (Control) kept first and untouched`);
    assert.equal(s.hooks[ev].length, 2);
  }
  assert.deepEqual(s.hooks.PreToolUse, [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/usr/local/bin/guard' }] }]);
  for (const ev of ['SessionStart', 'PostToolUse', 'Stop', 'SessionEnd']) {
    const ours = s.hooks[ev].at(-1).hooks[0];
    assert.ok(ours.args.includes('--scope') && ours.args.includes('global'), `${ev} tagged as global`);
  }
  const cj = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
  assert.equal(cj.numStartups, 7);
  assert.deepEqual(cj.mcpServers.other, { type: 'stdio', command: 'other-server' }, 'other user MCP server kept');
  assert.equal(cj.mcpServers.kanban.args[0], path.join(ROOT, 'src/mcp/server.ts'));
  assert.equal(cj.mcpServers.kanban.env.KANBAN_URL, 'http://127.0.0.1:4999');
  const md = fs.readFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'utf8');
  assert.ok(md.startsWith('# My global rules\n\nAlways run the tests.\n'));
  assert.equal(md.split(GLOBAL_START).length, 2);
  // backups written before modifying
  const bdirs = fs.readdirSync(path.join(home, '.local/share/personal-ai-kanban/backups'));
  assert.equal(bdirs.length, 1);
  assert.equal(fs.readFileSync(path.join(home, '.local/share/personal-ai-kanban/backups', bdirs[0], 'settings.json'), 'utf8'), before['.claude/settings.json']);

  // Idempotent: a second install changes nothing and adds no duplicates
  const afterFirst = snap();
  const out2 = cli(home, ['install', '--global', '--mcp-via', 'file', '--url', 'http://127.0.0.1:4999']);
  assert.match(out2, /already installed; nothing changed/);
  assert.deepEqual(snap(), afterFirst);

  // Status reports it
  assert.match(cli(home, ['status']), /Global install: installed[\s\S]*SessionStart[\s\S]*"kanban".*yes[\s\S]*block.*yes/);

  const out3 = cli(home, ['uninstall', '--global', '--mcp-via', 'file']);
  assert.match(out3, /Removed \(global\): hooks, CLAUDE\.md block, mcpServers\.kanban/);
  assert.deepEqual(snap(), before, 'settings.json, CLAUDE.md and .claude.json byte-identical to before install');
  assert.ok(!fs.existsSync(path.join(home, '.local/share/personal-ai-kanban/global-install.json')), 'manifest removed');
});

test('uninstall keeps changes made after install and removes only our entries; a fresh home is left with no files', () => {
  const { home } = fakeHome();
  cli(home, ['install', '--global', '--mcp-via', 'file']);
  // the user (or Claude Code) edits things after install
  const sf = path.join(home, '.claude', 'settings.json');
  const s = JSON.parse(fs.readFileSync(sf, 'utf8'));
  s.model = 'opus';
  s.hooks.Stop.push({ hooks: [{ type: 'command', command: '/usr/local/bin/later-hook' }] });
  fs.writeFileSync(sf, JSON.stringify(s));
  fs.appendFileSync(path.join(home, '.claude', 'CLAUDE.md'), '\n## Added later\nKeep me.\n');
  const cjf = path.join(home, '.claude.json');
  const cj = JSON.parse(fs.readFileSync(cjf, 'utf8'));
  cj.numStartups = 8;
  fs.writeFileSync(cjf, JSON.stringify(cj, null, 2));
  cli(home, ['uninstall', '--global', '--mcp-via', 'file']);
  const s2 = JSON.parse(fs.readFileSync(sf, 'utf8'));
  assert.equal(s2.model, 'opus');
  assert.deepEqual(s2.hooks.Stop, [{ hooks: [CONTROL_HOOK] }, { hooks: [{ type: 'command', command: '/usr/local/bin/later-hook' }] }]);
  assert.deepEqual(s2.hooks.SessionEnd, [{ hooks: [CONTROL_HOOK] }]);
  assert.equal(s2.hooks.SessionStart, undefined);
  assert.equal(s2.hooks.PostToolUse, undefined);
  const md = fs.readFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'utf8');
  assert.ok(!md.includes('personal-ai-kanban') && md.includes('Always run the tests.') && md.includes('Keep me.'));
  const cj2 = JSON.parse(fs.readFileSync(cjf, 'utf8'));
  assert.equal(cj2.numStartups, 8);
  assert.deepEqual(Object.keys(cj2.mcpServers), ['other']);

  // Empty home: install creates files; uninstall deletes the ones it created
  const empty = tmpDir('kanban-home-empty-');
  fs.writeFileSync(path.join(empty, '.claude.json'), '{\n  "numStartups": 1\n}');
  cli(empty, ['install', '--global', '--mcp-via', 'file']);
  assert.ok(fs.existsSync(path.join(empty, '.claude', 'settings.json')) && fs.existsSync(path.join(empty, '.claude', 'CLAUDE.md')));
  cli(empty, ['uninstall', '--global', '--mcp-via', 'file']);
  assert.ok(!fs.existsSync(path.join(empty, '.claude', 'settings.json')) && !fs.existsSync(path.join(empty, '.claude', 'CLAUDE.md')));
  assert.equal(fs.readFileSync(path.join(empty, '.claude.json'), 'utf8'), '{\n  "numStartups": 1\n}', 'no leftover empty mcpServers key');
});

test('refuses to replace a different user-scope "kanban" MCP server', () => {
  const { home, before, snap } = fakeHome({ claudeJson: '{"mcpServers":{"kanban":{"type":"http","url":"https://example.invalid/mcp"}}}' });
  assert.throws(() => cli(home, ['install', '--global', '--mcp-via', 'file']), (e: any) => /different user-scope MCP server named "kanban"/.test(String(e.stderr)));
  assert.equal(snap()['.claude.json'], before['.claude.json']);
});

const claudeBin = findClaude();
test('global install through the real `claude mcp add-json/remove --scope user` CLI (temp HOME)', { skip: !claudeBin && 'claude CLI not installed' }, () => {
  const { home } = fakeHome();
  // Let the CLI initialise its own bookkeeping keys in this fake ~/.claude.json first (a real one already has them).
  execFileSync(claudeBin!, ['mcp', 'list'], { env: { ...cleanEnv(), HOME: home }, cwd: home, encoding: 'utf8', timeout: 60000 });
  const before = fs.readFileSync(path.join(home, '.claude.json'), 'utf8');
  const out = cli(home, ['install', '--global', '--mcp-via', 'cli'], { CLAUDE_BIN: claudeBin! });
  assert.match(out, /via claude mcp add-json --scope user/);
  const got = execFileSync(claudeBin!, ['mcp', 'get', 'kanban'], { env: { ...cleanEnv(), HOME: home }, cwd: home, encoding: 'utf8', timeout: 60000 });
  assert.match(got, /Scope: User config \(available in all your projects\)/);
  cli(home, ['uninstall', '--global', '--mcp-via', 'cli'], { CLAUDE_BIN: claudeBin! });
  const after = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
  assert.equal(after.mcpServers?.kanban, undefined);
  assert.deepEqual(after.mcpServers.other, { type: 'stdio', command: 'other-server' });
  assert.deepEqual(after, JSON.parse(before), '.claude.json content back to the pre-install state');
});

test('hooks and MCP from the global install work in an arbitrary project with no kanban files; opt-outs and dedupe', async () => {
  const data = tmpDir('kanban-gdata-');
  const svc = await startSvc(data);
  const { home } = fakeHome();
  cli(home, ['install', '--global', '--mcp-via', 'file', '--url', svc.url, '--data-dir', data]);
  const proj = plainProject('acme-api', 'git@github.com:someone/acme-api.git');
  assert.deepEqual(fs.readdirSync(proj).sort(), ['.git', 'src'], 'no .mcp.json / .claude / CLAUDE.md in the project');
  const seeded = (await api(svc.url, 'POST', '/api/tasks', { opId: uuid(), title: 'Rate limiter', project: 'acme-api', status: 'ready' })).json.task;

  // SessionStart from a subdirectory: project label comes from the git remote, not the folder name ("acme-api-checkout")
  const sid = 'global-session-1';
  const start = await runInstalledHook(home, 'SessionStart', { session_id: sid, cwd: path.join(proj, 'src'), source: 'startup' }, { CLAUDE_PROJECT_DIR: proj });
  assert.equal(start.code, 0, start.err);
  const ctx = start.json.hookSpecificOutput.additionalContext as string;
  assert.match(ctx, /repo "acme-api"/);
  assert.match(ctx, new RegExp(`${seeded.id} "Rate limiter"`), 'board matched this repo\'s open tasks by label');

  // MCP server from the user-scope entry: create_task without a project gets the label automatically
  const mcp = await installedMcp(home, { CLAUDE_PROJECT_DIR: proj, KANBAN_SESSION_ID: sid });
  const r = await mcp.callTool({ name: 'create_task', arguments: { opId: uuid(), title: 'Add retry header', status: 'ready' } }) as any;
  assert.equal(JSON.parse(r.content[0].text).task.project, 'acme-api');
  await mcp.close();

  // Edits + Stop -> nudge (global hooks behave exactly like the project ones)
  await runInstalledHook(home, 'PostToolUse', { session_id: sid, cwd: proj, tool_name: 'Edit', tool_input: { file_path: path.join(proj, 'src/a.ts') } }, { CLAUDE_PROJECT_DIR: proj });
  const stop = await runInstalledHook(home, 'Stop', { session_id: sid, cwd: proj, stop_hook_active: false }, { CLAUDE_PROJECT_DIR: proj });
  assert.match(stop.json.hookSpecificOutput.additionalContext, /1 file edit\(s\)/);

  // Per-project opt-out with no file in the repo: hooks go silent and the MCP server offers no tools
  const ig = cli(home, ['ignore', proj, '--data-dir', data]);
  assert.match(ig, /Kanban is now off for/);
  assert.deepEqual(fs.readdirSync(proj).sort(), ['.git', 'src']);
  const quiet = await runInstalledHook(home, 'SessionStart', { session_id: 'global-session-2', cwd: path.join(proj, 'src'), source: 'startup' }, { CLAUDE_PROJECT_DIR: proj });
  assert.equal(quiet.code, 0);
  assert.equal(quiet.out, '', 'ignored project: no output');
  const off = await installedMcp(home, { CLAUDE_PROJECT_DIR: proj });
  assert.equal((await off.listTools().catch(() => ({ tools: [] }))).tools.length, 0, 'ignored project: no MCP tools');
  await off.close();
  cli(home, ['unignore', proj, '--data-dir', data]);

  // Env kill switch
  const disabled = await runInstalledHook(home, 'SessionStart', { session_id: 'global-session-3', cwd: proj, source: 'startup' }, { CLAUDE_PROJECT_DIR: proj, KANBAN_DISABLE: '1' });
  assert.equal(disabled.out, '');

  // A project that still has the old per-project install: the global hook steps aside (no double hooks)
  const legacy = plainProject('legacy-app', 'https://github.com/someone/legacy-app.git');
  cli(home, ['install', '--project', legacy, '--url', svc.url, '--data-dir', data]);
  const dup = await runInstalledHook(home, 'SessionStart', { session_id: 'global-session-4', cwd: legacy, source: 'startup' }, { CLAUDE_PROJECT_DIR: legacy });
  assert.equal(dup.out, '', 'global hook defers to the project install');
  const warn = cli(home, ['install', '--global', '--mcp-via', 'file', '--url', svc.url, '--data-dir', data], {});
  // the legacy project is not in the fake ~/.claude.json projects list, so it is only reported when Claude Code knows it
  assert.doesNotMatch(warn, /error/i);
  const cjf = path.join(home, '.claude.json');
  const cj = JSON.parse(fs.readFileSync(cjf, 'utf8')); cj.projects = { [legacy]: {} }; fs.writeFileSync(cjf, JSON.stringify(cj, null, 2));
  assert.match(cli(home, ['install', '--global', '--mcp-via', 'file', '--url', svc.url, '--data-dir', data]), /still have the per-project install[\s\S]*legacy-app-checkout/);
  assert.match(cli(home, ['status']), /older per-project install/);

  // Board offline: the global hook from an arbitrary project stays fast, exits 0, and queues
  await svc.stop();
  const offline = await runInstalledHook(home, 'SessionStart', { session_id: 'global-session-5', cwd: proj, source: 'startup' }, { CLAUDE_PROJECT_DIR: proj });
  assert.equal(offline.code, 0);
  assert.ok(offline.ms < 6000, `bounded (${offline.ms} ms)`);
  assert.match(offline.json.hookSpecificOutput.additionalContext, /unreachable/);
  const pending = fs.readdirSync(path.join(data, 'outbox', 'pending'));
  assert.ok(pending.length >= 1, 'session start queued for later delivery');
});
