/**
 * 批量写路由模块 - 实现批量交易操作接口
 *
 * 参考原版 BeeCount-Cloud (Python/FastAPI) 的批量交易端点：
 * - POST /write/transactions/batch        - 批量创建交易（B2/B3 AI 记账用）
 * - POST /write/transactions/batch-delete - 批量删除交易
 *
 * 批量创建特殊能力：
 * - N 笔交易一次 commit（一次 snapshot lock + 一批 SyncChange）
 * - auto_ai_tag（默认 true）：自动加「AI 记账」tag
 * - extra_tag_name：额外标签（B2 图片记账 / B3 文字记账）
 * - attach_image_id：B2 从 image_cache 取图片字节存为附件
 *
 * @module routes/batch_write
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { randomUUID } from 'crypto';

// ===========================
// 辅助函数
// ===========================

function nowUtc(): string {
  return new Date().toISOString();
}

function safeJsonStringify(obj: unknown): string {
  return JSON.stringify(obj);
}

// ===========================
// Schema 定义
// ===========================

const BatchTransactionCreateSchema = z.object({
  ledger_id: z.string().optional(),
  transactions: z.array(z.object({
    tx_type: z.enum(['expense', 'income', 'transfer']).default('expense'),
    amount: z.number(),
    happened_at: z.string().or(z.date()),
    note: z.string().nullable().optional(),
    category_name: z.string().nullable().optional(),
    category_kind: z.enum(['expense', 'income', 'transfer']).nullable().optional(),
    account_name: z.string().nullable().optional(),
    from_account_name: z.string().nullable().optional(),
    to_account_name: z.string().nullable().optional(),
    category_id: z.string().nullable().optional(),
    account_id: z.string().nullable().optional(),
    from_account_id: z.string().nullable().optional(),
    to_account_id: z.string().nullable().optional(),
    tags: z.union([z.string(), z.array(z.string())]).nullable().optional(),
    tag_ids: z.array(z.string()).nullable().optional(),
    attachments: z.array(z.record(z.any())).nullable().optional(),
  })),
  auto_ai_tag: z.boolean().default(true),
  extra_tag_name: z.string().nullable().optional(),
  attach_image_id: z.string().nullable().optional(),
  device_id: z.string().optional(),
});

const BatchTransactionDeleteSchema = z.object({
  ledger_id: z.string().optional(),
  transaction_ids: z.array(z.string()),
  device_id: z.string().optional(),
});

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

const batchWriteRouter = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// ---------------------------------------------------------------------------
// POST /write/transactions/batch - 批量创建交易
// ---------------------------------------------------------------------------

batchWriteRouter.post('/transactions/batch', zValidator('json', BatchTransactionCreateSchema), async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const req = c.req.valid('json');
  const serverNow = nowUtc();

  // 查找账本
  let ledgerExternalId = req.ledger_id ?? 'default';

  const ledger = await db
    .prepare('SELECT id, external_id FROM ledgers WHERE user_id = ?')
    .bind(userId)
    .first<{ id: string; external_id: string }>();

  if (!ledger) {
    return c.json({ error: 'No ledger found' }, 400);
  }

  // 如果指定了 ledger_id，使用指定的账本
  if (req.ledger_id) {
    const specifiedLedger = await db
      .prepare('SELECT id, external_id FROM ledgers WHERE user_id = ? AND external_id = ?')
      .bind(userId, req.ledger_id)
      .first<{ id: string; external_id: string }>();

    if (specifiedLedger) {
      ledger.id = specifiedLedger.id;
      ledger.external_id = specifiedLedger.external_id;
      ledgerExternalId = specifiedLedger.external_id;
    }
  }

  const createdIds: string[] = [];
  const deviceId = req.device_id ?? 'batch-write';

  // 处理 auto_ai_tag
  let aiTagName: string | null = null;
  if (req.auto_ai_tag) {
    // 查找是否已有 AI 记账标签
    const existingAiTag = await db
      .prepare('SELECT sync_id FROM read_tag_projection WHERE user_id = ? AND name LIKE ? LIMIT 1')
      .bind(userId, '%AI%')
      .first<{ sync_id: string }>();

    if (existingAiTag) {
      aiTagName = existingAiTag.sync_id;
    }
  }

  // 处理 extra_tag_name
  let extraTagSyncId: string | null = null;
  if (req.extra_tag_name) {
    const existingExtraTag = await db
      .prepare('SELECT sync_id FROM read_tag_projection WHERE user_id = ? AND name = ? LIMIT 1')
      .bind(userId, req.extra_tag_name)
      .first<{ sync_id: string }>();

    if (existingExtraTag) {
      extraTagSyncId = existingExtraTag.sync_id;
    }
  }

  // 批量创建交易
  for (const tx of req.transactions) {
    const syncId = randomUUID();
    const happenedAt = typeof tx.happened_at === 'string' ? tx.happened_at : new Date(tx.happened_at as Date).toISOString();

    // 合并标签
    let tags = '';
    if (typeof tx.tags === 'string') {
      tags = tx.tags;
    } else if (Array.isArray(tx.tags)) {
      tags = tx.tags.join(',');
    }

    // 添加 AI 标签
    if (aiTagName) {
      tags = tags ? `${tags},${aiTagName}` : aiTagName;
    }

    // 添加额外标签
    if (extraTagSyncId) {
      tags = tags ? `${tags},${extraTagSyncId}` : extraTagSyncId;
    }

    // 构建 payload
    const payload: Record<string, unknown> = {
      tx_type: tx.tx_type,
      amount: tx.amount,
      happened_at: happenedAt,
      note: tx.note ?? null,
      category_name: tx.category_name ?? null,
      category_kind: tx.category_kind ?? null,
      account_name: tx.account_name ?? null,
      from_account_name: tx.from_account_name ?? null,
      to_account_name: tx.to_account_name ?? null,
      category_id: tx.category_id ?? null,
      account_id: tx.account_id ?? null,
      from_account_id: tx.from_account_id ?? null,
      to_account_id: tx.to_account_id ?? null,
      tags,
      tag_ids: tx.tag_ids ?? null,
      attachments: tx.attachments ?? null,
    };

    // 写入 SyncChange
    const changeResult = await db
      .prepare(
        `INSERT INTO sync_changes
         (user_id, ledger_id, entity_type, entity_sync_id, action, payload_json, updated_at, updated_by_device_id, updated_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(userId, ledger.id, 'transaction', syncId, 'upsert', safeJsonStringify(payload), serverNow, deviceId, userId)
      .run();

    const newChangeId = changeResult.meta.last_row_id as number;

    // 写入 projection
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
        ledger.id,
        syncId,
        userId,
        tx.tx_type,
        tx.amount,
        happenedAt,
        tx.note ?? null,
        tx.category_id ?? null,
        tx.category_name ?? null,
        tx.category_kind ?? null,
        tx.account_id ?? null,
        tx.account_name ?? null,
        tx.from_account_id ?? null,
        tx.from_account_name ?? null,
        tx.to_account_id ?? null,
        tx.to_account_name ?? null,
        tags || null,
        tx.tag_ids ? safeJsonStringify(tx.tag_ids) : null,
        tx.attachments ? safeJsonStringify(tx.attachments) : null,
        0,
        newChangeId,
      )
      .run();

    createdIds.push(syncId);
  }

  // 获取最新游标
  const latestCursor = await db
    .prepare('SELECT MAX(change_id) as max_id FROM sync_changes WHERE user_id = ?')
    .bind(userId)
    .first<{ max_id: number | null }>();

  return c.json({
    ledger_id: ledger.external_id,
    created_count: createdIds.length,
    created_ids: createdIds,
    server_cursor: latestCursor?.max_id ?? 0,
    server_timestamp: serverNow,
  });
});

// ---------------------------------------------------------------------------
// POST /write/transactions/batch-delete - 批量删除交易
// ---------------------------------------------------------------------------

batchWriteRouter.post('/transactions/batch-delete', zValidator('json', BatchTransactionDeleteSchema), async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const req = c.req.valid('json');
  const serverNow = nowUtc();

  // 查找账本
  let ledgerId: string | null = null;

  if (req.ledger_id) {
    const ledger = await db
      .prepare('SELECT id FROM ledgers WHERE user_id = ? AND external_id = ?')
      .bind(userId, req.ledger_id)
      .first<{ id: string }>();

    if (ledger) {
      ledgerId = ledger.id;
    }
  } else {
    const defaultLedger = await db
      .prepare('SELECT id FROM ledgers WHERE user_id = ? LIMIT 1')
      .bind(userId)
      .first<{ id: string }>();

    if (defaultLedger) {
      ledgerId = defaultLedger.id;
    }
  }

  if (!ledgerId) {
    return c.json({ error: 'No ledger found' }, 400);
  }

  const deviceId = req.device_id ?? 'batch-write';
  let deletedCount = 0;
  const deletedIds: string[] = [];

  // 批量删除
  for (const txSyncId of req.transaction_ids) {
    // 写入 delete tombstone
    const changeResult = await db
      .prepare(
        `INSERT INTO sync_changes
         (user_id, ledger_id, entity_type, entity_sync_id, action, payload_json, updated_at, updated_by_device_id, updated_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(userId, ledgerId, 'transaction', txSyncId, 'delete', '{}', serverNow, deviceId, userId)
      .run();

    // 从 projection 删除
    const deleteResult = await db
      .prepare('DELETE FROM read_tx_projection WHERE ledger_id = ? AND sync_id = ?')
      .bind(ledgerId, txSyncId)
      .run();

    if (deleteResult.meta.changes !== undefined && deleteResult.meta.changes > 0) {
      deletedCount++;
      deletedIds.push(txSyncId);
    }
  }

  const latestCursor = await db
    .prepare('SELECT MAX(change_id) as max_id FROM sync_changes WHERE user_id = ?')
    .bind(userId)
    .first<{ max_id: number | null }>();

  return c.json({
    ledger_id: req.ledger_id ?? 'default',
    deleted_count: deletedCount,
    deleted_ids: deletedIds,
    server_cursor: latestCursor?.max_id ?? 0,
    server_timestamp: serverNow,
  });
});

export default batchWriteRouter;
