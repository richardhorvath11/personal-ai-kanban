// Send-or-queue used by the MCP adapter, hooks and CLI.
import crypto from 'node:crypto';
import { KanbanClient, ServiceError, ServiceUnavailable } from './client.ts';
import { Outbox, drain } from './outbox.ts';
import type { OutboxOp } from './outbox.ts';

export function httpSender(baseUrl: string, timeoutMs = 2000) {
  const clients = new Map<string, KanbanClient>();
  return async (op: OutboxOp) => {
    const c = clients.get(op.client) ?? new KanbanClient({ baseUrl, client: op.client, timeoutMs });
    clients.set(op.client, c);
    try {
      await c.request(op.method, op.path, op.body);
      return { ok: true as const };
    } catch (e) {
      if (e instanceof ServiceUnavailable) return { ok: false as const, retryable: true, error: e.message };
      if (e instanceof ServiceError) return { ok: false as const, retryable: false, error: `${e.code}: ${e.message}` };
      return { ok: false as const, retryable: true, error: (e as Error).message };
    }
  };
}

export interface SendResult<T> { acknowledged: boolean; queued: boolean; opId: string; result?: T; message?: string }

/** Try to deliver now; if the service is unreachable, persist to the outbox (survives process exit). Validation errors are thrown, never queued. */
export async function sendOrQueue<T = any>(client: KanbanClient, outbox: Outbox, method: 'POST' | 'PATCH', p: string, body: Record<string, unknown>): Promise<SendResult<T>> {
  const opId = (body.opId as string) || `op_${crypto.randomUUID()}`;
  const payload = { ...body, opId };
  // Deliver anything queued earlier first so order is preserved.
  if (outbox.list('pending').length) await drain(outbox, httpSender(client.baseUrl, client.timeoutMs), 1500);
  if (!outbox.list('pending').length) {
    try {
      const result = await client.request<T>(method, p, payload);
      return { acknowledged: true, queued: false, opId, result };
    } catch (e) {
      if (!(e instanceof ServiceUnavailable)) throw e;
    }
  }
  outbox.enqueue({ opId, method, path: p, body: payload, client: client.client as OutboxOp['client'] });
  return {
    acknowledged: false, queued: true, opId,
    message: `Board service unreachable at ${client.baseUrl}. Saved to the local outbox (opId ${opId}); it will be applied once when the service returns. It is NOT on the board yet.`,
  };
}
