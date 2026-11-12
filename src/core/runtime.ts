// Runtime files shared by hooks and the MCP adapter (no network needed).
// SessionStart writes <runtime>/claude-pid/<claudePid>.json so the MCP adapter (a child of the same
// Claude process) can discover its session id without Claude having to pass it on every call.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { defaultDataDir } from './config.ts';

export function dataDirFromEnv(): string {
  return path.resolve(process.env.KANBAN_DATA_DIR || defaultDataDir(process.env.KANBAN_MODE === 'demo' ? 'demo' : 'real'));
}
export function runtimeDir(dataDir = dataDirFromEnv()): string {
  const d = process.env.KANBAN_RUNTIME_DIR || path.join(dataDir, 'runtime');
  fs.mkdirSync(path.join(d, 'claude-pid'), { recursive: true });
  return d;
}

export function writeAtomic(file: string, data: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  fs.writeSync(fd, data);
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  fs.renameSync(tmp, file);
}

export function parentPid(pid: number): number | null {
  try {
    if (process.platform === 'linux') {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      return Number(after[1]) || null;
    }
    const out = execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8', timeout: 500 }).trim();
    return Number(out) || null;
  } catch { return null; }
}

export function ancestors(start = process.ppid, depth = 4): number[] {
  const out: number[] = [];
  let p: number | null = start;
  while (p && p > 1 && out.length < depth) { out.push(p); p = parentPid(p); }
  return out;
}

export function recordSessionPid(sessionId: string, cwd: string, dir = runtimeDir()) {
  const pid = process.ppid; // the Claude Code process that spawned this hook
  writeAtomic(path.join(dir, 'claude-pid', `${pid}.json`), JSON.stringify({ sessionId, cwd, pid, at: new Date().toISOString() }));
}

export function findSessionForProcess(dir = runtimeDir()): string | null {
  for (const p of ancestors()) {
    const f = path.join(dir, 'claude-pid', `${p}.json`);
    if (fs.existsSync(f)) {
      try { return JSON.parse(fs.readFileSync(f, 'utf8')).sessionId ?? null; } catch { /* ignore */ }
    }
  }
  return null;
}
