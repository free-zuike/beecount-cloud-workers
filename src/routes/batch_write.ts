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
import { serverLogger } from '../lib/logger';
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
    exclude_from_stats: z.boolean().nullable().optional(),
    exclude_from_budget: z.boolean().nullable().optional(),
    currency_code: z.string().nullable().optional(),
    currencyCode: z.string().nullable().optional(),
    native_amount: z.number().nullable().optional(),
    nativeAmount: z.number().nullable().optional(),
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
  R2?: R2Bucket;
};

type Variables = {
  userId: string;
};

/**
 * B2 共享附件：consume ai_image_cache（一次性，user_id 校验防越权），转正式
 * attachment 一份。对齐原版 consume_image → _create_attachment_from_bytes：
 * sha256 dedup — 同 ledger 已有相同 sha 就复用；找不到/过期/异用户 → null。
 */
async function consumeAiImageAsAttachment(
  db: D1Database,
  env: { R2?: R2Bucket },
  userId: string,
  ledger: { id: string; external_id: string },
  attachImageId: string,
): Promise<Record<string, unknown> | null> {
  const cacheRow = await db
    .prepare('SELECT user_id, mime_type, size_bytes, r2_key FROM ai_image_cache WHERE image_id = ?')
    .bind(attachImageId)
    .first<{ user_id: string; mime_type: string; size_bytes: number; r2_key: string }>();
  let imageBytes: Uint8Array | null = null;
  if (cacheRow && cacheRow.user_id === userId && env.R2) {
    const obj = await env.R2.get(cacheRow.r2_key);
    if (obj) imageBytes = new Uint8Array(await obj.arrayBuffer());
  }
  // 无论成功与否都删除缓存（一次性消费；找不到 = 已过期/异用户/无 R2，静默跳过）
  await db.prepare('DELETE FROM ai_image_cache WHERE image_id = ?').bind(attachImageId).run().catch(() => {});
  if (cacheRow?.r2_key && env.R2) await env.R2.delete(cacheRow.r2_key).catch(() => {});
  if (!imageBytes) return null;

  const hashBuf = await crypto.subtle.digest('SHA-256', imageBytes.slice().buffer);
  const sha256 = Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('');
  const existing = await db
    .prepare("SELECT id FROM attachment_files WHERE sha256 = ? AND ledger_id = ? AND attachment_kind = 'transaction'")
    .bind(sha256, ledger.id)
    .first<{ id: string }>();
  if (existing) {
    return {
      cloudFileId: existing.id,
      fileName: 'screenshot.jpg',
      mimeType: cacheRow!.mime_type || 'image/jpeg',
      sha256,
      sizeBytes: cacheRow!.size_bytes,
    };
  }
  const fileId = randomUUID();
  const mime = cacheRow!.mime_type || 'image/jpeg';
  const fileExt = mime.includes('png') ? '.png' : mime.includes('webp') ? '.webp' : mime.includes('gif') ? '.gif' : '.jpg';
  const r2Key = `attachments/${ledger.external_id}/${fileId}_screenshot${fileExt}`;
  if (env.R2) {
    await env.R2.put(r2Key, imageBytes, { httpMetadata: { contentType: mime } });
  }
  await db.prepare(
    `INSERT INTO attachment_files
     (id, ledger_id, user_id, sha256, size_bytes, mime_type, file_name, storage_path, attachment_kind, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'transaction', ?)`
  ).bind(fileId, ledger.id, userId, sha256, cacheRow!.size_bytes, mime, `screenshot${fileExt}`, r2Key, nowUtc()).run();
  return {
    cloudFileId: fileId,
    fileName: `screenshot${fileExt}`,
    mimeType: mime,
    sha256,
    sizeBytes: cacheRow!.size_bytes,
  };
}

/** 把共享 attachment 合并进单笔 tx 的 attachments（若该笔自带附件则排在后面相安无事）。 */
function mergeSharedAttachment(
  txAttachments: unknown,
  shared: Record<string, unknown> | null,
): unknown {
  if (!shared) return txAttachments ?? null;
  if (Array.isArray(txAttachments) && txAttachments.length) return txAttachments;
  return [shared];
}

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
  // B2 共享附件：consume ai_image_cache 转正式 attachment（一次性）→ 每笔 tx 挂同一份
  const sharedAttachment = req.attach_image_id
    ? await consumeAiImageAsAttachment(db, c.env, userId, ledger, req.attach_image_id)
    : null;

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
      syncId: txSyncId,
      type: txType,
      amount: tx.amount,
      happenedAt: tx.happened_at,
      note: tx.note || null,
      categoryId: categorySyncId,
      accountId: accountSyncId,
      fromAccountId: tx.from_account_id || null,
      toAccountId: tx.to_account_id || null,
      tags: tx.tags || null,
      tagIds: tx.tag_ids || null,
      attachments: mergeSharedAttachment(tx.attachments, sharedAttachment),
      updatedByUserId: userId,
      createdByUserId: userId,
    };

    // sync_changes INSERT → 取 change_id → projection INSERT（sequential，D1 不支持 batch 内 last_insert_rowid 跨语句）
    const insertResult = await db.prepare(`INSERT INTO sync_changes (user_id, ledger_id, entity_type, entity_sync_id, action, payload_json, updated_at, updated_by_user_id, updated_by_device_id, scope)
        VALUES (?, ?, 'transaction', ?, 'upsert', ?, ?, ?, ?, 'ledger')`)
        .bind(userId, ledger.id, txSyncId, JSON.stringify(payload), serverNow, userId, deviceId).run();
    const changeId = insertResult.meta.last_row_id as number;
    maxChangeId = Math.max(maxChangeId, changeId);

    try {
      await db.prepare(`INSERT OR REPLACE INTO read_tx_projection
          (ledger_id, sync_id, user_id, tx_type, amount, happened_at, note,
           category_sync_id, category_name, category_kind,
           account_sync_id, account_name,
           from_account_sync_id, from_account_name,
           to_account_sync_id, to_account_name,
           tags_csv, tag_sync_ids_json, attachments_json, tx_index, source_change_id,
           exclude_from_stats, exclude_from_budget,
           created_by_user_id, last_edited_by_user_id,
           currency_code, native_amount)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?)`)
        .bind(ledger.id, txSyncId, userId, txType, tx.amount, tx.happened_at, tx.note || null,
          categorySyncId, tx.category_name || null, tx.category_kind || null,
          accountSyncId, tx.account_name || null,
          tx.from_account_id || null, tx.from_account_name || null,
          tx.to_account_id || null, tx.to_account_name || null,
          tx.tags ? (Array.isArray(tx.tags) ? tx.tags.join(',') : String(tx.tags)) : null,
          tx.tag_ids ? safeJsonStringify(tx.tag_ids) : null,
          mergeSharedAttachment(tx.attachments, sharedAttachment) ? safeJsonStringify(mergeSharedAttachment(tx.attachments, sharedAttachment)) : null,
          0, changeId,
          tx.exclude_from_stats != null ? (tx.exclude_from_stats ? 1 : 0) : null,
          tx.exclude_from_budget != null ? (tx.exclude_from_budget ? 1 : 0) : null,
          userId, userId,
          tx.currency_code ?? tx.currencyCode ?? null,
          tx.native_amount ?? tx.nativeAmount ?? null,).run();
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
  serverLogger.info('app', '[BATCH] batchDeleteHandler matched, url:', c.req.url);
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
         (user_id, ledger_id, entity_type, entity_sync_id, action, payload_json, updated_at, updated_by_device_id, updated_by_user_id, scope)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ledger')`
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
  // B2 共享附件：consume ai_image_cache 转正式 attachment（一次性）→ 每笔 tx 挂同一份
  const sharedAttachment = req.attach_image_id
    ? await consumeAiImageAsAttachment(db, c.env, userId, ledger, req.attach_image_id)
    : null;

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

    const payload: Record<string, unknown> = { syncId: txSyncId, type: txType, amount: tx.amount, happenedAt: tx.happened_at, note: tx.note || null, categoryId: categorySyncId, accountId: accountSyncId, fromAccountId: tx.from_account_id || null, toAccountId: tx.to_account_id || null, tags: tx.tags || null, attachments: mergeSharedAttachment(tx.attachments, sharedAttachment), updatedByUserId: userId, createdByUserId: userId };
    const insertResult = await db.prepare(`INSERT INTO sync_changes (user_id, ledger_id, entity_type, entity_sync_id, action, payload_json, updated_at, updated_by_user_id, updated_by_device_id, scope) VALUES (?, ?, 'transaction', ?, 'upsert', ?, ?, ?, ?, 'ledger')`).bind(userId, ledger.id, txSyncId, JSON.stringify(payload), serverNow, userId, deviceId).run();
    const changeId = (insertResult as any).lastRowId;
    maxChangeId = Math.max(maxChangeId, changeId);

    await db.prepare(`INSERT OR REPLACE INTO read_tx_projection (ledger_id, sync_id, user_id, tx_type, amount, happened_at, note, category_sync_id, category_name, category_kind, account_sync_id, account_name, from_account_sync_id, from_account_name, to_account_sync_id, to_account_name, tags_csv, tag_sync_ids_json, attachments_json, tx_index, source_change_id, exclude_from_stats, exclude_from_budget, created_by_user_id, last_edited_by_user_id, currency_code, native_amount) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(ledger.id, txSyncId, userId, txType, tx.amount, tx.happened_at, tx.note || null, categorySyncId, tx.category_name || null, tx.category_kind || null, accountSyncId, tx.account_name || null, tx.from_account_id || null, tx.from_account_name || null, tx.to_account_id || null, tx.to_account_name || null, tx.tags ? (Array.isArray(tx.tags) ? tx.tags.join(',') : String(tx.tags)) : null, tx.tag_ids ? safeJsonStringify(tx.tag_ids) : null, mergeSharedAttachment(tx.attachments, sharedAttachment) ? safeJsonStringify(mergeSharedAttachment(tx.attachments, sharedAttachment)) : null, 0, changeId, tx.exclude_from_stats != null ? (tx.exclude_from_stats ? 1 : 0) : null, tx.exclude_from_budget != null ? (tx.exclude_from_budget ? 1 : 0) : null, userId, userId, tx.currency_code ?? tx.currencyCode ?? null, tx.native_amount ?? tx.nativeAmount ?? null).run();
    createdSyncIds.push(txSyncId);
  }

  return c.json({ ledger_id: ledgerExternalId, base_change_id: req.base_change_id || 0, new_change_id: maxChangeId, server_timestamp: serverNow, created_sync_ids: createdSyncIds, attachment_id: null });
});

export default batchWriteRouter;
