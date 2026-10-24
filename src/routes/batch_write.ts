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

import { normalizeTransactionAccounts } from '../lib/transaction-normalization';
import { serverLogger } from '../lib/logger';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { uploadToStorage, downloadFromStorage, deleteFromStorage } from '../lib/storage-adapter';
import { randomUUID } from 'crypto';
import { insertAuditLog } from '../lib/audit';
import { idempotencyMiddleware } from '../lib/idempotency';

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
  locale: z.string().default('zh'),
  device_id: z.string().optional(),
});

const BatchTransactionDeleteSchema = z.object({
  ledger_id: z.string().optional(),
  base_change_id: z.number().int().min(0).default(0),
  tx_ids: z.array(z.string()).max(200),
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
  if (cacheRow && cacheRow.user_id === userId) {
    imageBytes = await downloadFromStorage(db, env, cacheRow.r2_key);
  }
  // 清理缓存文件
  if (cacheRow?.r2_key) await deleteFromStorage(db, env, cacheRow.r2_key);
  if (!imageBytes) {
    // 缓存已过期/异用户/无 R2：删 DB 缓存行后返回 null
    await db.prepare('DELETE FROM ai_image_cache WHERE image_id = ?').bind(attachImageId).run().catch(() => {});
    return null;
  }

  const hashBuf = await crypto.subtle.digest('SHA-256', imageBytes.slice().buffer);
  const sha256 = Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('');
  const existing = await db
    .prepare("SELECT id FROM attachment_files WHERE sha256 = ? AND ledger_id = ? AND attachment_kind = 'transaction'")
    .bind(sha256, ledger.id)
    .first<{ id: string }>();
  if (existing) {
    // 去重命中：删缓存行后返回已有附件
    await db.prepare('DELETE FROM ai_image_cache WHERE image_id = ?').bind(attachImageId).run().catch(() => {});
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
  // 统一存储入口（R2 优先 + 远端回退，storage-adapter 自动加 beecount/ 前缀）——
  // 直接 env.R2.put(r2Key) 会存无前缀 key，与其余附件不一致，且清理入口
  // （deleteFromStorage 加前缀）删不到 → 残留对象。
  const uploadResult = await uploadToStorage(db, env, r2Key, imageBytes, mime);
  if (!uploadResult.ok) { /* 附件上传失败不阻断主流程 */ }
  // 删缓存 + 插附件同事务原子写入
  await db.batch([
    db.prepare('DELETE FROM ai_image_cache WHERE image_id = ?').bind(attachImageId),
    db.prepare(
      `INSERT INTO attachment_files
       (id, ledger_id, user_id, sha256, size_bytes, mime_type, file_name, storage_path, attachment_kind, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'transaction', ?)`
    ).bind(fileId, ledger.id, userId, sha256, cacheRow!.size_bytes, mime, `screenshot${fileExt}`, r2Key, nowUtc()),
  ]);
  // 并发去重兜底：同 sha 并发写入时统一返回最早行（对齐上传端点 canonical）
  const canonical = await db
    .prepare(
      `SELECT id FROM attachment_files
       WHERE sha256 = ? AND ledger_id = ? AND attachment_kind = 'transaction'
       ORDER BY created_at ASC, id ASC LIMIT 1`
    )
    .bind(sha256, ledger.id)
    .first<{ id: string }>();
  return {
    cloudFileId: canonical?.id ?? fileId,
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

/** tags 字段归一为 string[]（兼容 string | array 两种输入） */
function splitTags(tags: unknown): string[] {
  if (Array.isArray(tags)) return tags.filter((t): t is string => typeof t === 'string' && !!t.trim());
  if (typeof tags === 'string' && tags.trim()) {
    return tags.split(/[,，、;；]/).map(t => t.trim()).filter(Boolean);
  }
  return [];
}

/** 对齐原版 _AI_TAG_BY_LOCALE：zh → AI记账 / zh-TW → AI記帳 / en → AI */
function aiTagNameByLocale(locale: string): string {
  const norm = (locale || 'zh').toLowerCase().replace('_', '-');
  if (norm.startsWith('zh-tw') || ['zh-hant', 'zh-hk', 'zh-mo'].includes(norm)) return 'AI記帳';
  if (norm.startsWith('zh')) return 'AI记账';
  return 'AI';
}

/**
 * 对齐原版 _resolve_or_make_ai_tag_name：先 lookup 同用户已有含 AI 的 tag
 * （跨 ledger user-global）→ 命中复用其名；没命中按 locale 起名。
 */
async function resolveOrMakeAiTagName(db: D1Database, userId: string, locale: string): Promise<string> {
  const rows = await db
    .prepare('SELECT name FROM user_tag_projection WHERE user_id = ? AND name LIKE ?')
    .bind(userId, '%AI%')
    .all<{ name: string | null }>();
  for (const r of rows.results) {
    if (r.name && r.name.toUpperCase().includes('AI')) return r.name;
  }
  return aiTagNameByLocale(locale);
}

/**
 * 批量创建核心（对齐原版 transactions_batch.py）：
 * 1. attach_image_id → 转正式 attachment（已有 consumeAiImageAsAttachment）
 * 2. auto_ai_tag + extra_tag_name → auto_tag_names
 * 3. ensure 所有用到的 tag 名字在 user_tag_projection 有实体，得 name→sync_id map
 *    （tx.tags 名字 + auto tags；新建的 tag 也发 sync_changes + 写投影）
 * 4. 每笔 tx：tags_csv = 合并后的名字、tag_sync_ids_json = 反查 sync_id（issue #5）
 */
async function runBatchCreate(c: any, ledgerExternalId: string): Promise<Response> {
  const db = c.env.DB as D1Database;
  const userId = c.get('userId') as string;
  const req = c.req.valid('json');
  const serverNow = nowUtc();

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

  // 自动 tag（AI 记账 + extra_tag_name）
  const autoTagNames: string[] = [];
  if (req.auto_ai_tag) autoTagNames.push(await resolveOrMakeAiTagName(db, userId, req.locale || 'zh'));
  if (req.extra_tag_name) autoTagNames.push(req.extra_tag_name);

  // name → sync_id map（已有 tag + 需要新建的 tag 实体）
  const tagNameToSyncId = new Map<string, string>();
  const existingTags = await db
    .prepare('SELECT sync_id, name FROM user_tag_projection WHERE user_id = ?')
    .bind(userId)
    .all<{ sync_id: string; name: string | null }>();
  for (const t of existingTags.results) {
    if (t.name) tagNameToSyncId.set(t.name, t.sync_id);
  }

  const neededNames = new Set<string>(autoTagNames);
  for (const tx of req.transactions) {
    for (const t of splitTags(tx.tags)) neededNames.add(t);
  }
  for (const name of neededNames) {
    if (tagNameToSyncId.has(name)) continue;
    const tagSyncId = randomUUID();
    // tag 是 user-global：sync_changes 用 scope='user'，投影写 user_tag_projection
    await db.batch([
      db.prepare(
        `INSERT INTO sync_changes (user_id, ledger_id, entity_type, entity_sync_id, action, payload_json, updated_at, updated_by_user_id, updated_by_device_id, scope)
         VALUES (?, ?, 'tag', ?, 'upsert', ?, ?, ?, ?, 'user')`
      ).bind(userId, ledger.id, tagSyncId, JSON.stringify({ syncId: tagSyncId, name }), serverNow, userId, deviceId),
      db.prepare(
        `INSERT OR REPLACE INTO user_tag_projection (sync_id, user_id, name, source_change_id)
         VALUES (?, ?, ?, (SELECT last_insert_rowid()))`
      ).bind(tagSyncId, userId, name),
    ]);
    tagNameToSyncId.set(name, tagSyncId);
  }

  for (const tx of req.transactions) {
    const txSyncId = randomUUID();
    const txType = tx.tx_type || 'expense';

    // 确保分类存在
    let categorySyncId: string | null = tx.category_id || null;
    if (tx.category_name && !categorySyncId) {
      const cat = await db
        .prepare('SELECT sync_id FROM user_category_projection WHERE user_id = ? AND name = ? AND kind = ? LIMIT 1')
        .bind(userId, tx.category_name, tx.category_kind || txType)
        .first<{ sync_id: string }>();
      if (cat) categorySyncId = cat.sync_id;
    }

    // 确保账户存在
    let accountSyncId: string | null = tx.account_id || null;
    if (tx.account_name && !accountSyncId) {
      const acc = await db
        .prepare('SELECT sync_id FROM user_account_projection WHERE user_id = ? AND name = ? LIMIT 1')
        .bind(userId, tx.account_name)
        .first<{ sync_id: string }>();
      if (acc) accountSyncId = acc.sync_id;
    }

    // 与原版 transaction_normalization 对齐：按交易类型清空无效账户字段
    // （transfer 只用 from/to；expense/income 只用一个账户），防 partial merge
    // 恢复旧转账关联——投影与同步 payload 同口径。
    const txAccountCols = normalizeTransactionAccounts(txType, {
      account_sync_id: accountSyncId,
      account_name: tx.account_name ?? null,
      from_account_sync_id: tx.from_account_id ?? null,
      from_account_name: tx.from_account_name ?? null,
      to_account_sync_id: tx.to_account_id ?? null,
      to_account_name: tx.to_account_name ?? null,
    });

    // 合并 auto tags（LLM 已识别的 tags + 自动加的 AI 记账 / 图片记账），去重保序
    const userTags = splitTags(tx.tags);
    const mergedTags = [...userTags, ...autoTagNames.filter(t => t && !userTags.includes(t))];
    const tagIds = mergedTags.map(n => tagNameToSyncId.get(n)).filter((v): v is string => !!v);
    const attachments = mergeSharedAttachment(tx.attachments, sharedAttachment);

    const payload: Record<string, unknown> = {
      syncId: txSyncId,
      type: txType,
      amount: tx.amount,
      happenedAt: tx.happened_at,
      note: tx.note || null,
      categoryId: categorySyncId,
      accountId: txAccountCols.account_sync_id,
      fromAccountId: txAccountCols.from_account_sync_id,
      toAccountId: txAccountCols.to_account_sync_id,
      tags: mergedTags.length ? mergedTags : null,
      tagIds: tagIds.length ? tagIds : null,
      attachments,
      updatedByUserId: userId,
      createdByUserId: userId,
    };

    // sync_changes + projection 同事务原子写入（db.batch = SQL transaction，
    // 任一失败整批回滚，不再需要"投影失败回删 sync_changes"的手动补偿）
    const batchResults = await db.batch([
      db.prepare(`INSERT INTO sync_changes (user_id, ledger_id, entity_type, entity_sync_id, action, payload_json, updated_at, updated_by_user_id, updated_by_device_id, scope)
        VALUES (?, ?, 'transaction', ?, 'upsert', ?, ?, ?, ?, 'ledger')`)
        .bind(userId, ledger.id, txSyncId, JSON.stringify(payload), serverNow, userId, deviceId),
      db.prepare(`INSERT OR REPLACE INTO read_tx_projection
          (ledger_id, sync_id, user_id, tx_type, amount, happened_at, note,
           category_sync_id, category_name, category_kind,
           account_sync_id, account_name,
           from_account_sync_id, from_account_name,
           to_account_sync_id, to_account_name,
           tags_csv, tag_sync_ids_json, attachments_json, tx_index, source_change_id,
           exclude_from_stats, exclude_from_budget,
           created_by_user_id, last_edited_by_user_id,
           currency_code, native_amount)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT last_insert_rowid()),
          ?, ?, ?, ?, ?, ?)`)
        .bind(ledger.id, txSyncId, userId, txType, tx.amount, tx.happened_at, tx.note || null,
          categorySyncId, tx.category_name || null, tx.category_kind || null,
          txAccountCols.account_sync_id, txAccountCols.account_name,
          txAccountCols.from_account_sync_id, txAccountCols.from_account_name,
          txAccountCols.to_account_sync_id, txAccountCols.to_account_name,
          mergedTags.length ? mergedTags.join(',') : null,
          tagIds.length ? safeJsonStringify(tagIds) : null,
          attachments ? safeJsonStringify(attachments) : null,
          0,
          tx.exclude_from_stats != null ? (tx.exclude_from_stats ? 1 : 0) : null,
          tx.exclude_from_budget != null ? (tx.exclude_from_budget ? 1 : 0) : null,
          userId, userId,
          tx.currency_code ?? tx.currencyCode ?? null,
          tx.native_amount ?? tx.nativeAmount ?? null,),
    ]);

    const changeId = batchResults[0].meta.last_row_id as number;
    maxChangeId = Math.max(maxChangeId, changeId);

    createdSyncIds.push(txSyncId);
  }

  return c.json({
    ledger_id: ledgerExternalId,
    base_change_id: req.base_change_id || 0,
    new_change_id: maxChangeId,
    server_timestamp: serverNow,
    created_sync_ids: createdSyncIds,
    attachment_id: sharedAttachment?.cloudFileId ?? null,
  });
}

const batchWriteRouter = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// Idempotency-Key 幂等中间件（对齐上游 _prepare_write，batch create/delete 端点）。
batchWriteRouter.use('*', idempotencyMiddleware);

// ---------------------------------------------------------------------------
// POST /write/transactions/batch - 批量创建交易
// ---------------------------------------------------------------------------

batchWriteRouter.post('/transactions/batch', zValidator('json', BatchTransactionCreateSchema), async (c) => {
  const ledgerIdFromPath = c.req.param('ledgerId');
  const req = c.req.valid('json');
  const ledgerExternalId = req.ledger_id || ledgerIdFromPath;
  if (!ledgerExternalId) {
    return c.json({ error: 'ledger_id is required' }, 400);
  }
  return runBatchCreate(c, ledgerExternalId);
});

const batchDeleteHandler = async (c: any) => {
  serverLogger.info('app', '[BATCH] batchDeleteHandler matched, url:', c.req.url);
  const userId = c.get('userId');
  const db = c.env.DB as D1Database;
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
  const deletedIds: string[] = [];
  const failed: Array<{ tx_id: string; reason: string }> = [];
  const stmts: any[] = [];
  const deleteIndices: number[] = [];
  const processedTxIds: string[] = [];

  // 对齐上游:只处理本账本投影中已存在的 tx_id,不存在的报 not_found(跨账本同理)
  const existingSet = new Set<string>();
  for (let i = 0; i < req.tx_ids.length; i += 500) {
    const chunk = req.tx_ids.slice(i, i + 500);
    const placeholders = chunk.map(() => '?').join(',');
    const rows = await db.prepare(
      `SELECT sync_id FROM read_tx_projection WHERE ledger_id = ? AND sync_id IN (${placeholders})`
    ).bind(ledgerId, ...chunk).all<{ sync_id: string }>();
    for (const r of rows.results) existingSet.add(r.sync_id);
  }

  for (const txSyncId of req.tx_ids) {
    if (!existingSet.has(txSyncId)) {
      failed.push({ tx_id: txSyncId, reason: 'not_found' });
      continue;
    }
    const insertIdx = stmts.length;
    deleteIndices.push(insertIdx);
    processedTxIds.push(txSyncId);
    stmts.push(
      db.prepare(
        `INSERT INTO sync_changes
         (user_id, ledger_id, entity_type, entity_sync_id, action, payload_json, updated_at, updated_by_device_id, updated_by_user_id, scope)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ledger')`
      )
        .bind(userId, ledgerId, 'transaction', txSyncId, 'delete', '{}', serverNow, deviceId, userId),
    );
    stmts.push(
      db.prepare('DELETE FROM read_tx_projection WHERE ledger_id = ? AND sync_id = ?')
        .bind(ledgerId, txSyncId),
    );
    stmts.push(
      db.prepare(
        `DELETE FROM sync_changes WHERE ledger_id = ? AND entity_type = 'transaction' AND entity_sync_id = ? AND action != 'delete'`
      ).bind(ledgerId, txSyncId),
    );
  }

  // 分块批量执行（D1 batch 最多 100 语句）
  const allResults: { meta: { last_row_id: number; changes: number } }[] = [];
  for (let i = 0; i < stmts.length; i += 100) {
    const chunk = stmts.slice(i, i + 100);
    const results = await db.batch(chunk);
    allResults.push(...results);
  }

  for (let j = 0; j < deleteIndices.length; j++) {
    const idx = deleteIndices[j];
    if (allResults[idx].meta.changes > 0) {
      deletedIds.push(processedTxIds[j]);
    }
  }

  const latestCursor = await db
    .prepare('SELECT MAX(change_id) as max_id FROM sync_changes WHERE user_id = ?')
    .bind(userId)
    .first();

  await insertAuditLog({
    db, userId, ledgerId, action: 'batch_delete', entityType: 'transaction',
    details: { count: deletedIds.length, ids: deletedIds },
  });

  return c.json({
    ledger_id: ledgerIdParam ?? 'default',
    base_change_id: 0,
    new_change_id: (latestCursor as { max_id: number | null } | null)?.max_id ?? 0,
    server_timestamp: serverNow,
    deleted_tx_ids: deletedIds,
    failed,
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
  const req = c.req.valid('json');
  const ledgerExternalId = req.ledger_id || c.req.param('ledgerId');
  if (!ledgerExternalId) return c.json({ error: 'ledger_id is required' }, 400);
  return runBatchCreate(c, ledgerExternalId);
});

export default batchWriteRouter;
