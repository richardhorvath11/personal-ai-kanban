// Project identity and per-project opt-out, resolved at runtime from the Claude session's directory.
// Used by the hooks and the MCP adapter, so a single global (user-scope) install labels every project
// automatically and needs no file inside any repository.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export interface ProjectInfo { repo: string; worktree: string; root: string }

const git = (cwd: string, args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 800, stdio: ['ignore', 'pipe', 'ignore'] }).trim();

/** Name a repository from its remote URL: git@host:owner/name.git, https://host/owner/name(.git) -> name. */
export function nameFromRemote(url: string): string {
  const m = /([^/:]+?)(?:\.git)?\/*$/.exec(url.trim());
  return m ? m[1] : '';
}

/**
 * Project label for a directory. Inside git: the origin remote's repository name, else the main checkout's
 * folder name (so every worktree of one repo gets the same label). Outside git: the folder name.
 */
export function resolveProject(cwd: string): ProjectInfo {
  const dir = cwd || process.cwd();
  try {
    const [top, common] = git(dir, ['rev-parse', '--show-toplevel', '--git-common-dir']).split('\n');
    let repo = '';
    try { repo = nameFromRemote(git(dir, ['config', '--get', 'remote.origin.url'])); } catch { /* no remote */ }
    if (!repo && common) {
      const abs = path.resolve(dir, common);
      repo = path.basename(abs) === '.git' ? path.basename(path.dirname(abs)) : path.basename(top);
    }
    return { repo: repo || path.basename(top), worktree: top, root: top };
  } catch {
    return { repo: path.basename(dir), worktree: '', root: dir };
  }
}

/** Directory holding install state shared by every mode (manifest, backups). Not inside any repo or ~/.claude. */
export function kanbanHome(): string {
  if (process.env.KANBAN_HOME) return path.resolve(process.env.KANBAN_HOME);
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'personal-ai-kanban');
}

/** Per-project opt-out list. Lives in the board's data dir, never in the repository. */
export const ignoreFile = (dataDir: string) => path.join(dataDir, 'ignored-projects.json');

const real = (p: string) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

export function readIgnored(dataDir: string): string[] {
  try {
    const v = JSON.parse(fs.readFileSync(ignoreFile(dataDir), 'utf8'));
    return Array.isArray(v?.paths) ? v.paths.filter((p: unknown) => typeof p === 'string') : [];
  } catch { return []; }
}

function writeIgnored(dataDir: string, paths: string[]) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(ignoreFile(dataDir), JSON.stringify({ paths }, null, 2) + '\n');
}

export function addIgnored(dataDir: string, p: string): { path: string; added: boolean } {
  const target = real(p);
  const cur = readIgnored(dataDir);
  if (cur.includes(target)) return { path: target, added: false };
  writeIgnored(dataDir, [...cur, target].sort());
  return { path: target, added: true };
}

export function removeIgnored(dataDir: string, p: string): { path: string; removed: boolean } {
  const target = real(p);
  const cur = readIgnored(dataDir);
  if (!cur.includes(target)) return { path: target, removed: false };
  writeIgnored(dataDir, cur.filter((x) => x !== target));
  return { path: target, removed: true };
}

/** True when any of the given directories is an ignored path or inside one. Pure path check (no git), so it is cheap. */
export function isIgnored(dataDir: string, dirs: (string | undefined)[]): string | null {
  const list = readIgnored(dataDir);
  if (!list.length) return null;
  for (const d of dirs) {
    if (!d) continue;
    const r = real(d);
    for (const ig of list) if (r === ig || r.startsWith(ig.endsWith(path.sep) ? ig : ig + path.sep)) return ig;
  }
  return null;
}

/** Global kill switch for hooks and MCP tools: KANBAN_DISABLE=1 (KANBAN_HOOK_DISABLE=1 still disables hooks only). */
export const kanbanDisabled = () => process.env.KANBAN_DISABLE === '1';

/** True when this directory's project-scoped settings already run our hook (the older per-project install). */
export function hasProjectInstall(projectDir: string, hookPath: string): boolean {
  if (fs.existsSync(path.join(projectDir, '.claude', 'kanban-install.json'))) return true; // manifest the project installer writes
  for (const f of ['settings.json', 'settings.local.json']) {
    try { if (fs.readFileSync(path.join(projectDir, '.claude', f), 'utf8').includes(hookPath)) return true; } catch { /* absent */ }
  }
  return false;
}
