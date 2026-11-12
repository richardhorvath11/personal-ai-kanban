// Global (user-scope) Claude Code integration: one install that works in every project, with nothing
// written into any repository. Verified against Claude Code 2.1.310 docs (code.claude.com/docs/en/mcp,
// /hooks, /memory):
//   - MCP server  -> user scope in ~/.claude.json (via `claude mcp add-json --scope user`, or a direct merge)
//   - hooks       -> ~/.claude/settings.json (merged next to every existing hook)
//   - instructions-> a marked block in ~/.claude/CLAUDE.md
// CLAUDE_CONFIG_DIR is honoured the way Claude Code does (settings, CLAUDE.md and .claude.json move there).
// Every change is merged, tagged and reversible: install writes a timestamped backup of each file it modifies
// and a manifest in the kanban state dir; uninstall removes only our entries and, when nothing else changed,
// restores the original bytes exactly.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { hookEntries } from './hook-config.ts';
import { REPO_ROOT, isOurHook, stripBlock } from './install.ts';
import { kanbanHome } from '../core/project.ts';

export const GLOBAL_START = '<!-- personal-ai-kanban:global:start (managed by `kanban install --global`; remove with `kanban uninstall --global`) -->';
export const GLOBAL_END = '<!-- personal-ai-kanban:global:end -->';
export const SERVER_NAME = 'kanban';
const SERVER_PATH = path.join(REPO_ROOT, 'src', 'mcp', 'server.ts');

export const GLOBAL_CLAUDE_MD_BLOCK = `${GLOBAL_START}
## Personal AI Kanban (all projects)

The user keeps a personal kanban board that follows them across every repository. When the \`kanban\` MCP tools are available in this session, use them as below. If they are not available (the board is off for this project or not running), ignore this section and never claim the board was updated.

- **Start / resume / switch:** call \`get_session_context\` (the Claude session id appears in the SessionStart context). If the user's request matches a listed task, call \`link_session\` with it as \`currentTaskId\`. If several tasks plausibly match, ask the user once which one. Never pick a task only because its title or this repository looks similar. Re-read a task with \`get_task\` before editing it.
- **Capture:** explicit requests or commitments become tasks (\`create_task\`, status \`ready\`, with completion conditions). Tentative ideas ("I should look at…") go to \`inbox\`. The project label defaults to this repository. Turn relative deadlines into explicit dates with \`resolve_date\`; ask when the wording is ambiguous.
- **Checkpoint automatically:** after meaningful progress, a blocker, or a changed finding, call \`record_checkpoint\` with a concise summary, the next action and any new findings. Do not wait for the user to say "update the board". Skip trivial turns.
- **Status honesty:** finishing a response or ending a session is not completion. Move to \`review\` when an output is ready for inspection. Use \`done\` only when the task's completion conditions are met, passing \`completionEvidence\`, or when the user confirms. A blocker moves the task to \`waiting\` with a \`waitingReason\`.
- **User authority:** pins, deadlines and explicit ordering set by the user stay as they are unless the user changes them.
- **Hygiene:** never write credentials, secrets or raw transcripts into the board.
${GLOBAL_END}
`;

export interface GlobalPaths { home: string; configDir: string; settings: string; claudeMd: string; claudeJson: string; stateDir: string; manifest: string }

export function globalPaths(o: { home?: string; configDir?: string; stateDir?: string } = {}): GlobalPaths {
  const home = path.resolve(o.home ?? os.homedir());
  const envCfg = process.env.CLAUDE_CONFIG_DIR;
  const configDir = path.resolve(o.configDir ?? envCfg ?? path.join(home, '.claude'));
  // With CLAUDE_CONFIG_DIR, Claude Code keeps .claude.json inside that directory; otherwise it is ~/.claude.json.
  const claudeJson = o.configDir || envCfg ? path.join(configDir, '.claude.json') : path.join(home, '.claude.json');
  const stateDir = path.resolve(o.stateDir ?? kanbanHome());
  return { home, configDir, settings: path.join(configDir, 'settings.json'), claudeMd: path.join(configDir, 'CLAUDE.md'), claudeJson, stateDir, manifest: path.join(stateDir, 'global-install.json') };
}

interface FileRec { path: string; existed: boolean; backup: string | null; writtenSha: string }
interface GlobalManifest {
  version: 1; installedAt: string; repoRoot: string; url: string; dataDir: string; mcpVia: 'cli' | 'file';
  settings: FileRec | null; claudeMd: FileRec | null;
  claudeJson: { path: string; hadMcpServersKey: boolean; backup: string | null };
}

const sha = (s: string | null) => (s === null ? '' : crypto.createHash('sha256').update(s).digest('hex'));
const readRaw = (f: string): string | null => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const parse = (raw: string | null): any => (raw && raw.trim() ? JSON.parse(raw) : {});
const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const deepEqual = (a: unknown, b: unknown) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
function canon(v: any): any { return Array.isArray(v) ? v.map(canon) : isObj(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v; }

/** Write via temp file + rename, keeping the original file mode (~/.claude.json is 0600). */
function writeKeepMode(file: string, text: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let mode = 0o644;
  try { mode = fs.statSync(file).mode & 0o777; } catch { if (path.basename(file) === '.claude.json') mode = 0o600; }
  const tmp = `${file}.kanban-${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
}
/** Serialize like the file already was: 2-space JSON, trailing newline only if the original had one. */
const stringifyLike = (v: unknown, original: string | null, defaultNewline = true) =>
  JSON.stringify(v, null, 2) + ((original === null ? defaultNewline : original.endsWith('\n')) ? '\n' : '');

function backupFile(file: string, raw: string | null, dir: string): string | null {
  if (raw === null) return null;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const dest = path.join(dir, path.basename(file).replace(/^\./, 'dot.'));
  fs.writeFileSync(dest, raw, { mode: 0o600 });
  return dest;
}

export function findClaude(): string | null {
  if (process.env.CLAUDE_BIN) return fs.existsSync(process.env.CLAUDE_BIN) ? process.env.CLAUDE_BIN : null;
  for (const d of (process.env.PATH ?? '').split(path.delimiter)) {
    const f = path.join(d, 'claude');
    try { fs.accessSync(f, fs.constants.X_OK); return f; } catch { /* keep looking */ }
  }
  const local = path.join(os.homedir(), '.local', 'bin', 'claude');
  return fs.existsSync(local) ? local : null;
}

const isOurServer = (s: any) => isObj(s) && (s.args ?? []).some((a: unknown) => a === SERVER_PATH);
export const mcpEntry = (url: string, dataDir: string) => ({ type: 'stdio', command: process.execPath, args: [SERVER_PATH], env: { KANBAN_URL: url, KANBAN_DATA_DIR: dataDir } });

function claudeCli(bin: string, args: string[], cwd: string) {
  // `claude mcp` only edits local config; it never calls a model. Keep API keys out of its environment anyway.
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY; delete env.ANTHROPIC_AUTH_TOKEN;
  return execFileSync(bin, args, { cwd, env, encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Projects that still carry the older per-project install (they keep working; the global hooks step aside there). */
export function findProjectInstalls(claudeJsonObj: any, extraDirs: string[] = []): string[] {
  const dirs = new Set<string>([...Object.keys(isObj(claudeJsonObj?.projects) ? claudeJsonObj.projects : {}), ...extraDirs]);
  return [...dirs].filter((d) => fs.existsSync(path.join(d, '.claude', 'kanban-install.json'))).sort();
}

export interface GlobalInstallOptions { url?: string; dataDir?: string; home?: string; configDir?: string; stateDir?: string; mcpVia?: 'cli' | 'file' | 'auto'; withHooks?: boolean; withClaudeMd?: boolean; scanDirs?: string[] }

export function installGlobal(opts: GlobalInstallOptions = {}) {
  const p = globalPaths(opts);
  const url = opts.url ?? `http://127.0.0.1:${process.env.KANBAN_PORT || 4317}`;
  const dataDir = path.resolve(opts.dataDir ?? process.env.KANBAN_DATA_DIR ?? path.join(p.stateDir, 'real'));
  const prev: GlobalManifest | null = (() => { try { return JSON.parse(fs.readFileSync(p.manifest, 'utf8')); } catch { return null; } })();
  const bdir = path.join(p.stateDir, 'backups', `global-${new Date().toISOString().replace(/[:.]/g, '')}`);
  const changed: string[] = [];
  const warnings: string[] = [];

  /** Keep the pristine (pre-install) record when the file is still exactly what we last wrote. */
  const record = (file: string, before: string | null, after: string, prevRec: FileRec | null | undefined): FileRec => {
    if (prevRec && prevRec.path === file && sha(before) === prevRec.writtenSha) return { ...prevRec, writtenSha: sha(after) };
    return { path: file, existed: before !== null, backup: before === after ? null : backupFile(file, before, bdir), writtenSha: sha(after) };
  };

  // 1) hooks -> settings.json (merge; every other hook and setting is kept as is)
  let settingsRec: FileRec | null = prev?.settings ?? null;
  if (opts.withHooks !== false) {
    const before = readRaw(p.settings);
    const s = parse(before);
    if (!isObj(s)) throw new Error(`${p.settings} is not a JSON object; not touching it`);
    stripOurHooks(s); // drop a previous copy of ours (idempotent); every other group is kept untouched
    s.hooks = isObj(s.hooks) ? s.hooks : {};
    for (const [event, group] of Object.entries(hookEntries({ url, dataDir, scope: 'global' }))) {
      s.hooks[event] = [...(Array.isArray(s.hooks[event]) ? s.hooks[event] : []), group];
    }
    const after = stringifyLike(s, before);
    if (after !== before) { settingsRec = record(p.settings, before, after, prev?.settings); writeKeepMode(p.settings, after); changed.push(p.settings); }
    else settingsRec = record(p.settings, before, after, prev?.settings);
  }

  // 2) instructions -> marked block in CLAUDE.md
  let mdRec: FileRec | null = prev?.claudeMd ?? null;
  if (opts.withClaudeMd !== false) {
    const before = readRaw(p.claudeMd);
    const base = stripBlock(before ?? '', GLOBAL_START, GLOBAL_END);
    const after = (base.trimEnd() ? base.trimEnd() + '\n\n' : '') + GLOBAL_CLAUDE_MD_BLOCK;
    mdRec = record(p.claudeMd, before, after, prev?.claudeMd);
    if (after !== before) { writeKeepMode(p.claudeMd, after); changed.push(p.claudeMd); }
  }

  // 3) MCP server -> user scope
  const cjRaw = readRaw(p.claudeJson);
  const cj = parse(cjRaw);
  const existing = cj?.mcpServers?.[SERVER_NAME];
  if (existing && !isOurServer(existing)) throw new Error(`A different user-scope MCP server named "${SERVER_NAME}" already exists in ${p.claudeJson}; not replacing it.`);
  const hadMcpServersKey = prev?.claudeJson ? prev.claudeJson.hadMcpServersKey : Object.prototype.hasOwnProperty.call(cj, 'mcpServers');
  const cjBackup = prev?.claudeJson?.backup ?? null;
  const want = mcpEntry(url, dataDir);
  const claude = opts.mcpVia === 'file' ? null : findClaude();
  if (opts.mcpVia === 'cli' && !claude) throw new Error('claude CLI not found (set CLAUDE_BIN), or use --mcp-via file');
  const mcpVia: 'cli' | 'file' = claude ? 'cli' : 'file';
  let newCjBackup = cjBackup;
  if (!existing || !deepEqual(existing, want)) {
    if (!prev?.claudeJson) newCjBackup = backupFile(p.claudeJson, cjRaw, bdir);
    if (claude) {
      if (existing) claudeCli(claude, ['mcp', 'remove', '--scope', 'user', SERVER_NAME], p.home);
      claudeCli(claude, ['mcp', 'add-json', '--scope', 'user', SERVER_NAME, JSON.stringify(want)], p.home);
    } else {
      const fresh = readRaw(p.claudeJson); // re-read right before writing: Claude Code also writes this file
      const obj = parse(fresh);
      obj.mcpServers = isObj(obj.mcpServers) ? obj.mcpServers : {};
      obj.mcpServers[SERVER_NAME] = want;
      writeKeepMode(p.claudeJson, stringifyLike(obj, fresh, false));
    }
    changed.push(`${p.claudeJson} (mcpServers.${SERVER_NAME}, via ${mcpVia === 'cli' ? 'claude mcp add-json --scope user' : 'direct merge'})`);
  }

  const projects = findProjectInstalls(parse(readRaw(p.claudeJson)), opts.scanDirs);
  if (projects.length) warnings.push(`These projects still have the per-project install, which takes precedence there (the global hooks step aside, and Claude Code loads the project's "kanban" server instead of the user one): ${projects.join(', ')}. Remove it with: npm run kanban -- uninstall --project <dir>`);

  const manifest: GlobalManifest = {
    version: 1, installedAt: prev?.installedAt ?? new Date().toISOString(), repoRoot: REPO_ROOT, url, dataDir, mcpVia,
    settings: settingsRec, claudeMd: mdRec, claudeJson: { path: p.claudeJson, hadMcpServersKey, backup: newCjBackup },
  };
  fs.mkdirSync(p.stateDir, { recursive: true });
  fs.writeFileSync(p.manifest, JSON.stringify(manifest, null, 2) + '\n');
  return { paths: p, url, dataDir, mcpVia, changed, warnings, backupDir: fs.existsSync(bdir) ? bdir : null, manifest };
}

function stripOurHooks(s: any): boolean {
  let removed = false;
  if (!isObj(s?.hooks)) return false;
  for (const event of Object.keys(s.hooks)) {
    const groups = s.hooks[event];
    if (!Array.isArray(groups)) continue;
    const next: any[] = [];
    for (const g of groups) {
      const hooks = Array.isArray(g?.hooks) ? g.hooks : [];
      const kept = hooks.filter((h: any) => !isOurHook(h));
      if (kept.length !== hooks.length) removed = true;
      if (kept.length === hooks.length) next.push(g); else if (kept.length) next.push({ ...g, hooks: kept });
    }
    if (next.length) s.hooks[event] = next; else delete s.hooks[event];
  }
  if (!Object.keys(s.hooks).length) delete s.hooks;
  return removed;
}

export function uninstallGlobal(opts: { home?: string; configDir?: string; stateDir?: string; mcpVia?: 'cli' | 'file' | 'auto' } = {}) {
  const p = globalPaths(opts);
  const m: GlobalManifest | null = (() => { try { return JSON.parse(fs.readFileSync(p.manifest, 'utf8')); } catch { return null; } })();
  const removed: string[] = [];
  const restored: string[] = [];

  // settings.json
  const sRaw = readRaw(p.settings);
  if (sRaw !== null) {
    const rec = m?.settings && m.settings.path === p.settings ? m.settings : null;
    if (rec && sha(sRaw) === rec.writtenSha) {
      if (rec.existed && rec.backup) { writeKeepMode(p.settings, fs.readFileSync(rec.backup, 'utf8')); restored.push(p.settings); } else if (!rec.existed) { fs.rmSync(p.settings); removed.push(`${p.settings} (created by install)`); }
      removed.push('hooks');
    } else {
      const s = parse(sRaw);
      if (stripOurHooks(s)) {
        removed.push('hooks');
        const orig = rec?.backup ? readRaw(rec.backup) : null;
        if (orig !== null && deepEqual(s, parse(orig))) { writeKeepMode(p.settings, orig); restored.push(p.settings); }
        else if (rec && !rec.existed && !Object.keys(s).length) fs.rmSync(p.settings);
        else writeKeepMode(p.settings, stringifyLike(s, sRaw));
      }
    }
  }

  // CLAUDE.md
  const mdRaw = readRaw(p.claudeMd);
  if (mdRaw !== null && mdRaw.includes(GLOBAL_START)) {
    const rec = m?.claudeMd && m.claudeMd.path === p.claudeMd ? m.claudeMd : null;
    const orig = rec?.backup ? readRaw(rec.backup) : null;
    const stripped = stripBlock(mdRaw, GLOBAL_START, GLOBAL_END);
    if ((rec && sha(mdRaw) === rec.writtenSha) || (orig !== null && stripped.trimEnd() === orig.trimEnd())) {
      if (orig !== null) { writeKeepMode(p.claudeMd, orig); restored.push(p.claudeMd); } else fs.rmSync(p.claudeMd);
    } else if (!stripped.trim() && rec && !rec.existed) fs.rmSync(p.claudeMd);
    else writeKeepMode(p.claudeMd, stripped);
    removed.push('CLAUDE.md block');
  }

  // MCP user-scope server
  const cj = parse(readRaw(p.claudeJson));
  if (isOurServer(cj?.mcpServers?.[SERVER_NAME])) {
    const claude = opts.mcpVia === 'file' ? null : findClaude();
    if (claude) claudeCli(claude, ['mcp', 'remove', '--scope', 'user', SERVER_NAME], p.home);
    const fresh = readRaw(p.claudeJson);
    const obj = parse(fresh);
    let dirty = false;
    if (isObj(obj.mcpServers) && isOurServer(obj.mcpServers[SERVER_NAME])) { delete obj.mcpServers[SERVER_NAME]; dirty = true; }
    const hadKey = m?.claudeJson ? m.claudeJson.hadMcpServersKey : true;
    if (!hadKey && isObj(obj.mcpServers) && !Object.keys(obj.mcpServers).length) { delete obj.mcpServers; dirty = true; } // `claude mcp remove` leaves {}
    const orig = m?.claudeJson?.backup ? readRaw(m.claudeJson.backup) : null;
    if (orig !== null && deepEqual(obj, parse(orig))) { if (orig !== fresh) writeKeepMode(p.claudeJson, orig); restored.push(p.claudeJson); }
    else if (dirty) writeKeepMode(p.claudeJson, stringifyLike(obj, fresh, false));
    removed.push(`mcpServers.${SERVER_NAME} (user scope)`);
  }

  if (fs.existsSync(p.manifest)) fs.rmSync(p.manifest);
  return { paths: p, removed, restored };
}

export function globalStatus(opts: { home?: string; configDir?: string; stateDir?: string } = {}) {
  const p = globalPaths(opts);
  const s = parse(readRaw(p.settings));
  const hooks = Object.entries(isObj(s.hooks) ? s.hooks : {}).filter(([, gs]) => Array.isArray(gs) && gs.some((g: any) => (g.hooks ?? []).some(isOurHook))).map(([e]) => e);
  const cj = parse(readRaw(p.claudeJson));
  return {
    paths: p, installed: fs.existsSync(p.manifest), hooks, mcp: isOurServer(cj?.mcpServers?.[SERVER_NAME]),
    claudeMd: (readRaw(p.claudeMd) ?? '').includes(GLOBAL_START), projectInstalls: findProjectInstalls(cj),
  };
}
