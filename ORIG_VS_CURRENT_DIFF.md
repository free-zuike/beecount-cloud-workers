# 原版 Python vs 当前 TypeScript 对比（已全部修复）

## 修复记录（2026-07-05）

### 数据库 Schema
1. `read_tx_projection` 新增 `last_edited_by_user_id` 列
2. account/category/tag 投影表添加 `UNIQUE INDEX (user_id, sync_id)` 防重复行
3. 启动时清理可能存在的重复行

### Sync 端点
4. push 冲突写 `sync_conflict` 审计日志
5. push 广播 `__user_global__` 通道事件
6. push 共享账本 fan-out：给非 owner member 广播 `shared_resource_change`
7. push 广播给所有账本成员（不仅是当前用户）
8. push 批量预加载 member role（消除逐条查询）
9. pull 补全 `last_edited_by_user_id`
10. full 支持共享账本 + latest_cursor 只取该账本
11. full snapshot 格式对齐原版（items/ledgerSyncId/ledgerName/currency/monthStartDay/count）
12. full 添加 snapshot 缓存（60s TTL）

### Write 端点
13. 更新/创建账本 meta 写 `ledger` 类型 SyncChange（非 `ledger_snapshot`）
14. 删除账本清理 sync_changes 历史（去掉多余过滤）
15. 删除 tx 时检查附件引用再 GC（与原版 gc_orphan_attachments 对齐）
16. 删除分类清理 R2 图标文件
17. 删除用户清理 R2 存储（头像/分类图标/附件）
18. 新增 budget usage 端点

### Read 端点
19. read/ledgers 支持共享账本（LEFT JOIN ledger_members）
20. read/ledgers 返回 `month_start_day` 字段
21. read/transactions 接口补全 `exclude_from_stats`/`exclude_from_budget`

### Workspace 端点
22. workspace/transactions 支持共享账本
23. workspace/accounts 支持共享账本
24. workspace/categories 支持共享账本
25. workspace/tags 支持共享账本
26. workspace/budgets 支持共享账本
27. workspace/ledger-counts 支持共享账本
28. workspace/analytics 支持共享账本

### 投影逻辑
29. ledger 加入 INDIVIDUAL_ENTITY_TYPES
30. push 处理 ledger 类型更新 ledgers 表
31. merge_with_existing：payload 缺失字段用已有行旧值补齐（category/account/tag）
32. rename cascade：account/category/tag 改名时级联更新 tx denorm 列
33. 删除 user-global 实体时清理 upsert 历史（_compact_entity_upsert_events）

### Bug 修复
34. login 端点 `userId` → `user.id` 未定义 bug
35. 创建交易 handler 补全缺失变量定义
36. 注册去掉默认账本/分类（消除双账本 + 126 次 DB 写入）

## 有意保留的差异

| 差异 | 原因 |
|------|------|
| pull 不过滤设备自身变更 | 无 WS 推送环境下设备需看到自身变更 |
| admin health 返回 `"ok"` 而非 `"healthy"` | 有意变更 |
| summary 字段名 `transaction_count`/`latest_happened_at` | 有意变更 |
| push 写 `sync_push` 审计日志 | 原版无此审计，当前多做 |
| D1 无锁（原版有 `lock_ledger_for_materialize`） | D1 保证单写 |
| 错误处理：单条失败跳过（原版 rollback 整批） | 当前更宽容 |

## 架构等价性

| 功能 | 原版 | 当前 | 状态 |
|------|------|------|------|
| LWW 冲突解决 | ✅ | ✅ | 对齐 |
| 共享账本 | ✅ | ✅ | 对齐 |
| user-global 实体 | ✅ | ✅ | 对齐 |
| rename cascade | ✅ | ✅ | 对齐 |
| attachment GC | ✅ | ✅ | 对齐 |
| snapshot 缓存 | ✅ | ✅ | 对齐 |
| merge_with_existing | ✅ | ✅ | 对齐 |
| compact upsert events | ✅ | ✅ | 对齐 |
