-- The board's own record of the work: one row per piece of work, the answers sent to it, and a log of every change.

CREATE TABLE work (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL,
  issue INTEGER,
  pr INTEGER,
  has_design INTEGER NOT NULL,
  gate TEXT NOT NULL,
  state TEXT NOT NULL,
  reached TEXT NOT NULL,
  ask TEXT NOT NULL,
  questions TEXT NOT NULL,
  to_test TEXT,
  back_reason TEXT,
  approved TEXT NOT NULL,
  rounds TEXT NOT NULL,
  prep_sha TEXT,
  version INTEGER NOT NULL,
  turn_since TEXT NOT NULL,
  written_at TEXT NOT NULL,
  confirmed_at TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  ended_how TEXT
);

-- A PR or an issue belongs to at most one open record.
CREATE UNIQUE INDEX work_open_pr ON work (repo, pr) WHERE ended_at IS NULL AND pr IS NOT NULL;
CREATE UNIQUE INDEX work_open_issue ON work (repo, issue) WHERE ended_at IS NULL AND issue IS NOT NULL;

CREATE TABLE answer (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id INTEGER NOT NULL REFERENCES work (id),
  version INTEGER NOT NULL,
  at TEXT NOT NULL,
  choices TEXT NOT NULL,
  approval TEXT,
  note TEXT NOT NULL,
  claimed_at TEXT,
  claimed_by TEXT,
  state_before TEXT,
  -- The ask the record had before the claim, so a failed start can put it back.
  ask_before TEXT,
  gave_up_at TEXT,
  give_up_hint TEXT
);

CREATE INDEX answer_work ON answer (work_id, version);

CREATE TABLE log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id INTEGER NOT NULL REFERENCES work (id),
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  change TEXT NOT NULL
);

CREATE INDEX log_work ON log (work_id, at);
