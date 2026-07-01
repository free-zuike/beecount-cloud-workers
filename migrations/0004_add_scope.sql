-- Migration 0004: sync_changes添加scope列，支持user-global实体
-- scope: 'ledger'(默认) 或 'user'(user-global category/account/tag)
ALTER TABLE sync_changes ADD COLUMN scope TEXT DEFAULT 'ledger';
