-- 数据库迁移脚本
-- 将 Workers 的数据库结构修改为与原版 BeeCount Cloud 一致
-- 执行时间: 2026-05-17
-- 注意：此迁移会修改表结构

-- 1. 修改 backup_remotes 表
-- 添加 user_id 字段（从 users 表关联）
ALTER TABLE backup_remotes ADD COLUMN user_id TEXT REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE backup_remotes RENAME TO backup_remotes_old;

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

-- 迁移数据
INSERT INTO backup_remotes (user_id, name, backend_type, config_summary, created_at, updated_at)
SELECT user_id, name, backend_type, config_json, created_at, updated_at
FROM backup_remotes_old;

DROP TABLE backup_remotes_old;

-- 2. 修改 backup_schedules 表
-- 添加 user_id 字段
ALTER TABLE backup_schedules RENAME TO backup_schedules_old;

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

-- 迁移数据（需要关联 ledger 表获取 user_id）
INSERT INTO backup_schedules (id, user_id, name, enabled, cron_expr, retention_days, created_at, updated_at)
SELECT bs.id, l.user_id, bs.name, bs.enabled, bs.cron_expression, bs.retention_days, bs.created_at, bs.updated_at
FROM backup_schedules_old bs
JOIN ledgers l ON bs.ledger_id = l.id;

DROP TABLE backup_schedules_old;

-- 3. 修改 backup_runs 表
-- 添加 user_id 字段（从关联的 ledger 获取）
ALTER TABLE backup_runs RENAME TO backup_runs_old;

CREATE TABLE IF NOT EXISTS backup_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    schedule_id TEXT REFERENCES backup_schedules(id) ON DELETE SET NULL,
    ledger_id TEXT NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
    remote_id TEXT REFERENCES backup_remotes(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    error_message TEXT,
    backup_size INTEGER,
    backup_path TEXT,
    started_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
    completed_at TEXT
);

-- 迁移数据
INSERT INTO backup_runs (id, schedule_id, ledger_id, remote_id, status, error_message, backup_size, backup_path, started_at, completed_at)
SELECT id, schedule_id, ledger_id, remote_id, status, error_message, backup_size, backup_path, started_at, completed_at
FROM backup_runs_old;

DROP TABLE backup_runs_old;

-- 4. 创建 backup_schedule_remotes 表（多对多关系）
CREATE TABLE IF NOT EXISTS backup_schedule_remotes (
    schedule_id INTEGER NOT NULL REFERENCES backup_schedules(id) ON DELETE CASCADE,
    remote_id INTEGER NOT NULL REFERENCES backup_remotes(id) ON DELETE RESTRICT,
    sort_order INTEGER DEFAULT 0,
    PRIMARY KEY (schedule_id, remote_id)
);

-- 5. 创建 backup_run_targets 表
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

CREATE INDEX IF NOT EXISTS idx_backup_run_targets_run_id ON backup_run_targets(run_id);
CREATE INDEX IF NOT EXISTS idx_backup_run_targets_remote_id ON backup_run_targets(remote_id);

-- 6. 添加缺失的索引
CREATE INDEX IF NOT EXISTS idx_sync_cursors_updated_at ON sync_cursors(updated_at);
