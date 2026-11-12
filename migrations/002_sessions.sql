-- Claude sessions and their task links. Agent activity is tracked here, separate from task status.
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  repo TEXT NOT NULL DEFAULT '',
  cwd TEXT NOT NULL DEFAULT '',
  worktree TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  current_task_id TEXT REFERENCES tasks(id),
  started_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  ended_at TEXT,
  end_reason TEXT,
  last_checkpoint_at TEXT,
  last_checkpoint_task TEXT
);
CREATE TABLE session_tasks (
  session_id TEXT NOT NULL REFERENCES sessions(id),
  task_id TEXT NOT NULL REFERENCES tasks(id),
  linked_at TEXT NOT NULL,
  PRIMARY KEY (session_id, task_id)
);
