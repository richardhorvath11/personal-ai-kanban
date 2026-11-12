// Durable local outbox. Pending updates are files written atomically (fsync + rename) under
// <dataDir>/outbox/pending, each carrying a unique opId so delivery is idempotent on the service.
// An entry is deleted only after the service acknowledges it. Rejected entries move to failed/
// with the reason, so nothing acknowledged-by-the-user is silently lost.
import fs from 'node:fs';
import path from 'node:path';
import { writeAtomic } from './runtime.ts';

export interface OutboxOp {
  opId: string;
  method: 'POST' | 'PATCH';
  path: string;
  body: Record<string, unknown>;
  client: 'mcp' | 'hook' | 'cli';
  createdAt: string;
  attempts?: number;
  lastError?: string;
}

export const ALLOWED_PATHS = [/^\/api\/sessions\/checkpoint$/, /^\/api\/sessions\/start$/, /^\/api\/sessions\/link$/, /^\/api\/sessions\/[^/]+\/end$/, /^\/api\/tasks$/, /^\/api\/tasks\/[^/]+$/];

export class Outbox {
  root: string;
  constructor(dataDir: string) {
    this.root = path.join(dataDir, 'outbox');
    for (const d of ['pending', 'failed', 'dismissed']) fs.mkdirSync(path.join(this.root, d), { recursive: true });
  }
  private file(kind: string, opId: string) { return path.join(this.root, kind, `${opId.replace(/[^A-Za-z0-9_.-]/g, '_')}.json`); }

  enqueue(op: Omit<OutboxOp, 'createdAt'> & { createdAt?: string }): OutboxOp {
    if (!op.opId) throw new Error('outbox entries need an opId');
    if (!ALLOWED_PATHS.some((r) => r.test(op.path))) throw new Error(`outbox path not allowed: ${op.path}`);
    const full: OutboxOp = { ...op, body: { ...op.body, opId: op.opId }, createdAt: op.createdAt ?? new Date().toISOString(), attempts: op.attempts ?? 0 };
    writeAtomic(this.file('pending', op.opId), JSON.stringify(full));
    return full;
  }

  list(kind: 'pending' | 'failed' = 'pending'): OutboxOp[] {
    const dir = path.join(this.root, kind);
    const out: OutboxOp[] = [];
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
      try { out.push(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))); } catch { /* partial write impossible (atomic rename); skip unreadable */ }
    }
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  ack(opId: string) { fs.rmSync(this.file('pending', opId), { force: true }); }
  bump(op: OutboxOp, err: string) { writeAtomic(this.file('pending', op.opId), JSON.stringify({ ...op, attempts: (op.attempts ?? 0) + 1, lastError: err })); }
  fail(op: OutboxOp, err: string) {
    writeAtomic(this.file('failed', op.opId), JSON.stringify({ ...op, lastError: err, failedAt: new Date().toISOString() }));
    fs.rmSync(this.file('pending', op.opId), { force: true });
  }
  requeueFailed(): number {
    const f = this.list('failed');
    for (const op of f) { writeAtomic(this.file('pending', op.opId), JSON.stringify({ ...op })); fs.rmSync(this.file('failed', op.opId), { force: true }); }
    return f.length;
  }
  dismiss(opId: string): boolean {
    const src = this.file('failed', opId);
    if (!fs.existsSync(src)) return false;
    fs.renameSync(src, this.file('dismissed', opId));
    return true;
  }
  counts() { return { pending: this.list('pending').length, failed: this.list('failed').length }; }
}

export type Sender = (op: OutboxOp) => Promise<{ ok: true } | { ok: false; retryable: boolean; error: string }>;

/** Deliver pending ops in order. Stops at the first retryable failure (service down) or when the budget runs out. */
export async function drain(outbox: Outbox, send: Sender, budgetMs = 2000): Promise<{ applied: number; failed: number; pending: number; lastError: string | null }> {
  const until = Date.now() + budgetMs;
  let applied = 0, failed = 0;
  let lastError: string | null = null;
  for (const op of outbox.list('pending')) {
    if (Date.now() > until) break;
    const r = await send(op);
    if (r.ok) { outbox.ack(op.opId); applied++; continue; }
    lastError = r.error;
    if (r.retryable) { outbox.bump(op, r.error); break; }
    outbox.fail(op, r.error);
    failed++;
  }
  return { applied, failed, pending: outbox.list('pending').length, lastError };
}
