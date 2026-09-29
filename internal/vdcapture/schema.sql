-- video-debugger flow-capture store (Phase 1).
-- One SQLite file per app, at a STATE path (e.g. /var/lib/<app>/flows.db) — never
-- inside the deployed code tree, which the next deploy clobbers.
-- flowstore.py applies this idempotently on open; keep it the single source of truth.

PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS sessions (
    id           TEXT PRIMARY KEY,          -- client-generated random id (not a user id)
    started_at   TEXT NOT NULL,             -- server clock, ISO-8601 UTC, first batch seen
    last_seen_at TEXT NOT NULL,             -- server clock, last batch seen
    viewport_w   INTEGER,                   -- viewport at session start (for matrix coverage)
    viewport_h   INTEGER,
    ua_class     TEXT,                      -- 'mobile' | 'tablet' | 'desktop' — never the raw UA
    event_count  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    seq         INTEGER NOT NULL,           -- client order within the session
    t_ms        INTEGER NOT NULL,           -- ms since session start (client monotonic clock)
    type        TEXT NOT NULL,              -- nav | click | input | change | submit | scroll | resize | error
    path        TEXT,                       -- location.pathname (query values stripped client-side)
    target      TEXT,                       -- JSON: {testid, id, role, name, tag, css} — locator hints
    data        TEXT,                       -- JSON: type-specific payload (never raw input values)
    UNIQUE (session_id, seq)                -- makes re-sent batches idempotent
);

CREATE INDEX IF NOT EXISTS events_session ON events(session_id, seq);
CREATE INDEX IF NOT EXISTS sessions_last_seen ON sessions(last_seen_at);

-- Canonical flows the agent has promoted from mined sessions into Playwright scripts.
-- Lets `flowstore.py mine` mark which clusters are already covered by a vdebug flow.
CREATE TABLE IF NOT EXISTS flows (
    id          TEXT PRIMARY KEY,           -- the route signature hash from `mine`
    name        TEXT NOT NULL,              -- vdebug flow NAME that covers it
    signature   TEXT NOT NULL,              -- JSON list of steps the cluster collapses to
    sessions    INTEGER NOT NULL,           -- sessions in the cluster when promoted
    promoted_at TEXT NOT NULL
);
