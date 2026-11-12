// SQLite storage (Node's built-in node:sqlite) with ordered, versioned migrations.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import type { Mode } from './config.ts';

export interface Migration { version: number; name: string; sql: string }

const MIGRATIONS_DIR = path.join(import.meta.dirname, '..', '..', 'migrations');

export function loadMigrations(): Migration[] {
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{3}_.+\.sql$/.test(f))
    .sort()
    .map((f) => ({ version: Number(f.slice(0, 3)), name: f, sql: fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8') }));
}

export function openDb(dataDir: string, mode: Mode): DatabaseSync {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'kanban.db'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db);
  // Demo isolation: a database is stamped with its mode on first open and refuses the other mode.
  const row = db.prepare("SELECT value FROM meta WHERE key = 'mode'").get() as { value: string } | undefined;
  if (!row) db.prepare("INSERT INTO meta(key, value) VALUES ('mode', ?)").run(mode);
  else if (row.value !== mode) {
    db.close();
    throw new Error(`Refusing to open ${mode} service on a ${row.value} database at ${dataDir}. Demo and real data are kept separate.`);
  }
  return db;
}

export function migrate(db: DatabaseSync): number[] {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
  const applied = new Set((db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map((r) => r.version));
  const ran: number[] = [];
  for (const m of loadMigrations()) {
    if (applied.has(m.version)) continue;
    db.exec('BEGIN');
    try {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)').run(m.version, m.name, new Date().toISOString());
      db.exec('COMMIT');
      ran.push(m.version);
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  return ran;
}
