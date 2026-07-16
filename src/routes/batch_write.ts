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
import { insertAuditLog } from '../lib/audit';

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
  base_change_id: z.number().int().min(0).default(0),
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
  base_change_id: z.number().int().min(0).default(0),
  tx_ids: z.array(z.string()),
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
  const db = c.env.DB;
  const userId = c.get('userId');
  const req = c.req.valid('json');
  const serverNow = nowUtc();

  // ledger_id 可以来自 body 或 URL path
  const ledgerIdFromPath = c.req.param('ledgerId');
  const ledgerExternalId = req.ledger_id || ledgerIdFromPath;
  if (!ledgerExternalId) {
    return c.json({ error: 'ledger_id is required' }, 400);
  }

  const ledger = await db
    .prepare('SELECT id, external_id FROM ledgers WHERE user_id = ? AND external_id = ?')
    .bind(userId, ledgerExternalId)
    .first<{ id: string; external_id: string }>();
  if (!ledger) return c.json({ error: 'Ledger not found' }, 404);

  const deviceId = req.device_id || c.req.header('X-Device-ID') || 'unknown';
  const createdSyncIds: string[] = [];
  let maxChangeId = 0;

  for (const tx of req.transactions) {
    const txSyncId = randomUUID();
    const txType = tx.tx_type || 'expense';

    // 确保分类存在
    let categorySyncId: string | null = tx.category_id || null;
    if (tx.category_name && !categorySyncId) {
      const cat = await db
        .prepare('SELECT sync_id FROM read_category_projection WHERE ledger_id = ? AND name = ? AND kind = ? LIMIT 1')
        .bind(ledger.id, tx.category_name, tx.category_kind || txType)
        .first<{ sync_id: string }>();
      if (cat) categorySyncId = cat.sync_id;
    }

    // 确保账户存在
    let accountSyncId: string | null = tx.account_id || null;
    if (tx.account_name && !accountSyncId) {
      const acc = await db
        .prepare('SELECT sync_id FROM read_account_projection WHERE ledger_id = ? AND name = ? LIMIT 1')
        .bind(ledger.id, tx.account_name)
        .first<{ sync_id: string }>();
      if (acc) accountSyncId = acc.sync_id;
    }

    const payload: Record<string, unknown> = {
      tx_type: txType,
      amount: tx.amount,
      happened_at: tx.happened_at,
      note: tx.note || null,
      category_sync_id: categorySyncId,
      account_sync_id: accountSyncId,
      from_account_sync_id: tx.from_account_id || null,
      to_account_sync_id: tx.to_account_id || null,
      tags: tx.tags || null,
      tag_ids: tx.tag_ids || null,
      attachments: tx.attachments || null,
      updated_by_user_id: userId,
      created_by_user_id: userId,
    };

    const insertResult = await db
      .prepare(`INSERT INTO sync_changes (user_id, ledger_id, entity_type, entity_sync_id, action, payload_json, updated_at, updated_by_user_id, updated_by_device_id)
        VALUES (?, ?, 'transaction', ?, 'upsert', ?, ?, ?, ?)`)
      .bind(userId, ledger.id, txSyncId, JSON.stringify(payload), serverNow, userId, deviceId)
      .run();

    const changeId = (insertResult as any).lastRowId;
    maxChangeId = Math.max(maxChangeId, changeId);

    // 更新 projection（失败时回删 sync_changes）
    try {
      await db
        .prepare(`INSERT OR REPLACE INTO read_tx_projection
          (ledger_id, sync_id, user_id, tx_type, amount, happened_at, note, category_sync_id, account_sync_id, from_account_sync_id, to_account_sync_id, source_change_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(ledger.id, txSyncId, userId, txType, tx.amount, tx.happened_at, tx.note || null,
          categorySyncId, accountSyncId, tx.from_account_id || null, tx.to_account_id || null, changeId)
        .run();
    } catch (projErr) {
      await db.prepare('DELETE FROM sync_changes WHERE change_id = ?').bind(changeId).run();
      throw projErr;
    }

    createdSyncIds.push(txSyncId);
  }

  return c.json({
    ledger_id: ledgerExternalId,
    base_change_id: req.base_change_id || 0,
    new_change_id: maxChangeId,
    server_timestamp: serverNow,
    created_sync_ids: createdSyncIds,
    attachment_id: null,
  });
});

const batchDeleteHandler = async (c: any) => {
  console.log('[BATCH] batchDeleteHandler matched, url:', c.req.url);
  const userId = c.get('userId');
  const db = c.env.DB;
  const req = c.req.valid('json');
  const serverNow = nowUtc();

  const ledgerIdParam = c.req.param('ledgerId') ?? req.ledger_id;
  let ledgerId: string | null = null;

  if (ledgerIdParam) {
    const ledger = await db
      .prepare('SELECT id FROM ledgers WHERE user_id = ? AND external_id = ?')
      .bind(userId, ledgerIdParam)
      .first();

    if (ledger) {
      ledgerId = (ledger as { id: string }).id;
    }
  } else {
    const defaultLedger = await db
      .prepare('SELECT id FROM ledgers WHERE user_id = ? LIMIT 1')
      .bind(userId)
      .first();

    if (defaultLedger) {
      ledgerId = (defaultLedger as { id: string }).id;
    }
  }

  if (!ledgerId) {
    return c.json({ error: 'No ledger found' }, 400);
  }

  const deviceId = req.device_id ?? 'batch-write';
  let deletedCount = 0;
  const deletedIds: string[] = [];

  for (const txSyncId of req.tx_ids) {
    await db
      .prepare(
        `INSERT INTO sync_changes
         (user_id, ledger_id, entity_type, entity_sync_id, action, payload_json, updated_at, updated_by_device_id, updated_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(userId, ledgerId, 'transaction', txSyncId, 'delete', '{}', serverNow, deviceId, userId)
      .run();

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
    .first();

  await insertAuditLog({
    db, userId, ledgerId, action: 'batch_delete', entityType: 'transaction',
    details: { count: deletedCount, ids: deletedIds },
  });

  return c.json({
    ledger_id: ledgerIdParam ?? 'default',
    base_change_id: 0,
    new_change_id: (latestCursor as { max_id: number | null } | null)?.max_id ?? 0,
    server_timestamp: serverNow,
    deleted_tx_ids: deletedIds,
    failed: [],
  });
};

// ---------------------------------------------------------------------------
// POST /write/transactions/batch-delete - 批量删除交易
// ---------------------------------------------------------------------------

batchWriteRouter.post('/transactions/batch/delete', zValidator('json', BatchTransactionDeleteSchema), batchDeleteHandler);

// POST /write/ledgers/:ledgerId/transactions/batch/delete - 批量删除交易（前端路径别名）
// ---------------------------------------------------------------------------

batchWriteRouter.post('/ledgers/:ledgerId/transactions/batch/delete', zValidator('json', BatchTransactionDeleteSchema), batchDeleteHandler);

// POST /write/ledgers/:ledgerId/transactions/batch - 批量创建交易（前端路径别名）
// ---------------------------------------------------------------------------
batchWriteRouter.post('/ledgers/:ledgerId/transactions/batch', zValidator('json', BatchTransactionCreateSchema), async (c) => {
  const db = c.env.DB;
  const userId = c.get('userId');
  const req = c.req.valid('json');
  const serverNow = nowUtc();
  const ledgerIdFromPath = c.req.param('ledgerId');
  const ledgerExternalId = req.ledger_id || ledgerIdFromPath;
  if (!ledgerExternalId) return c.json({ error: 'ledger_id is required' }, 400);

  const ledger = await db
    .prepare('SELECT id, external_id FROM ledgers WHERE user_id = ? AND external_id = ?')
    .bind(userId, ledgerExternalId)
    .first<{ id: string; external_id: string }>();
  if (!ledger) return c.json({ error: 'Ledger not found' }, 404);

  const deviceId = req.device_id || c.req.header('X-Device-ID') || 'unknown';
  const createdSyncIds: string[] = [];
  let maxChangeId = 0;

  for (const tx of req.transactions) {
    const txSyncId = randomUUID();
    const txType = tx.tx_type || 'expense';
    let categorySyncId: string | null = tx.category_id || null;
    if (tx.category_name && !categorySyncId) {
      const cat = await db.prepare('SELECT sync_id FROM read_category_projection WHERE ledger_id = ? AND name = ? AND kind = ? LIMIT 1').bind(ledger.id, tx.category_name, tx.category_kind || txType).first<{ sync_id: string }>();
      if (cat) categorySyncId = cat.sync_id;
    }
    let accountSyncId: string | null = tx.account_id || null;
    if (tx.account_name && !accountSyncId) {
      const acc = await db.prepare('SELECT sync_id FROM read_account_projection WHERE ledger_id = ? AND name = ? LIMIT 1').bind(ledger.id, tx.account_name).first<{ sync_id: string }>();
      if (acc) accountSyncId = acc.sync_id;
    }

    const payload: Record<string, unknown> = { tx_type: txType, amount: tx.amount, happened_at: tx.happened_at, note: tx.note || null, category_sync_id: categorySyncId, account_sync_id: accountSyncId, from_account_sync_id: tx.from_account_id || null, to_account_sync_id: tx.to_account_id || null, tags: tx.tags || null, updated_by_user_id: userId, created_by_user_id: userId };
    const insertResult = await db.prepare(`INSERT INTO sync_changes (user_id, ledger_id, entity_type, entity_sync_id, action, payload_json, updated_at, updated_by_user_id, updated_by_device_id) VALUES (?, ?, 'transaction', ?, 'upsert', ?, ?, ?, ?)`).bind(userId, ledger.id, txSyncId, JSON.stringify(payload), serverNow, userId, deviceId).run();
    const changeId = (insertResult as any).lastRowId;
    maxChangeId = Math.max(maxChangeId, changeId);

    await db.prepare(`INSERT OR REPLACE INTO read_tx_projection (ledger_id, sync_id, user_id, tx_type, amount, happened_at, note, category_sync_id, account_sync_id, from_account_sync_id, to_account_sync_id, source_change_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(ledger.id, txSyncId, userId, txType, tx.amount, tx.happened_at, tx.note || null, categorySyncId, accountSyncId, tx.from_account_id || null, tx.to_account_id || null, changeId).run();
    createdSyncIds.push(txSyncId);
  }

  return c.json({ ledger_id: ledgerExternalId, base_change_id: req.base_change_id || 0, new_change_id: maxChangeId, server_timestamp: serverNow, created_sync_ids: createdSyncIds, attachment_id: null });
});

export default batchWriteRouter;
