-- Migration 0005: Fix backup schema gaps
-- Adds missing columns required by upload-db, upload-snapshot, and prepare-restore endpoints

-- 1. backup_runs: add user_id column (needed by prepare-restore query)
ALTER TABLE backup_runs ADD COLUMN user_id TEXT REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_backup_runs_user_id ON backup_runs(user_id);

-- 2. backup_snapshots: add columns needed by upload-db and upload-snapshot endpoints
ALTER TABLE backup_snapshots ADD COLUMN kind TEXT DEFAULT 'snapshot';
ALTER TABLE backup_snapshots ADD COLUMN file_name TEXT;
ALTER TABLE backup_snapshots ADD COLUMN content_type TEXT;
ALTER TABLE backup_snapshots ADD COLUMN checksum TEXT;
ALTER TABLE backup_snapshots ADD COLUMN size INTEGER;
