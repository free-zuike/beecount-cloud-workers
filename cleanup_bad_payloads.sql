-- 清理旧的 SyncChange 数据（payload 使用 snake_case 格式的问题数据）
-- 这些数据的 payload 包含 tx_type/category_id/sort_order 等 snake_case key，
-- mobile 端无法解析，导致同步卡住。

-- 1. 查看受影响的旧数据量
SELECT entity_type, action, COUNT(*) as cnt
FROM sync_changes
WHERE payload_json LIKE '%tx_type%'
   OR payload_json LIKE '%category_id%'
   OR payload_json LIKE '%sort_order%'
   OR payload_json LIKE '%icon_type%'
   OR payload_json LIKE '%parent_name%'
   OR payload_json LIKE '%start_day%'
   OR payload_json LIKE '%budget_type%'
GROUP BY entity_type, action;

-- 2. 删除旧的 upsert SyncChange（保留 delete 事件）
-- 这些是 web 端在 payload 格式修复前创建的错误数据
DELETE FROM sync_changes
WHERE action = 'upsert'
  AND (
    payload_json LIKE '%"tx_type"%'
    OR payload_json LIKE '%"category_id"%'
    OR payload_json LIKE '%"sort_order"%'
    OR payload_json LIKE '%"icon_type"%'
    OR payload_json LIKE '%"parent_name"%'
    OR payload_json LIKE '%"start_day"%'
    OR payload_json LIKE '%"budget_type"%'
  )
  AND payload_json NOT LIKE '%"syncId"%';

-- 3. 清理对应的投影数据（可能有重复或错误数据）
-- 删除 read_category_projection 中 sync_id 不在任何有效 SyncChange 中的行
DELETE FROM read_category_projection
WHERE sync_id NOT IN (
  SELECT DISTINCT entity_sync_id FROM sync_changes
  WHERE entity_type = 'category'
);

-- 删除 read_account_projection 中的孤立行
DELETE FROM read_account_projection
WHERE sync_id NOT IN (
  SELECT DISTINCT entity_sync_id FROM sync_changes
  WHERE entity_type = 'account'
);

-- 删除 read_tag_projection 中的孤立行
DELETE FROM read_tag_projection
WHERE sync_id NOT IN (
  SELECT DISTINCT entity_sync_id FROM sync_changes
  WHERE entity_type = 'tag'
);

-- 删除 read_budget_projection 中的孤立行
DELETE FROM read_budget_projection
WHERE sync_id NOT IN (
  SELECT DISTINCT entity_sync_id FROM sync_changes
  WHERE entity_type = 'budget'
);

-- 4. 清理 read_category_projection 中可能存在的重复行（保留 source_change_id 最大的）
DELETE FROM read_category_projection
WHERE rowid NOT IN (
  SELECT MAX(rowid) FROM read_category_projection
  GROUP BY user_id, sync_id
);

-- 清理 read_account_projection 重复行
DELETE FROM read_account_projection
WHERE rowid NOT IN (
  SELECT MAX(rowid) FROM read_account_projection
  GROUP BY user_id, sync_id
);

-- 清理 read_tag_projection 重复行
DELETE FROM read_tag_projection
WHERE rowid NOT IN (
  SELECT MAX(rowid) FROM read_tag_projection
  GROUP BY user_id, sync_id
);

-- 5. 验证清理结果
SELECT 'sync_changes' as tbl, COUNT(*) as cnt FROM sync_changes
UNION ALL
SELECT 'read_category_projection', COUNT(*) FROM read_category_projection
UNION ALL
SELECT 'read_account_projection', COUNT(*) FROM read_account_projection
UNION ALL
SELECT 'read_tag_projection', COUNT(*) FROM read_tag_projection
UNION ALL
SELECT 'read_budget_projection', COUNT(*) FROM read_budget_projection;
