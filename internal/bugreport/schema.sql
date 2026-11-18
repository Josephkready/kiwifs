-- Local tier of the in-app bug reporter. State path only (never under --root
-- or the deploy checkout). Description, context and screenshots live here;
-- GitHub only ever sees ids and a link back (built by the host worker).
CREATE TABLE IF NOT EXISTS bug_reports (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    key           TEXT NOT NULL UNIQUE,
    description   TEXT NOT NULL,
    context_json  TEXT NOT NULL,
    slug          TEXT NOT NULL DEFAULT '',
    path          TEXT NOT NULL DEFAULT '',
    app_version   TEXT NOT NULL DEFAULT '',
    created_at    TEXT NOT NULL,
    sync_status   TEXT NOT NULL DEFAULT 'pending-sync',
    job_id        TEXT,
    issue_number  INTEGER,
    issue_url     TEXT,
    error_category TEXT,
    updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS bug_reports_path ON bug_reports(path, id);
CREATE INDEX IF NOT EXISTS bug_reports_sync ON bug_reports(sync_status);
CREATE TABLE IF NOT EXISTS bug_report_images (
    report_id INTEGER NOT NULL REFERENCES bug_reports(id) ON DELETE CASCADE,
    pos       INTEGER NOT NULL,
    mime      TEXT NOT NULL,
    data      BLOB NOT NULL,
    PRIMARY KEY (report_id, pos)
);
