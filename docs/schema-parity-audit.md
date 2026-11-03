# Schema 对齐审计报告（D1/SQLite vs 上游 BeeCount-Cloud 1.9.0）

生成日期：2026-11-03
审计标准：逐行移植、零差异、零风险；仅允许已声明的扩展（5 张本地独有表、本地性能索引、DB 层默认值）。
对照基准：GitHub 上游仓库 `TNT-Likely/BeeCount-Cloud` tag 1.9.0 / commit 4787fae（SQLite 实现为一等公民）。
核对工具：`scripts/check-schema-sync.mjs`（本地 `src/db/schema.ts` D1 DDL ↔ 上游 Alembic 迁移）。

## 结论

**核心表（上游 32 表）已与上游 SQLite 实现在「列集合 + NOT NULL 约束」层面零差异对齐。**

`node scripts/check-schema-sync.mjs` 输出：`✓ 结构核对通过`，上游 32 表 vs 本地 37 表，5 张扩展表正确识别，无新增列级差异。

## 本次修正的偏移（此前错误对齐引入，已消除）

| 表.列 | 此前错误 | 修正后 | 对齐的上游迁移 |
|---|---|---|---|
| `attachment_files.ledger_id` | 多加 `NOT NULL` | `TEXT`（可空） | 0006 |
| `ledgers.month_start_day` | 漏 `NOT NULL` | `INTEGER DEFAULT 1 NOT NULL` | 0014 |
| `sync_changes.scope` | 漏 `NOT NULL` | `TEXT DEFAULT 'ledger' NOT NULL` | 0010 |

## 此前误判为"本地漂移"、实际上游原本就有的项（已清出白名单）

以下项在上游 1.9.0 中均已存在，并非本仓库偏移：

- `attachment_files.attachment_kind`（迁移 0006）
- `ledgers.month_start_day`（迁移 0014）
- `personal_access_tokens.pat_name`（迁移 0009）
- `*_last_edited_by_user_id`（迁移 0012）
- `sync_changes.scope`（迁移 0010）
- `sync_changes.ledger_id` 允许为空（迁移 0010 改为 nullable，用于 `scope='user'`）

> 说明：此前 PR 合并时 AI 评审将以上列当作"本地扩展偏差"放行，属宽松误判。按本审计标准，它们根本不是偏移。

## 剩余差异（全部属于已批准扩展范畴，非意外漂移）

| 类别 | 数量 | 性质 | 建议 |
|---|---|---|---|
| 本地独有表 | 5 张 | 批准的「本地独有表」扩展 | 保留 |
| 本地性能索引 | 25 处 / 12 张表 | 批准的「本地性能索引」扩展 | 保留 |
| DB 层默认值 | ~20 列 | 批准的「DB 层默认值」扩展 | 保留 |

### 本地独有表（5 张）
`ai_image_cache`、`app_metadata`、`backup_restores`、`settings`、`system_settings`

### 本地性能索引清单（25 处 / 12 张表）
- `audit_logs`：`created_at`、`user_id`
- `backup_remotes`：`backend_type`
- `backup_runs`：`schedule_id`、`started_at`、`status`
- `backup_schedule_remotes`：`remote_id`
- `backup_schedules`：`enabled`、`user_id`
- `ledger_invites`：`code`
- `mcp_source_references`：`ledger_id`、`tx_sync_id`
- `mcp_state_records`：`kind`、`ledger_id`、`next_due_at`、`status`、`user_id`
- `mcp_write_operations`：`ledger_id`、`user_id`
- `personal_access_tokens`：`prefix`、`token_hash`、`user_id`
- `recovery_codes`：`user_id`
- `sync_changes`：复合索引 `(entity_sync_id, entity_type)`、`scope`

## 关于"可消除偏移"

已无"可有可无的意外偏移"可列。若要求字面零差异，唯一还能消除的就是上述三行扩展（表 / 索引 / 默认值），但它们是明确批准的扩展——消除它们属于退化（丢能力/性能），而非修复。
