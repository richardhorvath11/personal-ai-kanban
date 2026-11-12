// Test harness: real service processes on temp SQLite data dirs, real MCP stdio transport, real browser.
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { after } from 'node:test';
import http from 'node:http';

// Every child we start is tracked and stopped by exact PID when the test file finishes (pass or fail).
const live = new Set<ChildProcess>();
export function track(p: ChildProcess) { live.add(p); p.once('exit', () => live.delete(p)); return p; }
const clients = new Set<{ close: () => Promise<void> }>();
after(async () => {
  for (const c of clients) await c.close().catch(() => {});
  for (const p of live) { try { process.kill(p.pid!, 'SIGKILL'); } catch { /* already gone */ } }
});

/** Raw request with an arbitrary Host header (fetch cannot override Host). */
export function rawRequest(url: string, p: string, headers: Record<string, string>, method = 'GET'): Promise<number> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const r = http.request({ host: u.hostname, port: u.port, path: p, method, headers }, (res) => { res.resume(); resolve(res.statusCode!); });
    r.on('error', reject);
    r.end();
  });
}

export const ROOT = path.resolve(import.meta.dirname, '..');

export function tmpDir(prefix = 'kanban-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export interface SvcProc { proc: ChildProcess; url: string; port: number; pid: number; stop: () => Promise<void>; log: () => string }

/** Start the real service as a child process. Pass port 0 for an ephemeral port. */
export async function startSvc(dataDir: string, opts: { port?: number; env?: Record<string, string>; args?: string[] } = {}): Promise<SvcProc> {
  const proc = spawn(process.execPath, [path.join(ROOT, 'src/server/main.ts'), '--port', String(opts.port ?? 0), '--data-dir', dataDir, ...(opts.args ?? [])], {
    env: { ...cleanEnv(), KANBAN_TZ: 'America/Chicago', ...opts.env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  track(proc);
  let out = '';
  proc.stdout!.on('data', (d) => (out += d));
  proc.stderr!.on('data', (d) => (out += d));
  const url = await new Promise<string>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`service did not start: ${out}`)), 15000);
    const check = () => { const m = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(out); if (m) { clearTimeout(t); resolve(m[1]); } };
    proc.stdout!.on('data', check);
    proc.on('exit', (c) => { clearTimeout(t); reject(new Error(`service exited ${c}: ${out}`)); });
  });
  const port = Number(new URL(url).port);
  return {
    proc, url, port, pid: proc.pid!, log: () => out,
    stop: () => new Promise<void>((resolve) => {
      if (proc.exitCode !== null) return resolve();
      proc.once('exit', () => resolve());
      process.kill(proc.pid!, 'SIGTERM'); // exact PID only
    }),
  };
}

export function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('ANTHROPIC_') && !k.startsWith('KANBAN_')) env[k] = v;
  return env;
}

/** Connect a real MCP client over stdio to the adapter (node src/mcp/server.ts). */
export async function mcpClient(url: string, extraEnv: Record<string, string> = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath, args: [path.join(ROOT, 'src/mcp/server.ts')],
    env: { ...cleanEnv(), KANBAN_URL: url, ...extraEnv }, stderr: 'pipe',
  });
  const client = new Client({ name: 'kanban-test', version: '1.0.0' });
  await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args }) as { content: { text: string }[]; isError?: boolean };
    const parsed = JSON.parse(r.content[0].text);
    return { isError: !!r.isError, data: parsed };
  };
  const handle = { client, call, close: async () => { clients.delete(handle); await client.close(); } };
  clients.add(handle);
  return handle;
}

/** Browser-like request (sends Origin), as the UI does. */
export async function ui(url: string, method: string, p: string, body?: unknown) {
  const res = await fetch(url + p, { method, headers: { origin: url, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json() as any };
}

export async function api(url: string, method: string, p: string, body?: unknown, client = 'cli') {
  const res = await fetch(url + p, { method, headers: { 'x-kanban-client': client, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json() as any };
}

export const uuid = () => crypto.randomUUID();

export async function browser() {
  const { chromium } = await import('playwright-core');
  const exe = process.env.CHROME_PATH || ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => fs.existsSync(p));
  if (!exe) return null;
  return chromium.launch({ executablePath: exe, headless: true, args: ['--no-sandbox'] });
}

export function ensureUiBuilt() {
  if (!fs.existsSync(path.join(ROOT, 'dist/ui/index.html'))) throw new Error('UI not built: run npm run build:ui before tests');
}

export async function freePort(): Promise<number> {
  const net = await import('node:net');
  return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as any).port; s.close(() => resolve(p)); }); });
}

/** Run the real hook script as Claude Code would (JSON on stdin), returning parsed stdout. FIXTURE payloads — not a live Claude run. */
export async function runHook(event: string, payload: Record<string, unknown>, o: { url: string; dataDir: string; env?: Record<string, string> }) {
  const proc = spawn(process.execPath, [path.join(ROOT, 'src/hooks/hook.ts'), event, '--url', o.url, '--data-dir', o.dataDir], { env: { ...cleanEnv(), ...o.env }, stdio: ['pipe', 'pipe', 'pipe'] });
  track(proc);
  let out = '', err = '';
  proc.stdout.on('data', (d) => (out += d));
  proc.stderr.on('data', (d) => (err += d));
  proc.stdin.end(JSON.stringify({ hook_event_name: event, ...payload }));
  const started = Date.now();
  const code = await new Promise<number>((r) => proc.on('exit', (c) => r(c ?? -1)));
  return { code, out, err, json: out.trim() ? JSON.parse(out) : null, ms: Date.now() - started, pid: proc.pid };
}

export async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, ms = 10000, step = 150): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, step));
  }
}
