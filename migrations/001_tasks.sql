CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO meta(key, value) VALUES ('task_seq', '0');

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  project TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('inbox','ready','in_progress','waiting','review','done')),
  outcome TEXT NOT NULL DEFAULT '',
  completion_conditions TEXT NOT NULL DEFAULT '[]',
  summary TEXT NOT NULL DEFAULT '',
  next_action TEXT NOT NULL DEFAULT '',
  checklist TEXT NOT NULL DEFAULT '[]',
  findings TEXT NOT NULL DEFAULT '[]',
  links TEXT NOT NULL DEFAULT '[]',
  deadline TEXT,
  deadline_kind TEXT CHECK (deadline_kind IS NULL OR deadline_kind IN ('firm','flexible')),
  deadline_tz TEXT,
  deadline_label TEXT NOT NULL DEFAULT '',
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('high','normal','low')),
  priority_context TEXT NOT NULL DEFAULT '',
  pinned INTEGER NOT NULL DEFAULT 0,
  position REAL NOT NULL DEFAULT 0,
  waiting_reason TEXT NOT NULL DEFAULT '',
  waiting_on TEXT NOT NULL DEFAULT '',
  follow_up_at TEXT,
  follow_up_condition TEXT NOT NULL DEFAULT '',
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_meaningful_at TEXT NOT NULL,
  last_synced_at TEXT,
  revision INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX tasks_project ON tasks(project);
CREATE INDEX tasks_status ON tasks(status);

CREATE TABLE deps (
  task_id TEXT NOT NULL REFERENCES tasks(id),
  depends_on TEXT NOT NULL REFERENCES tasks(id),
  PRIMARY KEY (task_id, depends_on)
);

CREATE TABLE activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  session_id TEXT,
  kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  changes TEXT NOT NULL DEFAULT '[]',
  source_note TEXT NOT NULL DEFAULT '',
  op_id TEXT,
  revision INTEGER NOT NULL DEFAULT 0,
  undo_of INTEGER,
  undone_by INTEGER
);
CREATE INDEX activity_task ON activity(task_id, id);
CREATE INDEX activity_at ON activity(at);

-- Idempotency ledger: one row per acknowledged operation ID.
CREATE TABLE operations (
  op_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  task_id TEXT,
  result TEXT NOT NULL,
  at TEXT NOT NULL
);
