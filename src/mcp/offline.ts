import type { KanbanClient } from '../core/client.ts';

// Slice 3 adds the durable outbox fallback.
export async function checkpointWithOutbox(client: KanbanClient, body: Record<string, unknown>) {
  return client.post('/api/sessions/checkpoint', body);
}
