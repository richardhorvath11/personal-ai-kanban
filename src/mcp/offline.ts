import type { KanbanClient } from '../core/client.ts';
import { Outbox } from '../core/outbox.ts';
import { sendOrQueue } from '../core/deliver.ts';
import { dataDirFromEnv } from '../core/runtime.ts';

let outbox: Outbox | null = null;
export const getOutbox = () => (outbox ??= new Outbox(dataDirFromEnv()));

export async function checkpointWithOutbox(client: KanbanClient, body: Record<string, unknown>) {
  const r = await sendOrQueue<any>(client, getOutbox(), 'POST', '/api/sessions/checkpoint', body);
  if (r.acknowledged) {
    const t = r.result.task;
    return { acknowledged: true, duplicate: r.result.duplicate, opId: r.opId, task: { id: t.id, title: t.title, status: t.status, revision: t.revision, nextAction: t.nextAction }, checkpointAt: r.result.checkpointAt };
  }
  return { acknowledged: false, queued: true, opId: r.opId, warning: r.message };
}
