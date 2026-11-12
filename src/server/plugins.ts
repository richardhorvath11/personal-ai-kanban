import type { Plugin } from './service.ts';
import { demoPlugin } from './demo.ts';
import { sessionsPlugin } from './sessions-plugin.ts';

export function allPlugins(opts: { seedDemo?: boolean } = {}): Plugin[] {
  return [demoPlugin(!!opts.seedDemo), sessionsPlugin];
}
