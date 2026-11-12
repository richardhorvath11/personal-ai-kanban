import { install, uninstall } from './install.ts';
import crypto from 'node:crypto';
import { KanbanClient } from '../core/client.ts';
import { Outbox } from '../core/outbox.ts';
import { sendOrQueue } from '../core/deliver.ts';
import { dataDirFromEnv } from '../core/runtime.ts';
import { serviceUrl } from '../core/config.ts';

const flag = (args: string[], name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

export const extraCommands: Record<string, (args: string[]) => Promise<void> | void> = {
  install: (args) => {
    const project = flag(args, '--project') ?? process.cwd();
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
    const project = flag(args, '--project') ?? process.cwd();
    const r = uninstall(project);
    console.log(r.removed.length ? `Removed: ${r.removed.join(', ')}` : 'Nothing to remove.');
  },
};
