// Hook configuration written by the installer. Verified against Claude Code 2.1.310 hooks reference
// (code.claude.com/docs/en/hooks): command hooks in exec form (`command` + `args`), per-handler `timeout` in seconds.
import path from 'node:path';

const HOOK = path.resolve(import.meta.dirname, '..', 'hooks', 'hook.ts');

type Handler = { type: 'command'; command: string; args: string[]; timeout: number };
export const HOOK_PATH = HOOK;
export function hookEntries(o: { url: string; dataDir: string; scope?: 'global' | 'project' }): Record<string, { matcher?: string; hooks: Handler[] }> {
  const extra = o.scope === 'global' ? ['--scope', 'global'] : [];
  const h = (ev: string, timeout: number): Handler => ({ type: 'command', command: process.execPath, args: [HOOK, ev, '--url', o.url, '--data-dir', o.dataDir, ...extra], timeout });
  return {
    SessionStart: { matcher: 'startup|resume|clear|compact', hooks: [h('session-start', 10)] },
    PostToolUse: { matcher: 'Edit|Write|MultiEdit|NotebookEdit', hooks: [h('post-tool-use', 5)] },
    Stop: { hooks: [h('stop', 10)] },
    SessionEnd: { hooks: [h('session-end', 5)] },
  };
}
