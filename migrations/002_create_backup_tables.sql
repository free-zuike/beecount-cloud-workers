-- 创建备份相关的表（如果不存在）
-- 执行时间: 2026-05-20
-- 注意：此表结构必须与 src/routes/admin_backup.ts 中的查询一致

-- 1. 创建 backup_remotes 表
CREATE TABLE IF NOT EXISTS backup_remotes (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    backend_type TEXT NOT NULL,
    config_json TEXT NOT NULL,
    is_default BOOLEAN DEFAULT 0 NOT NULL,
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
    updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_backup_remotes_backend_type ON backup_remotes(backend_type);

-- 2. 创建 backup_schedules 表
CREATE TABLE IF NOT EXISTS backup_schedules (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    ledger_id TEXT NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
    remote_id TEXT REFERENCES backup_remotes(id) ON DELETE SET NULL,
    cron_expression TEXT NOT NULL,
    retention_days INTEGER DEFAULT 30,
    enabled BOOLEAN DEFAULT 1 NOT NULL,
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
    updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_backup_schedules_ledger_id ON backup_schedules(ledger_id);
CREATE INDEX IF NOT EXISTS idx_backup_schedules_remote_id ON backup_schedules(remote_id);
CREATE INDEX IF NOT EXISTS idx_backup_schedules_enabled ON backup_schedules(enabled);

-- 3. 创建 backup_runs 表
CREATE TABLE IF NOT EXISTS backup_runs (
    id TEXT PRIMARY KEY,
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

CREATE INDEX IF NOT EXISTS idx_backup_runs_schedule_id ON backup_runs(schedule_id);
CREATE INDEX IF NOT EXISTS idx_backup_runs_ledger_id ON backup_runs(ledger_id);
CREATE INDEX IF NOT EXISTS idx_backup_runs_status ON backup_runs(status);
CREATE INDEX IF NOT EXISTS idx_backup_runs_started_at ON backup_runs(started_at DESC);
