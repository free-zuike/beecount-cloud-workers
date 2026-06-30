-- Migration 0002: backup tables id from TEXT to INTEGER AUTOINCREMENT

-- backup_remotes
CREATE TABLE IF NOT EXISTS backup_remotes_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    backend_type TEXT NOT NULL,
    config_summary TEXT NOT NULL,
    encrypted BOOLEAN DEFAULT 0 NOT NULL,
    last_test_at TEXT,
    last_test_ok BOOLEAN,
    last_test_error TEXT,
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
    updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);

INSERT INTO backup_remotes_new (name, backend_type, config_summary, encrypted, last_test_at, last_test_ok, last_test_error, created_at, updated_at)
SELECT name, backend_type, config_summary, encrypted, last_test_at, last_test_ok, last_test_error, created_at, updated_at
FROM backup_remotes WHERE id IS NOT NULL;

DROP TABLE IF EXISTS backup_remotes;
ALTER TABLE backup_remotes_new RENAME TO backup_remotes;
CREATE INDEX IF NOT EXISTS idx_backup_remotes_backend_type ON backup_remotes(backend_type);

-- backup_schedules
CREATE TABLE IF NOT EXISTS backup_schedules_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    user_id TEXT NOT NULL,
    cron_expr TEXT NOT NULL,
    remote_ids TEXT,
    retention_days INTEGER DEFAULT 30,
    include_attachments BOOLEAN DEFAULT 1 NOT NULL,
    enabled BOOLEAN DEFAULT 1 NOT NULL,
    timezone_offset INTEGER DEFAULT 0,
    next_run_at TEXT,
    last_run_at TEXT,
    last_run_status TEXT,
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
    updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);

INSERT INTO backup_schedules_new (name, user_id, cron_expr, remote_ids, retention_days, include_attachments, enabled, timezone_offset, next_run_at, last_run_at, last_run_status, created_at, updated_at)
SELECT name, user_id, cron_expr, remote_ids, retention_days, include_attachments, enabled, timezone_offset, next_run_at, last_run_at, last_run_status, created_at, updated_at
FROM backup_schedules WHERE id IS NOT NULL;

DROP TABLE IF EXISTS backup_schedules;
ALTER TABLE backup_schedules_new RENAME TO backup_schedules;
CREATE INDEX IF NOT EXISTS idx_backup_schedules_user_id ON backup_schedules(user_id);
CREATE INDEX IF NOT EXISTS idx_backup_schedules_enabled ON backup_schedules(enabled);

-- backup_runs
CREATE TABLE IF NOT EXISTS backup_runs_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    schedule_id INTEGER,
    ledger_id TEXT NOT NULL,
    remote_id INTEGER,
    status TEXT NOT NULL DEFAULT 'pending',
    error_message TEXT,
    bytes_total INTEGER,
    backup_filename TEXT,
    backup_path TEXT,
    started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    finished_at TEXT
);

INSERT INTO backup_runs_new (schedule_id, ledger_id, remote_id, status, error_message, bytes_total, backup_filename, backup_path, started_at, finished_at)
SELECT schedule_id, ledger_id, remote_id, status, error_message, bytes_total, backup_filename, backup_path, started_at, finished_at
FROM backup_runs WHERE id IS NOT NULL;

DROP TABLE IF EXISTS backup_runs;
ALTER TABLE backup_runs_new RENAME TO backup_runs;
CREATE INDEX IF NOT EXISTS idx_backup_runs_schedule_id ON backup_runs(schedule_id);
CREATE INDEX IF NOT EXISTS idx_backup_runs_status ON backup_runs(status);

-- backup_restores
CREATE TABLE IF NOT EXISTS backup_restores_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,
    run_id INTEGER,
    status TEXT NOT NULL DEFAULT 'preparing',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO backup_restores_new (user_id, run_id, status, created_at)
SELECT user_id, run_id, status, created_at
FROM backup_restores WHERE id IS NOT NULL;

DROP TABLE IF EXISTS backup_restores;
ALTER TABLE backup_restores_new RENAME TO backup_restores;
CREATE INDEX IF NOT EXISTS idx_backup_restores_user_id ON backup_restores(user_id);
