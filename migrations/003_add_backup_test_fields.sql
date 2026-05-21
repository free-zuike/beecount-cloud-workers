-- 添加备份远程配置的测试状态字段
-- 执行时间: 2026-05-21

ALTER TABLE backup_remotes ADD COLUMN IF NOT EXISTS last_test_at TEXT;
ALTER TABLE backup_remotes ADD COLUMN IF NOT EXISTS last_test_ok BOOLEAN;
ALTER TABLE backup_remotes ADD COLUMN IF NOT EXISTS last_test_error TEXT;

-- 同时确保 config_summary 字段存在（如果还没创建）
-- 有些数据库可能使用 config_json，我们需要统一
-- 但由于我们已经使用了 Time Travel 恢复，这个字段应该已经存在
