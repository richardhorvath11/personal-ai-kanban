-- Background review output. One row per (task, kind): repeats are consolidated (count/last_seen), snoozable.
CREATE TABLE alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  kind TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info',
  message TEXT NOT NULL,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  snoozed_until TEXT,
  resolved_at TEXT,
  UNIQUE (task_id, kind)
);
CREATE TABLE review_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, evaluated_at TEXT NOT NULL, alerts INTEGER NOT NULL);
