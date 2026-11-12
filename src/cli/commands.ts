import { install, uninstall } from './install.ts';

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
  uninstall: (args) => {
    const project = flag(args, '--project') ?? process.cwd();
    const r = uninstall(project);
    console.log(r.removed.length ? `Removed: ${r.removed.join(', ')}` : 'Nothing to remove.');
  },
};
