-- 迁移账本数据：将 name 字段中的数字提取出来，更新到 external_id
-- 这样可以与 APP 显示的数字 ID 保持一致

-- 查看当前账本数据
SELECT 'Before migration' as status, id, external_id, name FROM ledgers;

-- 更新策略：
-- 1. 如果 name 是纯数字（通过 CAST 测试），更新 external_id 为该数字
-- 2. 如果 name 不是纯数字，保持 external_id 不变

UPDATE ledgers 
SET external_id = name 
WHERE CAST(name AS INTEGER) = name 
AND name IS NOT NULL 
AND name != '';

-- 验证更新结果
SELECT 'After migration' as status, id, external_id, name FROM ledgers;
