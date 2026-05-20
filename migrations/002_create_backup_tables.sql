-- 创建备份相关的表（如果不存在）
-- 执行时间: 2026-05-20

-- 1. 创建 backup_remotes 表
CREATE TABLE IF NOT EXISTS backup_remotes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    backend_type TEXT NOT NULL,
    encrypted BOOLEAN DEFAULT 0 NOT NULL,
    config_summary TEXT,
    last_test_at TEXT,
    last_test_ok BOOLEAN,
    last_test_error TEXT,
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
    updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
    UNIQUE(user_id, name)
);

-- 2. 创建 backup_schedules 表
CREATE TABLE IF NOT EXISTS backup_schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    enabled BOOLEAN DEFAULT 1 NOT NULL,
    cron_expr TEXT NOT NULL,
    retention_days INTEGER DEFAULT 30,
    include_attachments BOOLEAN DEFAULT 1 NOT NULL,
    next_run_at TEXT,
    last_run_at TEXT,
    last_run_status TEXT,
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
    updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);

-- 3. 创建 backup_runs 表
CREATE TABLE IF NOT EXISTS backup_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    schedule_id INTEGER REFERENCES backup_schedules(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    error_message TEXT,
    backup_filename TEXT,
    bytes_total INTEGER,
    started_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
    finished_at TEXT
);

-- 4. 创建 backup_run_targets 表
CREATE TABLE IF NOT EXISTS backup_run_targets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL REFERENCES backup_runs(id) ON DELETE CASCADE,
    remote_id INTEGER NOT NULL REFERENCES backup_remotes(id),
    status TEXT DEFAULT 'pending',
    started_at TEXT,
    finished_at TEXT,
    bytes_transferred INTEGER,
    error_message TEXT
);

-- 5. 创建 backup_schedule_remotes 表（多对多关系）
CREATE TABLE IF NOT EXISTS backup_schedule_remotes (
    schedule_id INTEGER NOT NULL REFERENCES backup_schedules(id) ON DELETE CASCADE,
    remote_id INTEGER NOT NULL REFERENCES backup_remotes(id) ON DELETE RESTRICT,
    sort_order INTEGER DEFAULT 0,
    PRIMARY KEY (schedule_id, remote_id)
);

-- 6. 创建索引
CREATE INDEX IF NOT EXISTS idx_backup_remotes_user_id ON backup_remotes(user_id);
CREATE INDEX IF NOT EXISTS idx_backup_schedules_user_id ON backup_schedules(user_id);
CREATE INDEX IF NOT EXISTS idx_backup_run_targets_run_id ON backup_run_targets(run_id);
CREATE INDEX IF NOT EXISTS idx_backup_run_targets_remote_id ON backup_run_targets(remote_id);
