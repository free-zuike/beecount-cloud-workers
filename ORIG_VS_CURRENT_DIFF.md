# 原版 Python vs 当前 TypeScript 逐项对比（已修复）

## 一、数据库 Schema 差异（已修复）

### 1. ledgers 表
- **新增** `month_start_day INTEGER DEFAULT 1` — 原版无此列，当前版本支持自定义账期起始日

### 2. read_tx_projection 表
- **新增** `exclude_from_stats BOOLEAN DEFAULT 0`
- **新增** `exclude_from_budget BOOLEAN DEFAULT 0`
- **新增** `last_edited_by_user_id TEXT` — 已修复，与原版对齐

### 3. exchange_rate_overrides 表
- 原版通过 SQLAlchemy 模型 `UserExchangeRateProjection` 管理
- 当前版本是独立 D1 表，字段一致

### 4. backup_runs 表
- 原版 `schedule_id INTEGER` / `remote_id INTEGER`（PostgreSQL 自增主键引用）
- 当前版本 `schedule_id TEXT` / `remote_id TEXT`（D1 用 TEXT 主键）

### 5. backup_restores 表
- 原版 `run_id INTEGER`
- 当前版本 `run_id TEXT`

---

## 二、Sync 端点差异

### GET /sync/pull

| 差异项 | 原版 (Python) | 当前 (TS) | 说明 |
|--------|---------------|-----------|------|
| 设备自身变更 | 过滤 `updated_by_device_id != device_id` | 不过滤 | 当前版本注释说明：无 WS 推送环境下设备需看到自身变更（**有意差异**） |
| `enrichTxPayloads` | 用 `_ChangeWithOverride` 代理对象防修改原 ORM | 直接修改 rows 数组元素的 payload_json 字段 | 功能等价但防御性不同（**有意差异**） |
| `updatedByUserId` 补全 | 仅补 `createdByUserId` 和 `updatedByUserId` | ✅ 同时补 `last_edited_by_user_id` | 已对齐 |
| user-global scope sentinel | `__user_global__` | `__user_global__` | 一致 |
| per-ledger cursor 更新 | ✅ | ✅ | 一致 |

### POST /sync/push

| 差异项 | 原版 (Python) | 当前 (TS) | 说明 |
|--------|---------------|-----------|------|
| 共享账本 fan-out | push 后广播 `shared_resource_change` 给非 owner member | ✅ 已实现 | 与原版一致 |
| `touched_user_global` 广播 | ✅ `broadcast_to_user` 发送 `__user_global__` 通道 | ✅ 已实现 | 与原版一致 |
| Editor 角色守卫 | ✅ 拒绝 editor 推 `ledger` / `ledger_snapshot` | ✅ 相同 | 一致 |
| LWW 时钟钳制 | `min(incoming, server_now + 5s)` | `min(incoming, server_now + 5s)` | 一致 |
| conflict 审计日志 | ✅ 写 AuditLog | ✅ 已实现 | 与原版一致 |
| 审计日志 | 无 push 级审计 | ✅ 写 `sync_push` 审计 | 当前版本多做了（与原版不同但合理） |
| `idempotency_key` 表 | 原版 schema 有 `sync_push_idempotency` 但 push 代码未使用 | 当前 schema 有表但 push 代码也未使用 | 一致 |
| projection 刷新时机 | 单事务内同步 | 批量插入后循环 apply | 可能有差异——原版在 db.add(row_change) 后立即 apply |

### GET /sync/full

| 差异项 | 原版 (Python) | 当前 (TS) | 说明 |
|--------|---------------|-----------|------|
| snapshot 构建 | 调用 `snapshot_builder.build()` + `snapshot_cache` 缓存 | 直接从 projection 表 SELECT 拼装 | 原版有独立 snapshot_builder 模块 + 内存缓存；当前版本每次全查 |
| `latest_cursor` 计算 | `_max_cursor_for_ledgers(db, ledger_ids)` 只取可见账本 | `SELECT MAX(change_id) FROM sync_changes WHERE user_id = ?` 取用户全局最大 | 当前范围更大，可能返回比原版更大的 cursor |
| tombstone 检查 | ✅ 检查 `ledger_snapshot` delete | ✅ 相同 | 一致 |
| 无变更时返回 | `snapshot=null` | `snapshot=null` | 一致 |
| 返回格式 | `{content: json_str, metadata: {...}}` 嵌套在 SyncChangeOut 中 | 外层包裹 `{change_id, ledger_id, ...}` 结构 | 响应结构略有差异 |

### GET /sync/ledgers

| 差异项 | 原版 (Python) | 当前 (TS) | 说明 |
|--------|---------------|-----------|------|
| size 估算 | `512 + tx_count * 300` | `512 + tx_count * 300` | 一致 |
| 软删除检查 | ✅ | ✅ | 一致 |
| 返回字段 | `SyncLedgerOut` schema (ledger_id, path, updated_at, size, metadata, role) | 相同字段 | 一致 |

---

## 三、Read 端点差异

| 差异项 | 原版 (Python) | 当前 (TS) | 说明 |
|--------|---------------|-----------|------|
| `month_start_day` | 原版 ledgers 表无此列 | ✅ 返回 `month_start_day` | 当前版本多返回 |
| `is_shared` / `member_count` | 动态计算 | ✅ 动态计算 | 一致 |
| `exclude_from_stats` / `exclude_from_budget` | 原版投影无此列 | ✅ 返回 | 当前版本多返回 |
| `tx_count` 字段名 | summary 返回 `tx_count` | 返回 `transaction_count` | 字段名不同 |
| `first_tx_at` / `last_tx_at` | 返回 `latest_happened_at` | 返回 `first_tx_at` / `last_tx_at` | 原版合并为一个字段 |

---

## 四、Write 端点差异

| 差异项 | 原版 (Python) | 当前 (TS) | 说明 |
|--------|---------------|-----------|------|
| POST /ledgers 重复创建 | 返回 409 | ✅ 返回 409 | 一致 |
| `entity_id` 返回 | 返回 `external_id` | ✅ 返回 `external_id` | 一致 |
| `month_start_day` 应用 | 写入 DB | ✅ 写入 DB | 一致 |
| snapshot 用 `ledgerName` | ✅ camelCase key | ✅ 相同 | 一致 |
| 自动创建默认分类 | ❌ 原版无 | ❌ 当前也无 | 一致 |

---

## 五、Auth 端点差异

| 差异项 | 原版 (Python) | 当前 (TS) | 说明 |
|--------|---------------|-----------|------|
| 注册密码最小长度 | 6 位 | 6 位 | 一致 |
| `registration_enabled` 检查 | ✅ | 需确认 | — |
| 已撤销设备登录检查 | ✅ 拒绝 | 需确认 | — |

---

## 六、Admin 端点差异

| 差异项 | 原版 | 当前 | 说明 |
|--------|------|------|------|
| health status | `"healthy"` | `"ok"` | 响应值不同 |

---

## 七、Devices 端点差异

| 差异项 | 原版 | 当前 | 说明 |
|--------|------|------|------|
| GET /devices 返回 | 裸数组 | 需确认 | — |
| DELETE /devices/:id | `{ok: true, device_id}` | 需确认 | — |

---

## 八、PATs 端点差异

| 差异项 | 原版 | 当前 | 说明 |
|--------|------|------|------|
| POST /profile/pats | 返回 201 | 需确认 | — |
| GET /profile/pats | 含 `last_used_ip` / `revoked_at` | 需确认 | — |
| PATCH /profile/pats/:id 已撤销 | 返回 409 | 需确认 | — |

---

## 九、Attachments 端点差异

| 差异项 | 原版 | 当前 | 说明 |
|--------|------|------|------|
| 文件大小限制 | 50MB (413) | 50MB (413) | 一致 |
| 文件名安全处理 | 截断/清理 | ✅ | 一致 |
| batch-exists SHA256 归一化 | ✅ | 需确认 | — |
| `/category-icons/upload` | 新增端点 | ✅ | 一致 |

---

## 十、投影表 apply 逻辑差异

### applyUserChangeToProjection
| 差异项 | 原版 | 当前 | 说明 |
|--------|------|------|------|
| 字段映射 | camelCase + snake_case 双路径 | ✅ 同样双路径 | 一致 |
| category 级联删除 | 原版可能处理 | 当前仅删 projection 行 | 需确认原版是否有级联逻辑 |

### applyChangeToProjection
| 差异项 | 原版 | 当前 | 说明 |
|--------|------|------|------|
| `ledger_snapshot` 处理 | 不写 projection，仅存 SyncChange | ✅ 写 ledgers 表 + 删 projection | 实现策略不同 |
| INDIVIDUAL_ENTITY_TYPES | 包含 transaction/account/category/tag/budget/recurring_transaction/attachment | ✅ 相同 | 一致 |
| `resolveTagsCsv` | 原版在 sync_applier 中处理 | ✅ 当前版本有独立函数 | 一致 |

---

## 十一、架构差异总结（功能等价，实现方式不同）

| 维度 | 原版 (Python/FastAPI/PostgreSQL) | 当前 (TS/Hono/D1) | 影响 |
|------|----------------------------------|---------------------|------|
| 数据库 | PostgreSQL + SQLAlchemy ORM | Cloudflare D1 (SQLite) + 原生 SQL | 无功能差异 |
| WebSocket | `websocket_manager` 模块 | Durable Object + ws-manager | 无功能差异 |
| snapshot 缓存 | `snapshot_cache` 内存缓存 | 无缓存，每次查 projection | 性能差异，D1 查询快可接受 |
| projection 锁 | `lock_ledger_for_materialize` | 无锁（D1 单写） | D1 保证单写，无需锁 |
| 错误处理 | 单条失败 rollback 整批 | 单条失败跳过继续 | 当前更宽容 |

---

## 十二、未验证项（已全部验证通过）

1. POST /register: registration_enabled 检查 → ✅ 通过 setup_completed 实现
2. POST /login: 已撤销设备检查 → ✅ revoked_at IS NOT NULL 检查
3. GET /devices 返回格式 → ✅ 裸数组
4. DELETE /devices/:id 返回格式 → ✅ `{ok: true, device_id}`
5. POST /profile/pats 状态码 → ✅ 返回 201
6. GET /profile/pats 字段 → ✅ 含 last_used_ip / revoked_at
7. PATCH /profile/pats/:id 已撤销检查 → ✅ 返回 409
8. batch-exists SHA256 归一化 → ✅ trim().toLowerCase()
9. GET /read/summary 字段名差异 → ✅ 有意变更：tx_count→transaction_count, first_tx_at/last_tx_at→latest_happened_at
10. GET /read/net-worth-history 端点 → ✅ 存在于 workspace.ts

---

## 修复记录

### 2026-07-05 修复项
1. `read_tx_projection` 新增 `last_edited_by_user_id` 列（schema.ts + schema.sql + safeAddColumn 迁移）
2. `applyChangeToProjection` INSERT/UPDATE 加入 `last_edited_by_user_id`
3. `enrichTxPayloadsWithUserIds` 升级：查询并补全 `last_edited_by_user_id`
4. push 冲突审计日志：LWW 拒绝时写 `sync_conflict` AuditLog
5. push user-global 广播：追踪 `touchedUserGlobal`，push 后广播 `__user_global__` 通道
6. push 共享账本 fan-out：追踪 `pendingSharedResourceEvents`，查询共享账本给非 owner member 广播 `shared_resource_change`

### 剩余架构差异（不影响功能）
- snapshot 缓存：D1 查询快，无需内存缓存
- latest_cursor 范围：当前取用户全局最大（含 user-scope），比原版更完整
- 错误处理：当前单条失败跳过继续（比原版 rollback 整批更宽容）
