-- The backlog: proposals of what to pick up next, the issues picked up and waiting for a session, and the Mac service's last look.

CREATE TABLE proposal (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL,
  asked_at TEXT NOT NULL,
  -- When the Mac service started the session that reads the backlog.
  started_at TEXT,
  -- When that session wrote its list: a JSON list of {issue, title, suggestion, reason}.
  written_at TEXT,
  items TEXT,
  answered_at TEXT,
  -- The owner's choice for each issue, keyed by the issue's number, and the note.
  answers TEXT,
  note TEXT,
  -- When the Mac service took the answers to carry them out.
  carried_at TEXT,
  -- When the Mac service started a session for the note.
  note_started_at TEXT,
  done_at TEXT,
  failed_at TEXT,
  failure TEXT
);

-- A repo has at most one proposal under way. A failed one waits for the owner without holding up a new one.
CREATE UNIQUE INDEX proposal_open ON proposal (repo) WHERE done_at IS NULL AND failed_at IS NULL;

CREATE TABLE pickup (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL,
  issue INTEGER NOT NULL,
  proposal_id INTEGER REFERENCES proposal (id),
  asked_at TEXT NOT NULL,
  started_at TEXT,
  -- Set when the issue's first status is written, or once a dropped pick-up's label is off.
  done_at TEXT,
  failed_at TEXT,
  failure TEXT,
  -- The owner dropped it; the Mac service takes the label off and then marks it done.
  dropped_at TEXT
);

CREATE UNIQUE INDEX pickup_open ON pickup (repo, issue) WHERE done_at IS NULL;

-- One row: what the Mac service saw at its last look.
CREATE TABLE service_look (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  at TEXT NOT NULL,
  running INTEGER NOT NULL,
  max_sessions INTEGER NOT NULL,
  repos TEXT NOT NULL
);
