-- 数据库迁移脚本
-- 将 Workers 的数据库结构修改为与原版 BeeCount Cloud 一致

-- 1. 先确保 backup 相关表存在（如果 0001 没创建的话）
CREATE TABLE IF NOT EXISTS backup_remotes (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    backend_type TEXT NOT NULL,
    config_json TEXT NOT NULL,
    is_default BOOLEAN DEFAULT 0 NOT NULL,
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
    updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);

CREATE TABLE IF NOT EXISTS backup_schedules (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    ledger_id TEXT NOT NULL,
    remote_id TEXT,
    cron_expression TEXT NOT NULL,
    retention_days INTEGER DEFAULT 30,
    enabled BOOLEAN DEFAULT 1 NOT NULL,
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
    updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);

CREATE TABLE IF NOT EXISTS backup_runs (
    id TEXT PRIMARY KEY,
    schedule_id TEXT,
    ledger_id TEXT NOT NULL,
    remote_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    error_message TEXT,
    backup_size INTEGER,
    backup_path TEXT,
    started_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
    completed_at TEXT
);

-- 2. 修改 backup_remotes 表（迁移结构）
ALTER TABLE backup_remotes ADD COLUMN user_id TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE backup_remotes RENAME TO backup_remotes_old;

CREATE TABLE IF NOT EXISTS backup_remotes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
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

INSERT OR IGNORE INTO backup_remotes (id, user_id, name, backend_type, config_summary, created_at, updated_at)
SELECT id, NULL, name, backend_type, config_json, created_at, updated_at FROM backup_remotes_old;

DROP TABLE backup_remotes_old;

-- 3. 创建索引
CREATE INDEX IF NOT EXISTS idx_backup_remotes_user_id ON backup_remotes(user_id);
