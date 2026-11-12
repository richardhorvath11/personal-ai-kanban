#!/usr/bin/env node
// kanban CLI: migrate | export [file] | (later slices add: note, install, uninstall, outbox)
import fs from 'node:fs';
import { loadConfig } from '../core/config.ts';
import { openDb } from '../core/db.ts';
import { Board } from '../core/board.ts';
import { extraCommands } from './commands.ts';

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name: string) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };

async function main() {
  const config = () => loadConfig({ dataDir: flag('--data-dir'), mode: rest.includes('--demo') ? 'demo' : undefined });
  switch (cmd) {
    case 'migrate': {
      const c = config();
      const db = openDb(c.dataDir, c.mode); // openDb runs pending migrations
      const v = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number };
      console.log(`Database at ${c.dataDir}/kanban.db is at schema version ${v.v}`);
      db.close();
      return;
    }
    case 'export': {
      const c = config();
      const db = openDb(c.dataDir, c.mode);
      const data = JSON.stringify(new Board(db, c.settings.timezone).exportAll(), null, 2);
      db.close();
      const file = rest.find((a) => !a.startsWith('--') && a !== flag('--data-dir'));
      if (file) { fs.writeFileSync(file, data); console.log(`Exported to ${file}`); } else process.stdout.write(data + '\n');
      return;
    }
    default: {
      const handler = extraCommands[cmd ?? ''];
      if (handler) return handler(rest);
      console.log('Usage: kanban <migrate|export [file]|' + Object.keys(extraCommands).join('|') + '> [--data-dir DIR] [--demo]');
      process.exitCode = cmd ? 1 : 0;
    }
  }
}
await main();
