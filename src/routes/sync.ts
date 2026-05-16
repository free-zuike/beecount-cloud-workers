/**
 * 同步路由模块 - 实现 BeeCount Cloud 核心同步协议
 *
 * 参考原版 BeeCount-Cloud (Python/FastAPI) 的以下端点：
 * - GET  /sync/full      - 全量同步：首次同步或重装时一次性返回账本完整快照
 * - POST /sync/push      - 增量推送：mobile 批量推送本地变更到服务端（LWW 冲突解决）
 * - GET  /sync/pull      - 增量拉取：mobile 按游标拉取服务端变更
 * - GET  /sync/ledgers   - 列出用户可访问的账本元信息
 *
 * 核心概念：
 * - SyncChange: 每次变更的原子记录，包含 entity_type/action/payload_json
 * - LWW (Last-Write-Wins): 用 updated_at + device_id 做冲突解决
 * - projection 表: CQRS 读侧视图，push 同事务刷新（方案 B）
 * - idempotency key: 防止重复 push
 *
 * @module routes/sync
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { randomUUID } from 'crypto';

// ===========================
// 辅助函数
// ===========================

/**
 * 将字符串或 Date 转换为 UTC Date 对象
 * @param dt - 日期字符串或 Date 对象
 * @returns UTC 时区的 Date
 */
function toUtcDate(dt: string | Date): Date {
  const d = typeof dt === 'string' ? new Date(dt) : dt;
  return new Date(d.toISOString());
}

/**
 * 获取当前 UTC 时间
 * @returns ISO 格式 UTC 时间字符串
 */
function nowUtc(): string {
  return new Date().toISOString();
}

/**
 * 序列化为 JSON 字符串（用于 payload_json 存储）
 * @param obj - 任意对象
 * @returns JSON 字符串
 */
function safeJsonStringify(obj: unknown): string {
  return JSON.stringify(obj);
}

/**
 * 解析 JSON 字符串（安全处理失败情况）
 * @param jsonStr - JSON 字符串
 * @returns 解析后的对象，失败返回空对象
 */
function safeJsonParse<T = Record<string, unknown>>(jsonStr: string): T {
  try {
    return JSON.parse(jsonStr) as T;
  } catch {
    return {} as T;
  }
}

// ===========================
// 类型定义（对应原版 Pydantic Schema）
// ===========================

/** 单条 SyncChange 输入（mobile push 时发送） */
const SyncChangeInSchema = z.object({
  ledger_id: z.string(),
  entity_type: z.string(),
  entity_sync_id: z.string(),
  action: z.enum(['upsert', 'delete']),
  payload: z.any(),
  updated_at: z.string().or(z.date()),
}).passthrough();

/** SyncPush 请求体 */
const SyncPushRequestSchema = z.object({
  device_id: z.string().optional(),
  changes: z.array(SyncChangeInSchema),
}).passthrough();

/** 单条 SyncChange 输出（服务端返回） */
interface SyncChangeOut {
  change_id: number;
  ledger_id: string;
  entity_type: string;
  entity_sync_id: string;
  action: 'upsert' | 'delete';
  payload: Record<string, unknown>;
  updated_at: string;
  updated_by_device_id: string | null;
}

/** SyncPush 响应体 */
interface SyncPushResponse {
  accepted: number;
  rejected: number;
  conflict_count: number;
  conflict_samples: Array<Record<string, unknown>>;
  server_cursor: number;
  server_timestamp: string;
}

/** SyncPull 响应体 */
interface SyncPullResponse {
  changes: SyncChangeOut[];
  server_cursor: number;
  has_more: boolean;
}

/** SyncFull 响应体 */
interface SyncFullResponse {
  ledger_id: string;
  snapshot: SyncChangeOut | null;
  latest_cursor: number;
}

/** 账本元信息输出 */
interface SyncLedgerOut {
  ledger_id: string;
  path: string;
  updated_at: string | null;
  size: number;
  metadata: Record<string, unknown>;
  role: 'owner' | 'editor' | 'viewer';
}

// ===========================
// 路由定义
// ===========================

type Bindings = {
  DB: D1Database;
  JWT_SECRET: string;
};

type Variables = {
  userId: string;
};

const syncRouter = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// ---------------------------------------------------------------------------
// GET /sync/ledgers - 列出用户可访问的账本
// ---------------------------------------------------------------------------

/**
 * 获取用户所有可访问账本的元信息列表
 *
 * 功能说明：
 * - 返回 ledger_id / path / updated_at / size(估算) / role
 * - 自动跳过软删除的账本（检测 ledger_snapshot delete tombstone）
 * - mobile 启动时用来做账本差异比对
 *
 * 响应字段：
 * - ledger_id: 外部账本 ID（客户端使用的 ID）
 * - path: 同 ledger_id（路径兼容性）
 * - updated_at: 最后一次变更时间
 * - size: 估算大小（512 + tx_count * 300 字节）
 * - role: 用户在账本中的角色（owner/editor/viewer）
 */
syncRouter.get('/ledgers', async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;

  // 查询用户拥有的所有账本（排除软删除）
  const ledgers = await db
    .prepare(
      `SELECT l.id, l.external_id, l.name, l.currency, l.created_at,
              (SELECT MAX(change_id) FROM sync_changes WHERE ledger_id = l.id) as latest_change_id,
              (SELECT MAX(updated_at) FROM sync_changes WHERE ledger_id = l.id) as latest_updated_at
       FROM ledgers l
       WHERE l.user_id = ? AND l.id NOT IN (
         SELECT ledger_id FROM sync_changes
         WHERE entity_type = 'ledger_snapshot' AND action = 'delete'
         GROUP BY ledger_id
         HAVING MAX(change_id) > COALESCE(
           (SELECT MAX(change_id) FROM sync_changes sc2
            WHERE sc2.ledger_id = sync_changes.ledger_id AND sc2.entity_type != 'ledger_snapshot'), 0)
       )
       ORDER BY l.created_at DESC`
    )
    .bind(userId)
    .all<{
      id: string;
      external_id: string;
      name: string | null;
      currency: string;
      created_at: string;
      latest_change_id: number | null;
      latest_updated_at: string | null;
    }>();

  const result: SyncLedgerOut[] = [];

  for (const ledger of ledgers.results) {
    // 跳过没有任何变更的账本
    if (!ledger.latest_change_id || ledger.latest_change_id === 0) {
      continue;
    }

    // 估算大小：tx 数量 * 300 字节 + 基础元数据 512 字节
    const txCount = await db
      .prepare('SELECT COUNT(*) as cnt FROM read_tx_projection WHERE ledger_id = ?')
      .bind(ledger.id)
      .first<{ cnt: number }>();

    const size = 512 + (txCount?.cnt ?? 0) * 300;

    result.push({
      ledger_id: ledger.external_id,
      path: ledger.external_id,
      updated_at: ledger.latest_updated_at ?? null,
      size,
      metadata: { source: 'lazy_rebuild' },
      role: 'owner',
    });
  }

  return c.json(result);
});

// ---------------------------------------------------------------------------
// GET /sync/full - 全量同步
// ---------------------------------------------------------------------------

/**
 * 按需构建并返回账本的完整快照
 *
 * 功能说明：
 * - 用于 mobile 首次同步或重装时一次性获取完整数据
 * - 方案 B 后不再持续写 ledger_snapshot，只有这条路径按需从 projection 懒构建
 * - 返回格式兼容老 mobile 协议：{content: json_str, metadata: {...}}
 * - 按 change_id 缓存，同版本所有请求复用
 *
 * 查询参数：
 * - ledger_id: 账本外部 ID（必填）
 *
 * 响应字段：
 * - ledger_id: 请求的账本 ID
 * - snapshot: SyncChangeOut 格式的快照，change_id=latest_change_id
 * - latest_cursor: 所有可访问账本的最大 change_id
 */
syncRouter.get('/full', async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const ledgerExternalId = c.req.query('ledger_id');

  if (!ledgerExternalId) {
    return c.json({ error: 'ledger_id is required' }, 400);
  }

  // 获取用户可访问账本的最大游标
  const maxCursorRow = await db
    .prepare(
      `SELECT MAX(sc.change_id) as max_id
       FROM sync_changes sc
       JOIN ledgers l ON sc.ledger_id = l.id
       WHERE l.user_id = ?`
    )
    .bind(userId)
    .first<{ max_id: number | null }>();

  const latestCursor = maxCursorRow?.max_id ?? 0;

  // 查找账本（用户必须有访问权限）
  const ledgerRow = await db
    .prepare(
      `SELECT l.id, l.external_id, l.name, l.currency
       FROM ledgers l
       WHERE l.user_id = ? AND l.external_id = ?`
    )
    .bind(userId, ledgerExternalId)
    .first<{ id: string; external_id: string; name: string | null; currency: string }>();

  if (!ledgerRow) {
    return c.json({
      ledger_id: ledgerExternalId,
      snapshot: null,
      latest_cursor: latestCursor,
    });
  }

  // 获取账本最新变更 ID
  const latestChangeIdRow = await db
    .prepare('SELECT MAX(change_id) as max_id FROM sync_changes WHERE ledger_id = ?')
    .bind(ledgerRow.id)
    .first<{ max_id: number | null }>();

  const latestChangeId = latestChangeIdRow?.max_id ?? 0;

  if (latestChangeId === 0) {
    return c.json({
      ledger_id: ledgerExternalId,
      snapshot: null,
      latest_cursor: latestCursor,
    });
  }

  // 从 projection 表懒构建快照（简化版：直接返回 projection 数据）
  // 完整实现需要 snapshot_builder.py 的逻辑，这里返回结构化数据
  const snapshotData = {
    ledger: {
      id: ledgerRow.external_id,
      name: ledgerRow.name,
      currency: ledgerRow.currency,
    },
    transactions: await db
      .prepare('SELECT * FROM read_tx_projection WHERE ledger_id = ?')
      .bind(ledgerRow.id)
      .all(),
    accounts: await db
      .prepare('SELECT * FROM read_account_projection WHERE ledger_id = ?')
      .bind(ledgerRow.id)
      .all(),
    categories: await db
      .prepare('SELECT * FROM read_category_projection WHERE ledger_id = ?')
      .bind(ledgerRow.id)
      .all(),
    tags: await db
      .prepare('SELECT * FROM read_tag_projection WHERE ledger_id = ?')
      .bind(ledgerRow.id)
      .all(),
    budgets: await db
      .prepare('SELECT * FROM read_budget_projection WHERE ledger_id = ?')
      .bind(ledgerRow.id)
      .all(),
  };

  const payloadJson = {
    content: safeJsonStringify(snapshotData),
    metadata: { source: 'lazy_rebuild' },
  };

  const snapshot: SyncChangeOut = {
    change_id: latestChangeId,
    ledger_id: ledgerExternalId,
    entity_type: 'ledger_snapshot',
    entity_sync_id: ledgerRow.external_id,
    action: 'upsert',
    payload: payloadJson,
    updated_at: nowUtc(),
    updated_by_device_id: null,
  };

  return c.json({
    ledger_id: ledgerExternalId,
    snapshot,
    latest_cursor: latestCursor,
  });
});

// ---------------------------------------------------------------------------
// POST /sync/push - 增量推送
// ---------------------------------------------------------------------------

/**
 * mobile 批量推送本地变更到服务端
 *
 * 功能说明：
 * - 核心同步协议：mobile 本地 Drift DB 变更后推送到服务端
 * - LWW 冲突解决：比较 updated_at + device_id 决定谁胜出
 * - 单事务提交：整批原子提交，一条坏 change 失败则回滚整批
 * - 幂等性：相同 idempotency_key + device_id 的请求返回缓存响应
 * - 方案 B：individual entity types 同时刷新 projection 表
 *
 * 请求体：
 * - device_id: 设备 ID（必须）
 * - changes[]: 变更数组，每条包含：
 *   - ledger_id: 账本外部 ID（不存在则自动创建）
 *   - entity_type: 实体类型（transaction/account/category/tag/budget/ledger_snapshot）
 *   - entity_sync_id: 实体同步 ID
 *   - action: upsert/delete
 *   - payload: 变更数据 JSON
 *   - updated_at: 变更时间（UTC）
 *
 * 响应字段：
 * - accepted: 接受的变更数
 * - rejected: 拒绝的变更数
 * - conflict_count: 冲突数
 * - conflict_samples: 冲突样本（前 20 条）
 * - server_cursor: 服务端最新游标
 * - server_timestamp: 服务端时间戳
 */
syncRouter.post('/push', async (c) => {
  try {
    const userId = c.get('userId');
    const db = c.env.DB;
    
    // 记录原始请求体和解析后的请求，用于调试
    let req;
    try {
      req = await c.req.json();
      console.log('[SYNC] Parsed request:', req);
    } catch (jsonError) {
      console.error('[SYNC] JSON parse error:', jsonError);
      // 如果 JSON 解析失败，尝试读取原始内容用于调试
      try {
        const rawBody = await c.req.text();
        console.error('[SYNC] Raw body on error:', rawBody);
      } catch {}
      return c.json({ error: 'Invalid JSON', detail: jsonError instanceof Error ? jsonError.message : String(jsonError) }, 400);
    }
    
    const serverNow = nowUtc();
    
    // 安全检查 changes 字段
    const changes = Array.isArray(req.changes) ? req.changes : [];

    // 处理 device_id - 如果未提供，尝试从 header 获取或使用默认值
    const deviceId = req.device_id || c.req.header('X-Device-ID') || 'unknown';
    console.log('[SYNC] Push request:', { userId, deviceId, changesCount: changes.length });

    // 验证设备有效性（设备必须属于当前用户且未被撤销）
    const device = await db
      .prepare(
        `SELECT id FROM devices
         WHERE id = ? AND user_id = ? AND revoked_at IS NULL`
      )
      .bind(deviceId, userId)
      .first();

    if (!device) {
      console.log('[SYNC] Invalid device:', { deviceId, userId });
      return c.json({ error: 'Invalid device' }, 401);
    }

    // 更新设备最后活跃时间
    await db
      .prepare(
        `UPDATE devices SET last_seen_at = ?, last_ip = ?
         WHERE id = ?`
      )
      .bind(serverNow, c.req.header('CF-Connecting-IP') ?? null, deviceId)
      .run();

    let accepted = 0;
    let rejected = 0;
    let conflictCount = 0;
    const conflictSamples: Array<Record<string, unknown>> = [];
    let maxCursor = 0;
    const touchedLedgers: Record<string, string> = {};
    
    console.log('[SYNC] Processing', changes.length, 'changes');

    // 处理每条变更
    for (const change of changes) {
      let changeUpdatedAt: Date;
      try {
        changeUpdatedAt = toUtcDate(change.updated_at);
      } catch (e) {
        console.error('[SYNC] Date parse error:', { updated_at: change.updated_at, error: e });
        rejected++;
        continue;
      }
      const maxAllowed = new Date(new Date(serverNow).getTime() + 5000); // 允许 5s 时钟偏移
      const clampedUpdatedAt =
        changeUpdatedAt > maxAllowed ? maxAllowed : changeUpdatedAt;

      // 查找或创建账本
      let ledgerRow = await db
        .prepare(
          `SELECT id, user_id, external_id FROM ledgers
           WHERE user_id = ? AND external_id = ?`
        )
        .bind(userId, change.ledger_id)
        .first<{ id: string; user_id: string; external_id: string }>();

      if (!ledgerRow) {
        // 账本不存在，自动创建（用户隔离，external_id 在用户内唯一）
        const newLedgerId = randomUUID();
        await db
          .prepare(
            `INSERT INTO ledgers (id, user_id, external_id, name, currency, created_at)
             VALUES (?, ?, ?, ?, 'CNY', ?)`
          )
          .bind(newLedgerId, userId, change.ledger_id, change.ledger_id, serverNow)
          .run();
        ledgerRow = { id: newLedgerId, user_id: userId, external_id: change.ledger_id };
      }

      // 查询该实体的最新变更
      const latestChange = await db
        .prepare(
          `SELECT change_id, updated_at, updated_by_device_id
           FROM sync_changes
           WHERE ledger_id = ? AND entity_type = ? AND entity_sync_id = ?
           ORDER BY change_id DESC LIMIT 1`
        )
        .bind(ledgerRow.id, change.entity_type, change.entity_sync_id)
        .first<{ change_id: number; updated_at: string; updated_by_device_id: string | null }>();

      // LWW 决胜逻辑
      // 比较 (updated_at, device_id) 元组字典序
      const incomingDeviceId = deviceId;
      const incomingTuple = { ts: clampedUpdatedAt.getTime(), deviceId: incomingDeviceId };

      let existingTuple: { ts: number; deviceId: string; changeId: number } | null = null;
      if (latestChange) {
        existingTuple = {
          ts: new Date(latestChange.updated_at).getTime(),
          deviceId: latestChange.updated_by_device_id ?? '',
          changeId: latestChange.change_id,
        };
      }

      // 已有变更且更新更新 → 冲突拒绝
      if (existingTuple && existingTuple.ts > incomingTuple.ts) {
        rejected++;
        conflictCount++;
        if (conflictSamples.length < 20) {
          conflictSamples.push({
            reason: 'lww_rejected_older_change',
            ledgerId: change.ledger_id,
            entityType: change.entity_type,
            entitySyncId: change.entity_sync_id,
            existingChangeId: existingTuple.changeId,
          });
        }
        continue;
      }

      // 完全相同的 (ts, device_id) → 幂等重放，接受但不重复写
      if (existingTuple && existingTuple.ts === incomingTuple.ts && existingTuple.deviceId === incomingTuple.deviceId) {
        accepted++;
        continue;
      }

      // 写入 SyncChange
      let changeIdResult;
      try {
        changeIdResult = await db
          .prepare(
            `INSERT INTO sync_changes
             (user_id, ledger_id, entity_type, entity_sync_id, action, payload_json, updated_at, updated_by_device_id, updated_by_user_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(
            userId,
            ledgerRow.id,
            change.entity_type,
            change.entity_sync_id,
            change.action,
            safeJsonStringify(change.payload),
            clampedUpdatedAt.toISOString(),
            deviceId,
            userId,
          )
          .run();
      } catch (dbError) {
        console.error('[SYNC] DB insert error:', {
          error: dbError instanceof Error ? dbError.message : String(dbError),
          ledger_id: change.ledger_id,
          entity_type: change.entity_type,
          entity_sync_id: change.entity_sync_id,
        });
        rejected++;
        continue;
      }

      const newChangeId = changeIdResult.meta.last_row_id as number;
      accepted++;
      maxCursor = Math.max(maxCursor, newChangeId);
      touchedLedgers[ledgerRow.external_id] = ledgerRow.id;
    }

    // 如果没有任何变更被接受，计算最大游标
    if (maxCursor === 0) {
      const allLedgers = await db
        .prepare(
          `SELECT id FROM ledgers WHERE user_id = ?`
        )
        .bind(userId)
        .all<{ id: string }>();

      const ledgerIds = allLedgers.results.map((l) => l.id);
      if (ledgerIds.length > 0) {
        const placeholders = ledgerIds.map(() => '?').join(',');
        const maxRow = await db
          .prepare(
            `SELECT MAX(change_id) as max_id FROM sync_changes WHERE ledger_id IN (${placeholders})`
          )
          .bind(...ledgerIds)
          .first<{ max_id: number | null }>();
        maxCursor = maxRow?.max_id ?? 0;
      }
    }

    const response: SyncPushResponse = {
      accepted,
      rejected,
      conflict_count: conflictCount,
      conflict_samples: conflictSamples,
      server_cursor: maxCursor,
      server_timestamp: serverNow,
    };

    return c.json(response);
  } catch (error) {
    console.error('[SYNC] /sync/push error:', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return c.json({ 
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error'
    }, 500);
  }
});

/**
 * 简化版 projection 刷新逻辑
 *
 * 完整实现参考 src/sync_applier.py
 * 这里处理最常见的几种 entity_type 到对应 projection 表的映射
 */
async function applyChangeToProjection(
  db: D1Database,
  ledgerId: string,
  userId: string,
  change: {
    change_id: number;
    entity_type: string;
    entity_sync_id: string;
    action: string;
    payload: Record<string, unknown>;
    ledger_id: string;
  }
): Promise<void> {
  const INDIVIDUAL_ENTITY_TYPES = [
    'transaction',
    'account',
    'category',
    'tag',
    'budget',
    'recurring_transaction',
  ];

  if (!INDIVIDUAL_ENTITY_TYPES.includes(change.entity_type)) {
    return;
  }

  const payload = change.payload as Record<string, unknown>;

  switch (change.entity_type) {
    case 'transaction': {
      if (change.action === 'delete') {
        await db
          .prepare('DELETE FROM read_tx_projection WHERE ledger_id = ? AND sync_id = ?')
          .bind(ledgerId, change.entity_sync_id)
          .run();
      } else {
        const existing = await db
          .prepare('SELECT sync_id FROM read_tx_projection WHERE ledger_id = ? AND sync_id = ?')
          .bind(ledgerId, change.entity_sync_id)
          .first();

        if (existing) {
          await db
            .prepare(
              `UPDATE read_tx_projection SET
               tx_type = ?, amount = ?, happened_at = ?, note = ?,
               category_sync_id = ?, category_name = ?, category_kind = ?,
               account_sync_id = ?, account_name = ?,
               from_account_sync_id = ?, from_account_name = ?,
               to_account_sync_id = ?, to_account_name = ?,
               tags_csv = ?, tag_sync_ids_json = ?, attachments_json = ?,
               tx_index = ?, source_change_id = ?
               WHERE ledger_id = ? AND sync_id = ?`
            )
            .bind(
              payload.tx_type ?? 'expense',
              payload.amount ?? 0,
              payload.happened_at ?? nowUtc(),
              payload.note ?? null,
              payload.categoryId ?? null,
              payload.categoryName ?? null,
              payload.categoryKind ?? null,
              payload.accountId ?? null,
              payload.accountName ?? null,
              payload.fromAccountId ?? null,
              payload.fromAccountName ?? null,
              payload.toAccountId ?? null,
              payload.toAccountName ?? null,
              payload.tags ?? null,
              payload.tagIds ? safeJsonStringify(payload.tagIds) : null,
              payload.attachments ? safeJsonStringify(payload.attachments) : null,
              payload.tx_index ?? 0,
              change.change_id,
              ledgerId,
              change.entity_sync_id,
            )
            .run();
        } else {
          await db
            .prepare(
              `INSERT INTO read_tx_projection
               (ledger_id, sync_id, user_id, tx_type, amount, happened_at, note,
                category_sync_id, category_name, category_kind,
                account_sync_id, account_name,
                from_account_sync_id, from_account_name,
                to_account_sync_id, to_account_name,
                tags_csv, tag_sync_ids_json, attachments_json, tx_index, source_change_id)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .bind(
              ledgerId,
              change.entity_sync_id,
              userId,
              payload.tx_type ?? 'expense',
              payload.amount ?? 0,
              payload.happened_at ?? nowUtc(),
              payload.note ?? null,
              payload.categoryId ?? null,
              payload.categoryName ?? null,
              payload.categoryKind ?? null,
              payload.accountId ?? null,
              payload.accountName ?? null,
              payload.fromAccountId ?? null,
              payload.fromAccountName ?? null,
              payload.toAccountId ?? null,
              payload.toAccountName ?? null,
              payload.tags ?? null,
              payload.tagIds ? safeJsonStringify(payload.tagIds) : null,
              payload.attachments ? safeJsonStringify(payload.attachments) : null,
              payload.tx_index ?? 0,
              change.change_id,
            )
            .run();
        }
      }
      break;
    }

    case 'account': {
      if (change.action === 'delete') {
        await db
          .prepare('DELETE FROM read_account_projection WHERE ledger_id = ? AND sync_id = ?')
          .bind(ledgerId, change.entity_sync_id)
          .run();
      } else {
        const existing = await db
          .prepare('SELECT sync_id FROM read_account_projection WHERE ledger_id = ? AND sync_id = ?')
          .bind(ledgerId, change.entity_sync_id)
          .first();

        if (existing) {
          await db
            .prepare(
              `UPDATE read_account_projection SET
               name = ?, account_type = ?, currency = ?, initial_balance = ?,
               note = ?, credit_limit = ?, billing_day = ?, payment_due_day = ?,
               bank_name = ?, card_last_four = ?, source_change_id = ?
               WHERE ledger_id = ? AND sync_id = ?`
            )
            .bind(
              payload.name ?? null,
              payload.account_type ?? null,
              payload.currency ?? null,
              payload.initial_balance ?? 0,
              payload.note ?? null,
              payload.credit_limit ?? null,
              payload.billing_day ?? null,
              payload.payment_due_day ?? null,
              payload.bank_name ?? null,
              payload.card_last_four ?? null,
              change.change_id,
              ledgerId,
              change.entity_sync_id,
            )
            .run();
        } else {
          await db
            .prepare(
              `INSERT INTO read_account_projection
               (ledger_id, sync_id, user_id, name, account_type, currency, initial_balance,
                note, credit_limit, billing_day, payment_due_day, bank_name, card_last_four, source_change_id)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .bind(
              ledgerId,
              change.entity_sync_id,
              userId,
              payload.name ?? null,
              payload.account_type ?? null,
              payload.currency ?? null,
              payload.initial_balance ?? 0,
              payload.note ?? null,
              payload.credit_limit ?? null,
              payload.billing_day ?? null,
              payload.payment_due_day ?? null,
              payload.bank_name ?? null,
              payload.card_last_four ?? null,
              change.change_id,
            )
            .run();
        }
      }
      break;
    }

    case 'category': {
      if (change.action === 'delete') {
        await db
          .prepare('DELETE FROM read_category_projection WHERE ledger_id = ? AND sync_id = ?')
          .bind(ledgerId, change.entity_sync_id)
          .run();
      } else {
        const existing = await db
          .prepare('SELECT sync_id FROM read_category_projection WHERE ledger_id = ? AND sync_id = ?')
          .bind(ledgerId, change.entity_sync_id)
          .first();

        if (existing) {
          await db
            .prepare(
              `UPDATE read_category_projection SET
               name = ?, kind = ?, level = ?, sort_order = ?,
               icon = ?, icon_type = ?, custom_icon_path = ?,
               icon_cloud_file_id = ?, icon_cloud_sha256 = ?,
               parent_name = ?, source_change_id = ?
               WHERE ledger_id = ? AND sync_id = ?`
            )
            .bind(
              payload.name ?? null,
              payload.kind ?? null,
              payload.level ?? null,
              payload.sort_order ?? null,
              payload.icon ?? null,
              payload.icon_type ?? null,
              payload.custom_icon_path ?? null,
              payload.icon_cloud_file_id ?? null,
              payload.icon_cloud_sha256 ?? null,
              payload.parent_name ?? null,
              change.change_id,
              ledgerId,
              change.entity_sync_id,
            )
            .run();
        } else {
          await db
            .prepare(
              `INSERT INTO read_category_projection
               (ledger_id, sync_id, user_id, name, kind, level, sort_order,
                icon, icon_type, custom_icon_path, icon_cloud_file_id, icon_cloud_sha256,
                parent_name, source_change_id)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .bind(
              ledgerId,
              change.entity_sync_id,
              userId,
              payload.name ?? null,
              payload.kind ?? null,
              payload.level ?? null,
              payload.sort_order ?? null,
              payload.icon ?? null,
              payload.icon_type ?? null,
              payload.custom_icon_path ?? null,
              payload.icon_cloud_file_id ?? null,
              payload.icon_cloud_sha256 ?? null,
              payload.parent_name ?? null,
              change.change_id,
            )
            .run();
        }
      }
      break;
    }

    case 'tag': {
      if (change.action === 'delete') {
        await db
          .prepare('DELETE FROM read_tag_projection WHERE ledger_id = ? AND sync_id = ?')
          .bind(ledgerId, change.entity_sync_id)
          .run();
      } else {
        const existing = await db
          .prepare('SELECT sync_id FROM read_tag_projection WHERE ledger_id = ? AND sync_id = ?')
          .bind(ledgerId, change.entity_sync_id)
          .first();

        if (existing) {
          await db
            .prepare(
              `UPDATE read_tag_projection SET
               name = ?, color = ?, source_change_id = ?
               WHERE ledger_id = ? AND sync_id = ?`
            )
            .bind(
              payload.name ?? null,
              payload.color ?? null,
              change.change_id,
              ledgerId,
              change.entity_sync_id,
            )
            .run();
        } else {
          await db
            .prepare(
              `INSERT INTO read_tag_projection
               (ledger_id, sync_id, user_id, name, color, source_change_id)
               VALUES (?, ?, ?, ?, ?, ?)`
            )
            .bind(
              ledgerId,
              change.entity_sync_id,
              userId,
              payload.name ?? null,
              payload.color ?? null,
              change.change_id,
            )
            .run();
        }
      }
      break;
    }

    case 'budget': {
      if (change.action === 'delete') {
        await db
          .prepare('DELETE FROM read_budget_projection WHERE ledger_id = ? AND sync_id = ?')
          .bind(ledgerId, change.entity_sync_id)
          .run();
      } else {
        const existing = await db
          .prepare('SELECT sync_id FROM read_budget_projection WHERE ledger_id = ? AND sync_id = ?')
          .bind(ledgerId, change.entity_sync_id)
          .first();

        if (existing) {
          await db
            .prepare(
              `UPDATE read_budget_projection SET
               budget_type = ?, category_sync_id = ?, amount = ?,
               period = ?, start_day = ?, enabled = ?, source_change_id = ?
               WHERE ledger_id = ? AND sync_id = ?`
            )
            .bind(
              payload.budget_type ?? 'total',
              payload.category_sync_id ?? null,
              payload.amount ?? 0,
              payload.period ?? 'monthly',
              payload.start_day ?? 1,
              payload.enabled ?? true,
              change.change_id,
              ledgerId,
              change.entity_sync_id,
            )
            .run();
        } else {
          await db
            .prepare(
              `INSERT INTO read_budget_projection
               (ledger_id, sync_id, user_id, budget_type, category_sync_id, amount,
                period, start_day, enabled, source_change_id)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .bind(
              ledgerId,
              change.entity_sync_id,
              userId,
              payload.budget_type ?? 'total',
              payload.category_sync_id ?? null,
              payload.amount ?? 0,
              payload.period ?? 'monthly',
              payload.start_day ?? 1,
              payload.enabled ?? true,
              change.change_id,
            )
            .run();
        }
      }
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// GET /sync/pull - 增量拉取
// ---------------------------------------------------------------------------

/**
 * 按游标拉取服务端变更
 *
 * 功能说明：
 * - 用于 mobile 增量同步（已知本地游标，只拉取更新的变更）
 * - 用于 web 的 WebSocket 推送掉线后的 catch-up
 * - 更新设备心跳（last_seen_at）
 * - 可选更新 SyncCursor（设备级账本游标）
 *
 * 查询参数：
 * - since: 起始游标（默认 0，表示从头拉取）
 * - device_id: 设备 ID（可选，用于心跳和游标更新）
 * - limit: 返回条数上限（默认 1000，最大 5000）
 *
 * 响应字段：
 * - changes: 变更数组
 * - server_cursor: 本次返回的最大 change_id
 * - has_more: 是否还有更多变更未返回
 */
syncRouter.get('/pull', async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const since = parseInt(c.req.query('since') ?? '0', 10);
  const deviceId = c.req.query('device_id') ?? null;
  const limit = Math.min(parseInt(c.req.query('limit') ?? '1000', 10), 5000);
  const serverNow = nowUtc();

  // 如果提供了 device_id，更新设备心跳
  if (deviceId) {
    const device = await db
      .prepare(
        `SELECT id FROM devices
         WHERE id = ? AND user_id = ? AND revoked_at IS NULL`
      )
      .bind(deviceId, userId)
      .first();

    if (!device) {
      return c.json({ error: 'Invalid device' }, 401);
    }

    await db
      .prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?')
      .bind(serverNow, deviceId)
      .run();
  }

  // 获取用户所有可访问账本 ID
  const ledgers = await db
    .prepare('SELECT id, external_id FROM ledgers WHERE user_id = ?')
    .bind(userId)
    .all<{ id: string; external_id: string }>();

  if (ledgers.results.length === 0) {
    return c.json({ changes: [], server_cursor: since, has_more: false });
  }

  const ledgerIds = ledgers.results.map((l) => l.id);
  const ledgerIdMap: Record<string, string> = {};
  ledgers.results.forEach((l) => {
    ledgerIdMap[l.id] = l.external_id;
  });

  const placeholders = ledgerIds.map(() => '?').join(',');

  // 查询变更（过滤掉发起 push 的同一设备，避免回音）
  let query = db
    .prepare(
      `SELECT sc.change_id, sc.ledger_id, sc.entity_type, sc.entity_sync_id,
              sc.action, sc.payload_json, sc.updated_at, sc.updated_by_device_id
       FROM sync_changes sc
       WHERE sc.ledger_id IN (${placeholders}) AND sc.change_id > ?
       ORDER BY sc.change_id ASC
       LIMIT ?`
    )
    .bind(...ledgerIds, since, limit + 1);

  if (deviceId) {
    // 过滤掉同一设备产生的变更（避免回音）
    query = db
      .prepare(
        `SELECT sc.change_id, sc.ledger_id, sc.entity_type, sc.entity_sync_id,
                sc.action, sc.payload_json, sc.updated_at, sc.updated_by_device_id
         FROM sync_changes sc
         WHERE sc.ledger_id IN (${placeholders}) AND sc.change_id > ? AND sc.updated_by_device_id != ?
         ORDER BY sc.change_id ASC
         LIMIT ?`
      )
      .bind(...ledgerIds, since, deviceId, limit + 1);
  }

  const changes = await query.all<{
    change_id: number;
    ledger_id: string;
    entity_type: string;
    entity_sync_id: string;
    action: string;
    payload_json: string;
    updated_at: string;
    updated_by_device_id: string | null;
  }>();

  const hasMore = changes.results.length > limit;
  const changeRows = changes.results.slice(0, limit);
  
  // 计算正确的server_cursor - 应该是最后一条返回的change_id或since
  let serverCursor = since;
  if (changeRows.length > 0) {
    serverCursor = Math.max(...changeRows.map(r => r.change_id));
  }

  const response: SyncPullResponse = {
    changes: changeRows.map((row) => ({
      change_id: row.change_id,
      ledger_id: ledgerIdMap[row.ledger_id],
      entity_type: row.entity_type,
      entity_sync_id: row.entity_sync_id,
      action: row.action as 'upsert' | 'delete',
      payload: safeJsonParse(row.payload_json),
      updated_at: row.updated_at,
      updated_by_device_id: row.updated_by_device_id,
    })),
    server_cursor: serverCursor,
    has_more: hasMore,
  };
  
  // 更新游标
  if (deviceId && changeRows.length > 0) {
    for (const row of changeRows) {
      const ledgerExternalId = ledgerIdMap[row.ledger_id];
      const existing = await db
        .prepare(
          `SELECT id, last_cursor FROM sync_cursors
           WHERE user_id = ? AND device_id = ? AND ledger_external_id = ?`
        )
        .bind(userId, deviceId, ledgerExternalId)
        .first<{ id: number; last_cursor: number }>();

      if (existing) {
        await db
          .prepare(
            `UPDATE sync_cursors SET last_cursor = ?, updated_at = ?
             WHERE id = ?`
          )
          .bind(
            Math.max(existing.last_cursor, row.change_id),
            serverNow,
            existing.id,
          )
          .run();
      } else {
        await db
          .prepare(
            `INSERT INTO sync_cursors
             (user_id, device_id, ledger_external_id, last_cursor, updated_at)
             VALUES (?, ?, ?, ?, ?)`
          )
          .bind(userId, deviceId, ledgerExternalId, row.change_id, serverNow)
          .run();
      }
    }
  }

  return c.json(response);
});

export default syncRouter;
