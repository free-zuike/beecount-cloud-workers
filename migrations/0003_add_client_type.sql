-- Migration 0003: refresh_tokens加client_type列，password_hash加兼容层
-- 1. refresh_tokens 添加 client_type 列
ALTER TABLE refresh_tokens ADD COLUMN client_type TEXT DEFAULT 'app';
