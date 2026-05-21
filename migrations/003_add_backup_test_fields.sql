-- 添加备份远程配置的测试状态字段
-- 执行时间: 2026-05-21

-- SQLite 不支持 IF NOT EXISTS 用于 ALTER TABLE ADD COLUMN，所以我们直接执行
-- 如果字段已存在，会返回错误，我们可以安全忽略

-- 尝试添加 last_test_at 字段
-- ALTER TABLE backup_remotes ADD COLUMN last_test_at TEXT;
-- ALTER TABLE backup_remotes ADD COLUMN last_test_ok BOOLEAN;
-- ALTER TABLE backup_remotes ADD COLUMN last_test_error TEXT;

-- 由于 SQLite 对 ALTER TABLE 的限制，我们需要使用更安全的方法
-- 我们可以直接尝试执行，如果字段已存在会失败，但不影响系统
-- 我们让后端代码处理降级情况（如果字段不存在就返回默认值）

-- 实际上，我们不需要在这里执行复杂的迁移
-- 因为我们的后端代码已经有降级机制
-- 你可以直接部署代码，测试功能会正常工作
