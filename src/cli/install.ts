// Project-scoped Claude Code integration installer. Merges into the target project's
// .mcp.json, .claude/settings.json and CLAUDE.md, preserving everything already there.
// Never touches ~/.claude/settings.json. `uninstall` removes exactly what `install` added.
import fs from 'node:fs';
import path from 'node:path';
import { hookEntries } from './hook-config.ts';

export const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
export const MARK_START = '<!-- personal-ai-kanban:start (managed by `kanban install`; remove with `kanban uninstall`) -->';
export const MARK_END = '<!-- personal-ai-kanban:end -->';
const SERVER_NAME = 'kanban';

export const CLAUDE_MD_BLOCK = `${MARK_START}
## Personal AI Kanban

This project is connected to the user's personal kanban board through the \`kanban\` MCP server. The board is durable shared context across sessions and repositories.

- **Start / resume / switch:** call \`get_session_context\` (the Claude session id appears in the SessionStart context). If the user's request matches a listed task, call \`link_session\` with it as \`currentTaskId\`. If several tasks plausibly match, ask the user once which one. Never pick a task only because its title or this repository looks similar. Re-read a task with \`get_task\` before editing it.
- **Capture:** explicit requests or commitments become tasks (\`create_task\`, status \`ready\`, with completion conditions). Tentative ideas ("I should look at…") go to \`inbox\`. Turn relative deadlines into explicit dates with \`resolve_date\`; ask when the wording is ambiguous. Model separate actionable pieces as tasks with \`dependsOn\`; small steps are checklist items.
- **Checkpoint automatically:** after meaningful progress, a blocker, or a changed finding, call \`record_checkpoint\` with a concise summary, the next action and any new findings. Do not wait for the user to say "update the board". Skip trivial turns.
- **Status honesty:** finishing a response or ending a session is not completion. Move to \`review\` when an output is ready for inspection. Use \`done\` only when the task's completion conditions are met, passing \`completionEvidence\`, or when the user confirms. A blocker moves the task to \`waiting\` with a \`waitingReason\`.
- **User authority:** pins, deadlines and explicit ordering set by the user stay as they are unless the user changes them.
- **Hygiene:** never write credentials, secrets or raw transcripts into the board.
${MARK_END}
`;

interface Manifest { installedAt: string; repoRoot: string; url: string; dataDir: string; files: string[]; hookCommands: string[] }

const readJson = (f: string): any => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8') || '{}') : {});
const writeJson = (f: string, v: unknown) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\n'); };
let backupDir = '';
const backup = (f: string) => {
  if (!fs.existsSync(f) || !backupDir) return;
  fs.mkdirSync(backupDir, { recursive: true });
  fs.copyFileSync(f, path.join(backupDir, `${path.basename(f)}.${new Date().toISOString().replace(/[:.]/g, '')}`));
};

export function isOurHook(h: any): boolean {
  const s = [h?.command, ...(h?.args ?? [])].join(' ');
  return s.includes(path.join(REPO_ROOT, 'src', 'hooks', 'hook.ts'));
}

export function install(project: string, opts: { url?: string; dataDir?: string; withHooks?: boolean; withClaudeMd?: boolean } = {}) {
  const dir = path.resolve(project);
  if (!fs.existsSync(dir)) throw new Error(`Project directory ${dir} does not exist`);
  const home = process.env.HOME ? path.resolve(process.env.HOME) : '';
  if (dir === home) throw new Error('Refusing to install into your home directory (that would affect global Claude config). Pick a project directory.');
  const url = opts.url ?? `http://127.0.0.1:${process.env.KANBAN_PORT || 4317}`;
  const dataDir = path.resolve(opts.dataDir ?? process.env.KANBAN_DATA_DIR ?? path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'personal-ai-kanban', 'real'));
  const touched: string[] = [];
  backupDir = path.join(dir, '.claude', 'kanban-backups');

  // 1) .mcp.json (project scope)
  const mcpFile = path.join(dir, '.mcp.json');
  const mcp = readJson(mcpFile);
  backup(mcpFile);
  mcp.mcpServers = mcp.mcpServers ?? {};
  mcp.mcpServers[SERVER_NAME] = {
    type: 'stdio', command: process.execPath, args: [path.join(REPO_ROOT, 'src', 'mcp', 'server.ts')],
    env: { KANBAN_URL: url, KANBAN_DATA_DIR: dataDir },
  };
  writeJson(mcpFile, mcp);
  touched.push(mcpFile);

  // 2) .claude/settings.json hooks (merged; existing hooks preserved)
  const hookCommands: string[] = [];
  if (opts.withHooks !== false) {
    const sFile = path.join(dir, '.claude', 'settings.json');
    const settings = readJson(sFile);
    backup(sFile);
    settings.hooks = settings.hooks ?? {};
    for (const [event, group] of Object.entries(hookEntries({ url, dataDir }))) {
      const groups: any[] = (settings.hooks[event] = settings.hooks[event] ?? []);
      // drop any previous copy of our hook, keep everyone else's
      for (const g of groups) g.hooks = (g.hooks ?? []).filter((h: any) => !isOurHook(h));
      settings.hooks[event] = groups.filter((g) => g.hooks.length);
      settings.hooks[event].push(group);
      hookCommands.push(`${event}:${group.hooks[0].args?.[1]}`);
    }
    writeJson(sFile, settings);
    touched.push(sFile);
  }

  // 3) CLAUDE.md session instructions (marked block)
  if (opts.withClaudeMd !== false) {
    const md = path.join(dir, 'CLAUDE.md');
    let text = fs.existsSync(md) ? fs.readFileSync(md, 'utf8') : '';
    backup(md);
    text = stripBlock(text);
    text = (text.trimEnd() ? text.trimEnd() + '\n\n' : '') + CLAUDE_MD_BLOCK;
    fs.writeFileSync(md, text);
    touched.push(md);
  }

  const manifest: Manifest = { installedAt: new Date().toISOString(), repoRoot: REPO_ROOT, url, dataDir, files: touched, hookCommands };
  writeJson(path.join(dir, '.claude', 'kanban-install.json'), manifest);
  return manifest;
}

export function stripBlock(text: string): string {
  const a = text.indexOf(MARK_START);
  const b = text.indexOf(MARK_END);
  if (a < 0 || b < 0) return text;
  return (text.slice(0, a).trimEnd() + '\n' + text.slice(b + MARK_END.length).replace(/^\n+/, '')).replace(/^\n+$/, '');
}

export function uninstall(project: string) {
  const dir = path.resolve(project);
  const removed: string[] = [];
  const mcpFile = path.join(dir, '.mcp.json');
  if (fs.existsSync(mcpFile)) {
    const mcp = readJson(mcpFile);
    if (mcp.mcpServers?.[SERVER_NAME]) {
      delete mcp.mcpServers[SERVER_NAME];
      if (!Object.keys(mcp.mcpServers).length && Object.keys(mcp).length === 1) fs.rmSync(mcpFile); else writeJson(mcpFile, mcp);
      removed.push('.mcp.json: kanban server');
    }
  }
  const sFile = path.join(dir, '.claude', 'settings.json');
  if (fs.existsSync(sFile)) {
    const settings = readJson(sFile);
    for (const event of Object.keys(settings.hooks ?? {})) {
      const groups: any[] = settings.hooks[event];
      for (const g of groups) { const n = (g.hooks ?? []).length; g.hooks = (g.hooks ?? []).filter((h: any) => !isOurHook(h)); if (g.hooks.length !== n) removed.push(`hook ${event}`); }
      settings.hooks[event] = groups.filter((g) => g.hooks.length);
      if (!settings.hooks[event].length) delete settings.hooks[event];
    }
    if (settings.hooks && !Object.keys(settings.hooks).length) delete settings.hooks;
    if (!Object.keys(settings).length) fs.rmSync(sFile); else writeJson(sFile, settings);
  }
  const md = path.join(dir, 'CLAUDE.md');
  if (fs.existsSync(md)) {
    const text = fs.readFileSync(md, 'utf8');
    const stripped = stripBlock(text);
    if (stripped !== text) { if (stripped.trim()) fs.writeFileSync(md, stripped); else fs.rmSync(md); removed.push('CLAUDE.md block'); }
  }
  const manifest = path.join(dir, '.claude', 'kanban-install.json');
  if (fs.existsSync(manifest)) fs.rmSync(manifest);
  return { removed };
}
