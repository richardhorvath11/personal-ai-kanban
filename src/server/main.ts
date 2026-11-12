// Entry point: node src/server/main.ts [--port N] [--data-dir DIR] [--demo] [--seed-demo]
import { loadConfig } from '../core/config.ts';
import { startService } from './service.ts';
import { allPlugins } from './plugins.ts';

const args = process.argv.slice(2);
const opt = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const config = loadConfig({
  port: opt('--port') ? Number(opt('--port')) : undefined,
  dataDir: opt('--data-dir'),
  mode: args.includes('--demo') ? 'demo' : undefined,
});
const svc = await startService(config, allPlugins({ seedDemo: args.includes('--seed-demo') }));
console.log(`[kanban] ${config.mode} board listening on ${svc.url} (pid ${process.pid}, data ${config.dataDir})`);
const stop = async (sig: string) => { console.log(`[kanban] ${sig}: shutting down`); await svc.close(); process.exit(0); };
process.on('SIGINT', () => void stop('SIGINT'));
process.on('SIGTERM', () => void stop('SIGTERM'));
