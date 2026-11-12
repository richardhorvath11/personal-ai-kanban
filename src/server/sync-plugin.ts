// Applies the durable outbox inside the service: on start-up (catch-up), periodically, and on demand.
import fs from 'node:fs';
import path from 'node:path';
import type { Plugin, Service } from './service.ts';
import { Outbox, drain } from '../core/outbox.ts';
import type { OutboxOp } from '../core/outbox.ts';
import { KanbanError } from '../core/errors.ts';
import type { Actor } from '../core/types.ts';

export const syncPlugin: Plugin = (svc) => {
  const outbox = new Outbox(svc.config.dataDir);
  const state = { lastDrainAt: null as string | null, lastAppliedAt: null as string | null, lastError: null as string | null, appliedTotal: 0 };
  svc.features.push('sync');

  const dispatch = async (op: OutboxOp) => {
    const route = svc.routes.find((r) => r.method === op.method && r.pattern.test(op.path));
    if (!route) return { ok: false as const, retryable: false, error: `no route for ${op.method} ${op.path}` };
    const m = route.pattern.exec(op.path)!;
    const actor: Actor = op.client === 'mcp' ? 'claude' : op.client === 'hook' ? 'hook' : 'user';
    try {
      await route.handler({ method: op.method, params: m.slice(1).map(decodeURIComponent), query: new URLSearchParams(), body: op.body, who: { actor, browser: false } });
      return { ok: true as const };
    } catch (e) {
      if (e instanceof KanbanError) return { ok: false as const, retryable: false, error: `${e.code}: ${e.message}` };
      return { ok: false as const, retryable: true, error: (e as Error).message };
    }
  };

  const run = async (budget = 5000) => {
    const r = await drain(outbox, dispatch, budget);
    state.lastDrainAt = new Date().toISOString();
    if (r.applied) { state.lastAppliedAt = state.lastDrainAt; state.appliedTotal += r.applied; }
    state.lastError = r.lastError ?? (r.failed ? state.lastError : null);
    if (r.applied || r.failed) console.log(`[kanban] outbox: applied ${r.applied}, failed ${r.failed}, pending ${r.pending}`);
    return r;
  };
  (svc as Service & { drainOutbox?: typeof run }).drainOutbox = run;
  queueMicrotask(() => void run()); // catch up on start
  const timer = setInterval(() => void run(), 10_000);
  timer.unref();
  svc.onClose.push(() => clearInterval(timer));

  const prev = svc.healthExtra;
  svc.healthExtra = () => {
    let hook: unknown = null;
    try { hook = JSON.parse(fs.readFileSync(path.join(svc.config.dataDir, 'runtime', 'hook-health.json'), 'utf8')); } catch { /* no hook runs yet */ }
    const c = outbox.counts();
    return { ...prev(), sync: { ...c, ...state, hook, ...(prev().sessions ? { sessions: prev().sessions } : {}) } };
  };

  return [
    { method: 'POST', pattern: /^\/api\/sync\/retry$/, handler: async (r) => {
      const requeued = r.body.includeFailed ? outbox.requeueFailed() : 0;
      const res = await run(8000);
      return { requeued, ...res };
    } },
    { method: 'GET', pattern: /^\/api\/sync\/failed$/, handler: () => ({ failed: outbox.list('failed') }) },
    { method: 'POST', pattern: /^\/api\/sync\/failed\/([^/]+)\/dismiss$/, handler: (r) => {
      if (r.who.actor !== 'user') throw new KanbanError('forbidden', 'Only the user can dismiss a failed update');
      return { dismissed: outbox.dismiss(r.params[0]) };
    } },
  ];
};
