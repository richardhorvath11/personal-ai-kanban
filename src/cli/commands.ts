import { install, uninstall } from './install.ts';
import crypto from 'node:crypto';
import { KanbanClient } from '../core/client.ts';
import { Outbox } from '../core/outbox.ts';
import { sendOrQueue } from '../core/deliver.ts';
import { dataDirFromEnv } from '../core/runtime.ts';
import { serviceUrl } from '../core/config.ts';
import { installGlobal, uninstallGlobal, globalStatus } from './install-global.ts';
import { addIgnored, readIgnored, removeIgnored } from '../core/project.ts';

const flag = (args: string[], name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

export const extraCommands: Record<string, (args: string[]) => Promise<void> | void> = {
  install: (args) => {
    if (!args.includes('--project')) {
      // Default: global (user-scope) install that works in every project and writes nothing into any repo.
      const via = flag(args, '--mcp-via') as 'cli' | 'file' | 'auto' | undefined;
      const r = installGlobal({ url: flag(args, '--url'), dataDir: flag(args, '--data-dir'), mcpVia: via, withHooks: !args.includes('--no-hooks'), withClaudeMd: !args.includes('--no-claude-md') });
      console.log('Installed Personal AI Kanban for every Claude Code project (user scope).');
      for (const c of r.changed) console.log(`  updated ${c}`);
      if (!r.changed.length) console.log('  already installed; nothing changed');
      if (r.backupDir) console.log(`  backups of the previous files: ${r.backupDir}`);
      console.log(`  board URL ${r.url}; data dir ${r.dataDir}`);
      for (const w of r.warnings) console.log(`  warning: ${w}`);
      console.log('Opt a project out with: npm run kanban -- ignore <dir>   Remove everything with: npm run kanban -- uninstall --global');
      return;
    }
    const project = flag(args, '--project') ?? process.cwd();
    if (globalStatus().installed) console.log('Note: the global install is also active. In this project the per-project install takes precedence (the global hooks step aside).');
    const m = install(project, { url: flag(args, '--url'), dataDir: flag(args, '--data-dir'), withHooks: !args.includes('--no-hooks'), withClaudeMd: !args.includes('--no-claude-md') });
    console.log(`Installed Personal AI Kanban integration into ${project}`);
    for (const f of m.files) console.log(`  updated ${f} (previous version saved in .claude/kanban-backups/)`);
    console.log(`  board URL ${m.url}; data dir ${m.dataDir}`);
    console.log('Open `claude` in that project and approve the "kanban" MCP server when prompted. Remove with: npm run kanban -- uninstall --project ' + project);
  },
  // Manual note for work done outside an instrumented Claude session. Queues durably if the board is down.
  note: async (args) => {
    const [taskId, ...words] = args.filter((a, i) => !a.startsWith('--') && !(args[i - 1] ?? '').startsWith('--'));
    const text = words.join(' ').trim();
    if (!taskId || !text) { console.error('Usage: kanban note T-12 "what happened" [--next "next action"]'); process.exitCode = 1; return; }
    if (flag(args, '--data-dir')) process.env.KANBAN_DATA_DIR = flag(args, '--data-dir');
    const client = new KanbanClient({ baseUrl: flag(args, '--url') ?? serviceUrl(), client: 'cli' });
    const next = flag(args, '--next');
    const r = await sendOrQueue(client, new Outbox(dataDirFromEnv()), 'PATCH', `/api/tasks/${encodeURIComponent(taskId.toUpperCase())}`, {
      opId: `note-${crypto.randomUUID()}`, addFindings: [text], patch: next ? { nextAction: next } : {}, sourceNote: 'manual note (CLI)',
    });
    console.log(r.acknowledged ? `Recorded on ${taskId.toUpperCase()} (revision ${(r.result as any).task.revision}).` : r.message);
  },
  uninstall: (args) => {
    if (!args.includes('--project')) {
      const r = uninstallGlobal({ mcpVia: flag(args, '--mcp-via') as 'cli' | 'file' | 'auto' | undefined });
      console.log(r.removed.length ? `Removed (global): ${r.removed.join(', ')}` : 'Global install: nothing to remove.');
      if (r.restored.length) console.log(`  restored original bytes of: ${r.restored.join(', ')}`);
      return;
    }
    const project = flag(args, '--project') ?? process.cwd();
    const r = uninstall(project);
    console.log(r.removed.length ? `Removed: ${r.removed.join(', ')}` : 'Nothing to remove.');
  },
  status: () => {
    const s = globalStatus();
    console.log(`Global install: ${s.installed ? 'installed' : 'not installed'}`);
    console.log(`  hooks in ${s.paths.settings}: ${s.hooks.join(', ') || 'none'}`);
    console.log(`  user-scope MCP server "kanban" in ${s.paths.claudeJson}: ${s.mcp ? 'yes' : 'no'}`);
    console.log(`  instructions block in ${s.paths.claudeMd}: ${s.claudeMd ? 'yes' : 'no'}`);
    if (s.projectInstalls.length) console.log(`  projects with the older per-project install (it wins there): ${s.projectInstalls.join(', ')}`);
    const ig = readIgnored(dataDirFromEnv());
    console.log(`Ignored projects: ${ig.length ? ig.join(', ') : 'none'}`);
    if (process.env.KANBAN_DISABLE === '1') console.log('KANBAN_DISABLE=1 is set: hooks and MCP tools are off in this environment.');
  },
  // Per-project opt-out kept in the board's data dir, so no file is needed in the repository.
  ignore: (args) => {
    if (flag(args, '--data-dir')) process.env.KANBAN_DATA_DIR = flag(args, '--data-dir');
    const dir = args.find((a, i) => !a.startsWith('--') && !(args[i - 1] ?? '').startsWith('--')) ?? process.cwd();
    const r = addIgnored(dataDirFromEnv(), dir);
    console.log(r.added ? `Kanban is now off for ${r.path} (and everything under it).` : `${r.path} was already ignored.`);
  },
  unignore: (args) => {
    if (flag(args, '--data-dir')) process.env.KANBAN_DATA_DIR = flag(args, '--data-dir');
    const dir = args.find((a, i) => !a.startsWith('--') && !(args[i - 1] ?? '').startsWith('--')) ?? process.cwd();
    const r = removeIgnored(dataDirFromEnv(), dir);
    console.log(r.removed ? `Kanban is on again for ${r.path}.` : `${r.path} was not on the ignore list.`);
  },
};
