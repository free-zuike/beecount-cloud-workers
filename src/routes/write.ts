/**
 * 写路由模块 - 实现 BeeCount Cloud 写操作接口
 *
 * 参考原版 BeeCount-Cloud (Python/FastAPI) 的 /write/* 端点：
 * - POST /write/ledgers                      - 创建账本
 * - PATCH /write/ledgers/:id                 - 更新账本元信息
 * - POST /write/transactions                 - 创建交易
 * - PATCH /write/transactions/:id            - 更新交易
 * - DELETE /write/transactions/:id           - 删除交易
 * - POST /write/transactions/batch           - 批量创建交易
 * - DELETE /write/transactions/batch         - 批量删除交易
 * - POST /write/accounts                      - 创建账户
 * - PATCH /write/accounts/:id                - 更新账户
 * - POST /write/categories                   - 创建分类
 * - PATCH /write/categories/:id             - 更新分类
 * - POST /write/tags                         - 创建标签
 * - PATCH /write/tags/:id                    - 更新标签
 * - POST /write/budgets                      - 创建预算
 * - PATCH /write/budgets/:id                - 更新预算
 *
 * 所有写操作都会：
 * 1. 生成 SyncChange 记录
 * 2. 同步刷新 projection 表
 * 3. 返回 WriteCommitMeta（base_change_id / new_change_id / server_timestamp）
 *
 * @module routes/write
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { insertAuditLog } from '../lib/audit';

// ===========================
// 辅助函数
// ===========================

/** 获取当前 UTC 时间 */
function nowUtc(): string {
  return new Date().toISOString();
}

/** 序列化为 JSON */
function safeJsonStringify(obj: unknown): string {
  return JSON.stringify(obj);
}

// ===========================
// Schema 定义
// ===========================

/** 创建账本请求 */
const WriteLedgerCreateSchema = z.object({
  ledger_id: z.string().min(3).max(128).optional(),
  ledger_name: z.string().min(1).max(255),
  currency: z.string().min(1).max(16).default('CNY'),
  month_start_day: z.number().int().min(1).max(28).optional(),
});

/** 更新账本元信息请求 */
const WriteLedgerMetaUpdateSchema = z.object({
  base_change_id: z.number().int().min(0).default(0),
  ledger_name: z.string().min(1).max(255).optional(),
  currency: z.string().min(1).max(16).optional(),
  month_start_day: z.number().int().min(1).max(28).optional(),
});

/** 基础写请求（包含 base_change_id） */
const WriteBaseSchema = z.object({
  base_change_id: z.number().int().min(0).default(0),
  request_id: z.string().max(128).optional(),
});

/** 创建交易请求 */
const WriteTransactionCreateSchema = WriteBaseSchema.extend({
  ledger_id: z.string().optional(),
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
  exclude_from_stats: z.boolean().optional(),
  exclude_from_budget: z.boolean().optional(),
});

/** 更新交易请求 */
const WriteTransactionUpdateSchema = WriteBaseSchema.extend({
  tx_type: z.enum(['expense', 'income', 'transfer']).nullable().optional(),
  amount: z.number().nullable().optional(),
  happened_at: z.string().or(z.date()).nullable().optional(),
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
  exclude_from_stats: z.boolean().optional(),
  exclude_from_budget: z.boolean().optional(),
});

/** 创建账户请求 */
const WriteAccountCreateSchema = WriteBaseSchema.extend({
  name: z.string().min(1).max(255),
  account_type: z.string().nullable().optional(),
  currency: z.string().nullable().optional(),
  initial_balance: z.number().nullable().optional(),
  note: z.string().nullable().optional(),
  credit_limit: z.number().nullable().optional(),
  billing_day: z.number().int().min(1).max(31).nullable().optional(),
  payment_due_day: z.number().int().min(1).max(31).nullable().optional(),
  bank_name: z.string().nullable().optional(),
  card_last_four: z.string().max(8).nullable().optional(),
});

/** 更新账户请求 */
const WriteAccountUpdateSchema = WriteBaseSchema.extend({
  name: z.string().min(1).max(255).nullable().optional(),
  account_type: z.string().nullable().optional(),
  currency: z.string().nullable().optional(),
  initial_balance: z.number().nullable().optional(),
  note: z.string().nullable().optional(),
  credit_limit: z.number().nullable().optional(),
  billing_day: z.number().int().min(1).max(31).nullable().optional(),
  payment_due_day: z.number().int().min(1).max(31).nullable().optional(),
  bank_name: z.string().nullable().optional(),
  card_last_four: z.string().max(8).nullable().optional(),
});

/** 创建分类请求 */
const WriteCategoryCreateSchema = WriteBaseSchema.extend({
  name: z.string().min(1).max(255),
  kind: z.enum(['expense', 'income', 'transfer']),
  level: z.number().int().nullable().optional(),
  sort_order: z.number().int().nullable().optional(),
  icon: z.string().nullable().optional(),
  icon_type: z.string().nullable().optional(),
  custom_icon_path: z.string().nullable().optional(),
  icon_cloud_file_id: z.string().nullable().optional(),
  icon_cloud_sha256: z.string().nullable().optional(),
  parent_name: z.string().nullable().optional(),
});

/** 更新分类请求 */
const WriteCategoryUpdateSchema = WriteBaseSchema.extend({
  name: z.string().min(1).max(255).nullable().optional(),
  kind: z.enum(['expense', 'income', 'transfer']).nullable().optional(),
  level: z.number().int().nullable().optional(),
  sort_order: z.number().int().nullable().optional(),
  icon: z.string().nullable().optional(),
  icon_type: z.string().nullable().optional(),
  custom_icon_path: z.string().nullable().optional(),
  icon_cloud_file_id: z.string().nullable().optional(),
  icon_cloud_sha256: z.string().nullable().optional(),
  parent_name: z.string().nullable().optional(),
});

/** 创建标签请求 */
const WriteTagCreateSchema = WriteBaseSchema.extend({
  name: z.string().min(1).max(255),
  color: z.string().nullable().optional(),
});

/** 更新标签请求 */
const WriteTagUpdateSchema = WriteBaseSchema.extend({
  name: z.string().min(1).max(255).nullable().optional(),
  color: z.string().nullable().optional(),
});

/** 创建预算请求 */
const WriteBudgetCreateSchema = WriteBaseSchema.extend({
  type: z.enum(['total', 'category']).default('total'),
  category_id: z.string().nullable().optional(),
  amount: z.number().gt(0),
  period: z.enum(['monthly', 'weekly', 'yearly']).default('monthly'),
  start_day: z.number().int().min(1).max(28).default(1),
  enabled: z.boolean().default(true),
});

/** 更新预算请求 */
const WriteBudgetUpdateSchema = WriteBaseSchema.extend({
  amount: z.number().gt(0).nullable().optional(),
  period: z.enum(['monthly', 'weekly', 'yearly']).nullable().optional(),
  start_day: z.number().int().min(1).max(28).nullable().optional(),
  enabled: z.boolean().nullable().optional(),
});

// ===========================
// 响应类型
// ===========================

/** 写操作提交元信息 */
interface WriteCommitMeta {
  ledger_id: string;
  base_change_id: number;
  new_change_id: number;
  server_timestamp: string;
  idempotency_replayed: boolean;
  entity_id: string | null;
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

const writeRouter = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// ---------------------------------------------------------------------------
// POST /write/ledgers - 创建账本
// ---------------------------------------------------------------------------

/**
 * 创建新账本
 *
 * 功能说明：
 * - 如果 ledger_id 已存在（同一用户），返回现有账本信息
 * - 自动生成内部 ID
 * - 同步写入 ledgers 表和 SyncChange 表
 */
writeRouter.post('/ledgers', zValidator('json', WriteLedgerCreateSchema), async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const req = c.req.valid('json');
  const serverNow = nowUtc();

  console.log('[WRITE] /ledgers POST called, userId:', userId, 'req:', JSON.stringify(req));

  // 如果没有提供 ledger_id，生成一个唯一的
  let ledgerExternalId = req.ledger_id;
  if (!ledgerExternalId) {
    // 生成一个友好的唯一 ID
    const randBytes = new Uint8Array(6);
    crypto.getRandomValues(randBytes);
    const randStr = Array.from(randBytes).map(b => b.toString(16).padStart(2, '0')).join('');
    ledgerExternalId = 'ledger_' + Date.now() + '_' + randStr;
    console.log('[WRITE] Generated new ledgerExternalId:', ledgerExternalId);
  }

  const syncId = randomUUID();

  // 检查是否已存在
  const existing = await db
    .prepare('SELECT id, external_id FROM ledgers WHERE user_id = ? AND external_id = ?')
    .bind(userId, ledgerExternalId)
    .first<{ id: string; external_id: string }>();

  console.log('[WRITE] Existing ledger check:', existing);

  if (existing) {
    console.log('[WRITE] Ledger already exists, returning 409');
    return c.json({ error: 'Ledger already exists', detail: `ledger_id "${ledgerExternalId}" already exists` }, 409);
  }

  // 创建账本
  const ledgerId = randomUUID();
  console.log('[WRITE] Creating ledger, ledgerId:', ledgerId, 'externalId:', ledgerExternalId, 'name:', req.ledger_name);
  
  await db
    .prepare(
      `INSERT INTO ledgers (id, user_id, external_id, name, currency, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(ledgerId, userId, ledgerExternalId, req.ledger_name, req.currency, serverNow)
    .run();

  // 写入 SyncChange
  const changeResult = await db
    .prepare(
      `INSERT INTO sync_changes
       (user_id, ledger_id, entity_type, entity_sync_id, action, payload_json, updated_at, updated_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      userId,
      ledgerId,
      'ledger_snapshot',
      syncId,
      'upsert',
      safeJsonStringify({ id: ledgerExternalId, ledgerName: req.ledger_name, currency: req.currency, monthStartDay: req.month_start_day ?? 1 }),
      serverNow,
      userId,
    )
    .run();

  const newChangeId = changeResult.meta.last_row_id as number;
  console.log('[WRITE] Ledger created successfully, changeId:', newChangeId);

  await insertAuditLog({
    db, userId, ledgerId, action: 'create', entityType: 'ledger', entityId: ledgerExternalId,
    details: { name: req.ledger_name, currency: req.currency },
  });

  return c.json({
    ledger_id: ledgerExternalId,
    base_change_id: 0,
    new_change_id: newChangeId,
    server_timestamp: serverNow,
    idempotency_replayed: false,
    entity_id: ledgerExternalId,
  } as WriteCommitMeta);
});

// ---------------------------------------------------------------------------
// PATCH /write/ledgers/:ledgerId - 更新账本元信息
// ---------------------------------------------------------------------------

/**
 * 更新账本元信息（名称、货币）
 */
writeRouter.patch('/ledgers/:ledgerId/meta', zValidator('json', WriteLedgerMetaUpdateSchema), async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const ledgerId = c.req.param('ledgerId');
  const req = c.req.valid('json');
  const serverNow = nowUtc();

  // 查找账本
  const ledger = await db
    .prepare('SELECT id, external_id FROM ledgers WHERE user_id = ? AND external_id = ?')
    .bind(userId, ledgerId)
    .first<{ id: string; external_id: string }>();

  if (!ledger) {
    return c.json({ error: 'Ledger not found' }, 404);
  }

  const syncId = randomUUID();

  // 获取现有 payload
  const latestChange = await db
    .prepare(
      `SELECT payload_json FROM sync_changes
       WHERE ledger_id = ? AND entity_type = 'ledger_snapshot'
       ORDER BY change_id DESC LIMIT 1`
    )
    .bind(ledger.id)
    .first<{ payload_json: string }>();

  const existingPayload = latestChange
    ? (JSON.parse(latestChange.payload_json) as Record<string, unknown>)
    : {};

  const newPayload = {
    ...existingPayload,
    ...(req.ledger_name !== undefined && { ledgerName: req.ledger_name }),
    ...(req.currency !== undefined && { currency: req.currency }),
    ...(req.month_start_day !== undefined && { monthStartDay: req.month_start_day }),
  };

  await db.batch([
    db.prepare(
      `INSERT INTO sync_changes
       (user_id, ledger_id, entity_type, entity_sync_id, action, payload_json, updated_at, updated_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      userId,
      ledger.id,
      'ledger_snapshot',
      syncId,
      'upsert',
      safeJsonStringify(newPayload),
      serverNow,
      userId,
    ),
    db.prepare(
      `UPDATE ledgers SET name = ?, currency = ?, month_start_day = ? WHERE id = ?`
    ).bind(
      req.ledger_name ?? ledger.external_id,
      req.currency ?? 'CNY',
      req.month_start_day ?? 1,
      ledger.id,
    ),
  ]);

  await insertAuditLog({
    db, userId, ledgerId: ledger.id, action: 'update', entityType: 'ledger', entityId: ledgerId,
    details: { name: req.ledger_name, currency: req.currency },
  });

  return c.json({
    ledger_id: ledgerId,
    base_change_id: 0,
    new_change_id: 0,
    server_timestamp: serverNow,
    idempotency_replayed: false,
    entity_id: ledger.id,
  } as WriteCommitMeta);
});

// ---------------------------------------------------------------------------
// DELETE /write/ledgers/:ledgerId - 删除账本
// ---------------------------------------------------------------------------

writeRouter.delete('/ledgers/:ledgerId', async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const ledgerId = c.req.param('ledgerId');
  const serverNow = nowUtc();

  const ledger = await db
    .prepare('SELECT id, external_id FROM ledgers WHERE user_id = ? AND external_id = ?')
    .bind(userId, ledgerId)
    .first<{ id: string; external_id: string }>();

  if (!ledger) {
    return c.json({ error: 'Ledger not found' }, 404);
  }

  // 只添加 ledger_snapshot delete 变更，不直接删除账本
  // 让同步和 projection 应用逻辑处理实际删除
  await db
    .prepare(
      `INSERT INTO sync_changes (user_id, ledger_id, entity_type, entity_sync_id, action, payload_json, updated_at, updated_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )    .bind(userId, ledger.id, 'ledger_snapshot', ledger.external_id, 'delete', '{}', serverNow, userId)
    .run();

  await insertAuditLog({
    db, userId, ledgerId: ledger.id, action: 'delete', entityType: 'ledger', entityId: ledgerId,
  });

  return c.json({ success: true, ledger_id: ledgerId });
});

// ---------------------------------------------------------------------------
// POST /write/transactions - 创建交易
// ---------------------------------------------------------------------------

/**
 * 创建新交易
 *
 * 功能说明：
 * - 生成 SyncChange (transaction)
 * - 同步写入 read_tx_projection
 * - 支持标签（tags_csv / tag_sync_ids_json）
 * - 支持附件（attachments_json）
 */
writeRouter.post('/ledgers/:ledgerId/transactions', zValidator('json', WriteTransactionCreateSchema), async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const req = c.req.valid('json');
  const serverNow = nowUtc();

  console.log('[WRITE] /transactions POST called, userId:', userId, 'req:', JSON.stringify(req));

  // 查找账本 - 如果提供了 ledger_id，使用它；否则使用用户的第一个账本
  let ledger;
  if (req.ledger_id) {
    ledger = await db
      .prepare('SELECT id, external_id FROM ledgers WHERE user_id = ? AND external_id = ?')
      .bind(userId, req.ledger_id)
      .first<{ id: string; external_id: string }>();
  }
  
  // 如果没有指定账本或找不到，使用用户的第一个账本
  if (!ledger) {
    ledger = await db
      .prepare('SELECT id, external_id FROM ledgers WHERE user_id = ?')
      .bind(userId)
      .first<{ id: string; external_id: string }>();
  }

  console.log('[WRITE] Found ledger:', ledger);

  if (!ledger) {
    return c.json({ error: 'No ledger found' }, 400);
  }

  const syncId = randomUUID();
  const happenedAt = typeof req.happened_at === 'string' ? req.happened_at : new Date(req.happened_at).toISOString();

  // 构建 payload
  const payload: Record<string, unknown> = {
    tx_type: req.tx_type,
    amount: req.amount,
    happened_at: happenedAt,
    note: req.note ?? null,
    category_name: req.category_name ?? null,
    category_kind: req.category_kind ?? null,
    account_name: req.account_name ?? null,
    from_account_name: req.from_account_name ?? null,
    to_account_name: req.to_account_name ?? null,
    category_id: req.category_id ?? null,
    account_id: req.account_id ?? null,
    from_account_id: req.from_account_id ?? null,
    to_account_id: req.to_account_id ?? null,
    tags: typeof req.tags === 'string' ? req.tags : Array.isArray(req.tags) ? req.tags.join(',') : null,
    tag_ids: req.tag_ids ?? null,
    attachments: req.attachments ?? null,
  };

  // 写入 SyncChange
  const changeResult = await db
    .prepare(
      `INSERT INTO sync_changes
       (user_id, ledger_id, entity_type, entity_sync_id, action, payload_json, updated_at, updated_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(userId, ledger.id, 'transaction', syncId, 'upsert', safeJsonStringify(payload), serverNow, userId)
    .run();

  const newChangeId = changeResult.meta.last_row_id as number;

  // 同步写入 projection
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
      req.tx_type,
      req.amount,
      happenedAt,
      req.note ?? null,
      req.category_id ?? null,
      req.category_name ?? null,
      req.category_kind ?? null,
      req.account_id ?? null,
      req.account_name ?? null,
      req.from_account_id ?? null,
      req.from_account_name ?? null,
      req.to_account_id ?? null,
      req.to_account_name ?? null,
      typeof req.tags === 'string' ? req.tags : Array.isArray(req.tags) ? req.tags.join(',') : null,
      req.tag_ids ? safeJsonStringify(req.tag_ids) : null,
      req.attachments ? safeJsonStringify(req.attachments) : null,
      0,
      newChangeId,
    )
    .run();

  console.log('[WRITE] Transaction created successfully, syncId:', syncId, 'ledger.id:', ledger.id);

  await insertAuditLog({
    db, userId, ledgerId: ledger.id, action: 'create', entityType: 'transaction', entityId: syncId,
    details: { tx_type: req.tx_type, amount: req.amount, happened_at: happenedAt },
  });

  return c.json({
    ledger_id: ledger.external_id,
    base_change_id: req.base_change_id,
    new_change_id: newChangeId,
    server_timestamp: serverNow,
    idempotency_replayed: false,
    entity_id: syncId,
  } as WriteCommitMeta);
});

// ---------------------------------------------------------------------------
// PATCH /write/accounts/:id - 更新账户
// ---------------------------------------------------------------------------

writeRouter.patch('/ledgers/:ledgerId/accounts/:id', zValidator('json', WriteAccountUpdateSchema), async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const req = c.req.valid('json');
  const serverNow = nowUtc();
  const accountSyncId = c.req.param('id');

  const ledger = await db
    .prepare('SELECT id, external_id FROM ledgers WHERE user_id = ?')
    .bind(userId)
    .first<{ id: string; external_id: string }>();

  if (!ledger) {
    return c.json({ error: 'No ledger found' }, 400);
  }

  const changeResult = await db
    .prepare(
      `INSERT INTO sync_changes
       (user_id, ledger_id, entity_type, entity_sync_id, action, payload_json, updated_at, updated_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(userId, ledger.id, 'account', accountSyncId, 'upsert', safeJsonStringify({
      name: req.name,
      account_type: req.account_type ?? null,
      currency: req.currency ?? null,
      initial_balance: req.initial_balance ?? 0,
      note: req.note ?? null,
      credit_limit: req.credit_limit ?? null,
      billing_day: req.billing_day ?? null,
      payment_due_day: req.payment_due_day ?? null,
      bank_name: req.bank_name ?? null,
      card_last_four: req.card_last_four ?? null,
    }), serverNow, userId)
    .run();

  const newChangeId = changeResult.meta.last_row_id as number;

  await db
    .prepare(
      `INSERT INTO read_account_projection
       (ledger_id, sync_id, user_id, name, account_type, currency, initial_balance,
        note, credit_limit, billing_day, payment_due_day, bank_name, card_last_four, source_change_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(ledger_id, sync_id) DO UPDATE SET name = ?, account_type = ?, currency = ?, initial_balance = ?,
        note = ?, credit_limit = ?, billing_day = ?, payment_due_day = ?, bank_name = ?, card_last_four = ?, source_change_id = ?`
    )
    .bind(
      ledger.id, accountSyncId, userId, req.name, req.account_type ?? null,
      req.currency ?? null, req.initial_balance ?? 0, req.note ?? null,
      req.credit_limit ?? null, req.billing_day ?? null, req.payment_due_day ?? null,
      req.bank_name ?? null, req.card_last_four ?? null, newChangeId,
      req.name, req.account_type ?? null, req.currency ?? null, req.initial_balance ?? 0, req.note ?? null,
      req.credit_limit ?? null, req.billing_day ?? null, req.payment_due_day ?? null,
      req.bank_name ?? null, req.card_last_four ?? null, newChangeId,
    )
    .run();

  await insertAuditLog({
    db, userId, ledgerId: ledger.id, action: 'update', entityType: 'account', entityId: accountSyncId,
    details: { name: req.name },
  });

  return c.json({
    ledger_id: ledger.external_id,
    base_change_id: req.base_change_id,
    new_change_id: newChangeId,
    server_timestamp: serverNow,
    idempotency_replayed: false,
    entity_id: accountSyncId,
  } as WriteCommitMeta);
});

// ---------------------------------------------------------------------------
// DELETE /write/accounts/:id - 删除账户
// ---------------------------------------------------------------------------

writeRouter.delete('/ledgers/:ledgerId/accounts/:id', zValidator('json', WriteBaseSchema), async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const req = c.req.valid('json');
  const serverNow = nowUtc();
  const accountSyncId = c.req.param('id');

  const ledger = await db
    .prepare('SELECT id, external_id FROM ledgers WHERE user_id = ?')
    .bind(userId)
    .first<{ id: string; external_id: string }>();

  if (!ledger) {
    return c.json({ error: 'No ledger found' }, 400);
  }

  const changeResult = await db
    .prepare(
      `INSERT INTO sync_changes
       (user_id, ledger_id, entity_type, entity_sync_id, action, payload_json, updated_at, updated_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(userId, ledger.id, 'account', accountSyncId, 'delete', '{}', serverNow, userId)
    .run();

  const newChangeId = changeResult.meta.last_row_id as number;

  await db
    .prepare('DELETE FROM read_account_projection WHERE sync_id = ? AND ledger_id = ?')
    .bind(accountSyncId, ledger.id)
    .run();

  await insertAuditLog({
    db, userId, ledgerId: ledger.id, action: 'delete', entityType: 'account', entityId: accountSyncId,
  });

  return c.json({
    ledger_id: ledger.external_id,
    base_change_id: req.base_change_id,
    new_change_id: newChangeId,
    server_timestamp: serverNow,
    idempotency_replayed: false,
    entity_id: accountSyncId,
  } as WriteCommitMeta);
});

// ---------------------------------------------------------------------------
// PATCH /write/tags/:id - 更新标签
// ---------------------------------------------------------------------------

writeRouter.patch('/ledgers/:ledgerId/tags/:id', zValidator('json', WriteTagUpdateSchema), async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const req = c.req.valid('json');
  const serverNow = nowUtc();
  const tagSyncId = c.req.param('id');

  const ledger = await db
    .prepare('SELECT id, external_id FROM ledgers WHERE user_id = ?')
    .bind(userId)
    .first<{ id: string; external_id: string }>();

  if (!ledger) {
    return c.json({ error: 'No ledger found' }, 400);
  }

  const changeResult = await db
    .prepare(
      `INSERT INTO sync_changes
       (user_id, ledger_id, entity_type, entity_sync_id, action, payload_json, updated_at, updated_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(userId, ledger.id, 'tag', tagSyncId, 'upsert', safeJsonStringify({ name: req.name, color: req.color ?? null }), serverNow, userId)
    .run();

  const newChangeId = changeResult.meta.last_row_id as number;

  await db
    .prepare(
      `INSERT INTO read_tag_projection
       (ledger_id, sync_id, user_id, name, color, source_change_id)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(ledger_id, sync_id) DO UPDATE SET name = ?, color = ?, source_change_id = ?`
    )
    .bind(ledger.id, tagSyncId, userId, req.name, req.color ?? null, newChangeId, req.name, req.color ?? null, newChangeId)
    .run();

  await insertAuditLog({
    db, userId, ledgerId: ledger.id, action: 'update', entityType: 'tag', entityId: tagSyncId,
    details: { name: req.name },
  });

  return c.json({
    ledger_id: ledger.external_id,
    base_change_id: req.base_change_id,
    new_change_id: newChangeId,
    server_timestamp: serverNow,
    idempotency_replayed: false,
    entity_id: tagSyncId,
  } as WriteCommitMeta);
});

// ---------------------------------------------------------------------------
// DELETE /write/tags/:id - 删除标签
// ---------------------------------------------------------------------------

writeRouter.delete('/ledgers/:ledgerId/tags/:id', zValidator('json', WriteBaseSchema), async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const req = c.req.valid('json');
  const serverNow = nowUtc();
  const tagSyncId = c.req.param('id');

  const ledger = await db
    .prepare('SELECT id, external_id FROM ledgers WHERE user_id = ?')
    .bind(userId)
    .first<{ id: string; external_id: string }>();

  if (!ledger) {
    return c.json({ error: 'No ledger found' }, 400);
  }

  const changeResult = await db
    .prepare(
      `INSERT INTO sync_changes
       (user_id, ledger_id, entity_type, entity_sync_id, action, payload_json, updated_at, updated_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(userId, ledger.id, 'tag', tagSyncId, 'delete', '{}', serverNow, userId)
    .run();

  const newChangeId = changeResult.meta.last_row_id as number;

  await db
    .prepare('DELETE FROM read_tag_projection WHERE sync_id = ? AND ledger_id = ?')
    .bind(tagSyncId, ledger.id)
    .run();

  await insertAuditLog({
    db, userId, ledgerId: ledger.id, action: 'delete', entityType: 'tag', entityId: tagSyncId,
  });

  return c.json({
    ledger_id: ledger.external_id,
    base_change_id: req.base_change_id,
    new_change_id: newChangeId,
    server_timestamp: serverNow,
    idempotency_replayed: false,
    entity_id: tagSyncId,
  } as WriteCommitMeta);
});

// ---------------------------------------------------------------------------
// PATCH /write/transactions/:id - 更新交易
// ---------------------------------------------------------------------------

/**
 * 更新现有交易
 */
writeRouter.patch('/ledgers/:ledgerId/transactions/:id', zValidator('json', WriteTransactionUpdateSchema), async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const txSyncId = c.req.param('id');
  const req = c.req.valid('json');
  const serverNow = nowUtc();

  // 查找账本
  const ledger = await db
    .prepare('SELECT id, external_id FROM ledgers WHERE user_id = ?')
    .bind(userId)
    .first<{ id: string; external_id: string }>();

  if (!ledger) {
    return c.json({ error: 'No ledger found' }, 400);
  }

  // 获取现有变更
  const latestChange = await db
    .prepare(
      `SELECT payload_json FROM sync_changes
       WHERE ledger_id = ? AND entity_type = 'transaction' AND entity_sync_id = ?
       ORDER BY change_id DESC LIMIT 1`
    )
    .bind(ledger.id, txSyncId)
    .first<{ payload_json: string }>();

  if (!latestChange) {
    return c.json({ error: 'Transaction not found' }, 404);
  }

  const existingPayload = JSON.parse(latestChange.payload_json);
  const newPayload = { ...existingPayload };

  // 合并更新字段
  if (req.tx_type !== undefined) newPayload.tx_type = req.tx_type;
  if (req.amount !== undefined) newPayload.amount = req.amount;
  if (req.happened_at !== undefined)
    newPayload.happened_at =
      typeof req.happened_at === 'string' ? req.happened_at : req.happened_at ? req.happened_at.toISOString() : null;
  if (req.note !== undefined) newPayload.note = req.note;
  if (req.category_name !== undefined) newPayload.category_name = req.category_name;
  if (req.category_kind !== undefined) newPayload.category_kind = req.category_kind;
  if (req.account_name !== undefined) newPayload.account_name = req.account_name;
  if (req.from_account_name !== undefined) newPayload.from_account_name = req.from_account_name;
  if (req.to_account_name !== undefined) newPayload.to_account_name = req.to_account_name;
  if (req.category_id !== undefined) newPayload.category_id = req.category_id;
  if (req.account_id !== undefined) newPayload.account_id = req.account_id;
  if (req.from_account_id !== undefined) newPayload.from_account_id = req.from_account_id;
  if (req.to_account_id !== undefined) newPayload.to_account_id = req.to_account_id;
  if (req.tags !== undefined)
    newPayload.tags = typeof req.tags === 'string' ? req.tags : Array.isArray(req.tags) ? req.tags.join(',') : null;
  if (req.tag_ids !== undefined) newPayload.tag_ids = req.tag_ids;
  if (req.attachments !== undefined) newPayload.attachments = req.attachments;

  // 写入 SyncChange
  const changeResult = await db
    .prepare(
      `INSERT INTO sync_changes
       (user_id, ledger_id, entity_type, entity_sync_id, action, payload_json, updated_at, updated_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(userId, ledger.id, 'transaction', txSyncId, 'upsert', safeJsonStringify(newPayload), serverNow, userId)
    .run();

  const newChangeId = changeResult.meta.last_row_id as number;

  // 更新 projection
  await db
    .prepare(
      `UPDATE read_tx_projection SET
       tx_type = ?, amount = ?, happened_at = ?, note = ?,
       category_sync_id = ?, category_name = ?, category_kind = ?,
       account_sync_id = ?, account_name = ?,
       from_account_sync_id = ?, from_account_name = ?,
       to_account_sync_id = ?, to_account_name = ?,
       tags_csv = ?, tag_sync_ids_json = ?, attachments_json = ?,
       source_change_id = ?
       WHERE ledger_id = ? AND sync_id = ?`
    )
    .bind(
      newPayload.tx_type,
      newPayload.amount,
      newPayload.happened_at,
      newPayload.note,
      newPayload.category_id ?? null,
      newPayload.category_name ?? null,
      newPayload.category_kind ?? null,
      newPayload.account_id ?? null,
      newPayload.account_name ?? null,
      newPayload.from_account_id ?? null,
      newPayload.from_account_name ?? null,
      newPayload.to_account_id ?? null,
      newPayload.to_account_name ?? null,
      newPayload.tags ?? null,
      newPayload.tag_ids ? safeJsonStringify(newPayload.tag_ids) : null,
      newPayload.attachments ? safeJsonStringify(newPayload.attachments) : null,
      newChangeId,
      ledger.id,
      txSyncId,
    )
    .run();

  await insertAuditLog({
    db, userId, ledgerId: ledger.id, action: 'update', entityType: 'transaction', entityId: txSyncId,
    details: { fields_updated: Object.keys(newPayload).filter(k => newPayload[k] !== existingPayload[k]) },
  });

  return c.json({
    ledger_id: ledger.external_id,
    base_change_id: req.base_change_id,
    new_change_id: newChangeId,
    server_timestamp: serverNow,
    idempotency_replayed: false,
    entity_id: txSyncId,
  } as WriteCommitMeta);
});

// ---------------------------------------------------------------------------
// DELETE /write/transactions/:id - 删除交易
// ---------------------------------------------------------------------------

/**
 * 删除交易
 */
writeRouter.delete('/ledgers/:ledgerId/transactions/:id', zValidator('json', WriteBaseSchema), async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const txSyncId = c.req.param('id');
  const req = c.req.valid('json');
  const serverNow = nowUtc();

  const ledger = await db
    .prepare('SELECT id, external_id FROM ledgers WHERE user_id = ?')
    .bind(userId)
    .first<{ id: string; external_id: string }>();

  if (!ledger) {
    return c.json({ error: 'No ledger found' }, 400);
  }

  // 写入 SyncChange delete tombstone
  const changeResult = await db
    .prepare(
      `INSERT INTO sync_changes
       (user_id, ledger_id, entity_type, entity_sync_id, action, payload_json, updated_at, updated_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(userId, ledger.id, 'transaction', txSyncId, 'delete', '{}', serverNow, userId)
    .run();

  const newChangeId = changeResult.meta.last_row_id as number;

  // 从 projection 删除
  await db
    .prepare('DELETE FROM read_tx_projection WHERE ledger_id = ? AND sync_id = ?')
    .bind(ledger.id, txSyncId)
    .run();

  await insertAuditLog({
    db, userId, ledgerId: ledger.id, action: 'delete', entityType: 'transaction', entityId: txSyncId,
  });

  return c.json({
    ledger_id: ledger.external_id,
    base_change_id: req.base_change_id,
    new_change_id: newChangeId,
    server_timestamp: serverNow,
    idempotency_replayed: false,
    entity_id: txSyncId,
  } as WriteCommitMeta);
});

// ---------------------------------------------------------------------------
// POST /write/accounts - 创建账户
// ---------------------------------------------------------------------------

writeRouter.post('/ledgers/:ledgerId/accounts', zValidator('json', WriteAccountCreateSchema), async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const req = c.req.valid('json');
  const serverNow = nowUtc();

  const ledger = await db
    .prepare('SELECT id, external_id FROM ledgers WHERE user_id = ?')
    .bind(userId)
    .first<{ id: string; external_id: string }>();

  if (!ledger) {
    return c.json({ error: 'No ledger found' }, 400);
  }

  const syncId = randomUUID();
  const payload: Record<string, unknown> = {
    name: req.name,
    account_type: req.account_type ?? null,
    currency: req.currency ?? null,
    initial_balance: req.initial_balance ?? 0,
    note: req.note ?? null,
    credit_limit: req.credit_limit ?? null,
    billing_day: req.billing_day ?? null,
    payment_due_day: req.payment_due_day ?? null,
    bank_name: req.bank_name ?? null,
    card_last_four: req.card_last_four ?? null,
  };

  const changeResult = await db
    .prepare(
      `INSERT INTO sync_changes
       (user_id, ledger_id, entity_type, entity_sync_id, action, payload_json, updated_at, updated_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(userId, ledger.id, 'account', syncId, 'upsert', safeJsonStringify(payload), serverNow, userId)
    .run();

  const newChangeId = changeResult.meta.last_row_id as number;

  await db
    .prepare(
      `INSERT INTO read_account_projection
       (ledger_id, sync_id, user_id, name, account_type, currency, initial_balance,
        note, credit_limit, billing_day, payment_due_day, bank_name, card_last_four, source_change_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      ledger.id, syncId, userId, req.name, req.account_type ?? null,
      req.currency ?? null, req.initial_balance ?? 0, req.note ?? null,
      req.credit_limit ?? null, req.billing_day ?? null, req.payment_due_day ?? null,
      req.bank_name ?? null, req.card_last_four ?? null, newChangeId,
    )
    .run();

  await insertAuditLog({
    db, userId, ledgerId: ledger.id, action: 'create', entityType: 'account', entityId: syncId,
    details: { name: req.name },
  });

  return c.json({
    ledger_id: ledger.external_id,
    base_change_id: req.base_change_id,
    new_change_id: newChangeId,
    server_timestamp: serverNow,
    idempotency_replayed: false,
    entity_id: syncId,
  } as WriteCommitMeta);
});

// ---------------------------------------------------------------------------
// POST /write/categories - 创建分类
// ---------------------------------------------------------------------------

writeRouter.post('/ledgers/:ledgerId/categories', zValidator('json', WriteCategoryCreateSchema), async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const req = c.req.valid('json');
  const serverNow = nowUtc();

  const ledger = await db
    .prepare('SELECT id, external_id FROM ledgers WHERE user_id = ?')
    .bind(userId)
    .first<{ id: string; external_id: string }>();

  if (!ledger) {
    return c.json({ error: 'No ledger found' }, 400);
  }

  // 检查是否已存在同名同类型的分类
  const normalizedName = req.name.trim().toLowerCase();
  const normalizedKind = req.kind.trim().toLowerCase();
  
  const existingCategory = await db
    .prepare(
      `SELECT id, name, kind FROM read_category_projection 
       WHERE user_id = ? AND LOWER(name) = ? AND LOWER(kind) = ? LIMIT 1`
    )
    .bind(userId, normalizedName, normalizedKind)
    .first<{ id: string; name: string; kind: string }>();
  
  if (existingCategory) {
    return c.json({
      error: 'Category already exists',
      detail: `A category named "${existingCategory.name}" with kind "${existingCategory.kind}" already exists`,
      existing_id: existingCategory.id,
    }, 409);
  }

  const syncId = randomUUID();
  const payload: Record<string, unknown> = {
    name: req.name,
    kind: req.kind,
    level: req.level ?? null,
    sort_order: req.sort_order ?? null,
    icon: req.icon ?? null,
    icon_type: req.icon_type ?? null,
    custom_icon_path: req.custom_icon_path ?? null,
    icon_cloud_file_id: req.icon_cloud_file_id ?? null,
    icon_cloud_sha256: req.icon_cloud_sha256 ?? null,
    parent_name: req.parent_name ?? null,
  };

  const changeResult = await db
    .prepare(
      `INSERT INTO sync_changes
       (user_id, ledger_id, entity_type, entity_sync_id, action, payload_json, updated_at, updated_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(userId, ledger.id, 'category', syncId, 'upsert', safeJsonStringify(payload), serverNow, userId)
    .run();

  const newChangeId = changeResult.meta.last_row_id as number;

  await db
    .prepare(
      `INSERT INTO read_category_projection
       (ledger_id, sync_id, user_id, name, kind, level, sort_order,
        icon, icon_type, custom_icon_path, icon_cloud_file_id, icon_cloud_sha256,
        parent_name, source_change_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      ledger.id, syncId, userId, req.name, req.kind, req.level ?? null,
      req.sort_order ?? null, req.icon ?? null, req.icon_type ?? null,
      req.custom_icon_path ?? null, req.icon_cloud_file_id ?? null,
      req.icon_cloud_sha256 ?? null, req.parent_name ?? null, newChangeId,
    )
    .run();

  await insertAuditLog({
    db, userId, ledgerId: ledger.id, action: 'create', entityType: 'category', entityId: syncId,
    details: { name: req.name, kind: req.kind },
  });

  return c.json({
    ledger_id: ledger.external_id,
    base_change_id: req.base_change_id,
    new_change_id: newChangeId,
    server_timestamp: serverNow,
    idempotency_replayed: false,
    entity_id: syncId,
  } as WriteCommitMeta);
});

// ---------------------------------------------------------------------------
// PATCH /write/categories/:id - 更新分类
// ---------------------------------------------------------------------------

writeRouter.patch('/ledgers/:ledgerId/categories/:id', zValidator('json', WriteCategoryUpdateSchema), async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const req = c.req.valid('json');
  const serverNow = nowUtc();
  const categorySyncId = c.req.param('id');

  const ledger = await db
    .prepare('SELECT id, external_id FROM ledgers WHERE user_id = ?')
    .bind(userId)
    .first<{ id: string; external_id: string }>();

  if (!ledger) {
    return c.json({ error: 'No ledger found' }, 400);
  }

  const changeResult = await db
    .prepare(
      `INSERT INTO sync_changes
       (user_id, ledger_id, entity_type, entity_sync_id, action, payload_json, updated_at, updated_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(userId, ledger.id, 'category', categorySyncId, 'upsert', safeJsonStringify({
      name: req.name,
      kind: req.kind,
      level: req.level ?? null,
      sort_order: req.sort_order ?? null,
      icon: req.icon ?? null,
      icon_type: req.icon_type ?? null,
      custom_icon_path: req.custom_icon_path ?? null,
      icon_cloud_file_id: req.icon_cloud_file_id ?? null,
      icon_cloud_sha256: req.icon_cloud_sha256 ?? null,
      parent_name: req.parent_name ?? null,
    }), serverNow, userId)
    .run();

  const newChangeId = changeResult.meta.last_row_id as number;

  await db
    .prepare(
      `INSERT INTO read_category_projection
       (ledger_id, sync_id, user_id, name, kind, level, sort_order,
        icon, icon_type, custom_icon_path, icon_cloud_file_id, icon_cloud_sha256,
        parent_name, source_change_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(ledger_id, sync_id) DO UPDATE SET name = ?, kind = ?, level = ?, sort_order = ?,
        icon = ?, icon_type = ?, custom_icon_path = ?, icon_cloud_file_id = ?,
        icon_cloud_sha256 = ?, parent_name = ?, source_change_id = ?`
    )
    .bind(
      ledger.id, categorySyncId, userId, req.name, req.kind, req.level ?? null,
      req.sort_order ?? null, req.icon ?? null, req.icon_type ?? null,
      req.custom_icon_path ?? null, req.icon_cloud_file_id ?? null,
      req.icon_cloud_sha256 ?? null, req.parent_name ?? null, newChangeId,
      req.name, req.kind, req.level ?? null, req.sort_order ?? null,
      req.icon ?? null, req.icon_type ?? null, req.custom_icon_path ?? null,
      req.icon_cloud_file_id ?? null, req.icon_cloud_sha256 ?? null,
      req.parent_name ?? null, newChangeId,
    )
    .run();

  await insertAuditLog({
    db, userId, ledgerId: ledger.id, action: 'update', entityType: 'category', entityId: categorySyncId,
    details: { name: req.name },
  });

  return c.json({
    ledger_id: ledger.external_id,
    base_change_id: req.base_change_id,
    new_change_id: newChangeId,
    server_timestamp: serverNow,
    idempotency_replayed: false,
    entity_id: categorySyncId,
  } as WriteCommitMeta);
});

// ---------------------------------------------------------------------------
// DELETE /write/categories/:id - 删除分类
// ---------------------------------------------------------------------------

writeRouter.delete('/ledgers/:ledgerId/categories/:id', zValidator('json', WriteBaseSchema), async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const req = c.req.valid('json');
  const serverNow = nowUtc();
  const categorySyncId = c.req.param('id');

  const ledger = await db
    .prepare('SELECT id, external_id FROM ledgers WHERE user_id = ?')
    .bind(userId)
    .first<{ id: string; external_id: string }>();

  if (!ledger) {
    return c.json({ error: 'No ledger found' }, 400);
  }

  const changeResult = await db
    .prepare(
      `INSERT INTO sync_changes
       (user_id, ledger_id, entity_type, entity_sync_id, action, payload_json, updated_at, updated_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(userId, ledger.id, 'category', categorySyncId, 'delete', '{}', serverNow, userId)
    .run();

  const newChangeId = changeResult.meta.last_row_id as number;

  await db
    .prepare('DELETE FROM read_category_projection WHERE sync_id = ? AND ledger_id = ?')
    .bind(categorySyncId, ledger.id)
    .run();

  await insertAuditLog({
    db, userId, ledgerId: ledger.id, action: 'delete', entityType: 'category', entityId: categorySyncId,
  });

  return c.json({
    ledger_id: ledger.external_id,
    base_change_id: req.base_change_id,
    new_change_id: newChangeId,
    server_timestamp: serverNow,
    idempotency_replayed: false,
    entity_id: categorySyncId,
  } as WriteCommitMeta);
});

// ---------------------------------------------------------------------------
// POST /write/tags - 创建标签
// ---------------------------------------------------------------------------

writeRouter.post('/ledgers/:ledgerId/tags', zValidator('json', WriteTagCreateSchema), async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const req = c.req.valid('json');
  const serverNow = nowUtc();

  const ledger = await db
    .prepare('SELECT id, external_id FROM ledgers WHERE user_id = ?')
    .bind(userId)
    .first<{ id: string; external_id: string }>();

  if (!ledger) {
    return c.json({ error: 'No ledger found' }, 400);
  }

  const syncId = randomUUID();
  const payload: Record<string, unknown> = {
    name: req.name,
    color: req.color ?? null,
  };

  const changeResult = await db
    .prepare(
      `INSERT INTO sync_changes
       (user_id, ledger_id, entity_type, entity_sync_id, action, payload_json, updated_at, updated_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(userId, ledger.id, 'tag', syncId, 'upsert', safeJsonStringify(payload), serverNow, userId)
    .run();

  const newChangeId = changeResult.meta.last_row_id as number;

  await db
    .prepare(
      `INSERT INTO read_tag_projection
       (ledger_id, sync_id, user_id, name, color, source_change_id)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(ledger.id, syncId, userId, req.name, req.color ?? null, newChangeId)
    .run();

  await insertAuditLog({
    db, userId, ledgerId: ledger.id, action: 'create', entityType: 'tag', entityId: syncId,
    details: { name: req.name },
  });

  return c.json({
    ledger_id: ledger.external_id,
    base_change_id: req.base_change_id,
    new_change_id: newChangeId,
    server_timestamp: serverNow,
    idempotency_replayed: false,
    entity_id: syncId,
  } as WriteCommitMeta);
});

// ---------------------------------------------------------------------------
// POST /write/budgets - 创建预算
// ---------------------------------------------------------------------------

writeRouter.post('/ledgers/:ledgerId/budgets', zValidator('json', WriteBudgetCreateSchema), async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const req = c.req.valid('json');
  const serverNow = nowUtc();

  const ledger = await db
    .prepare('SELECT id, external_id FROM ledgers WHERE user_id = ?')
    .bind(userId)
    .first<{ id: string; external_id: string }>();

  if (!ledger) {
    return c.json({ error: 'No ledger found' }, 400);
  }

  const syncId = randomUUID();
  const payload: Record<string, unknown> = {
    budget_type: req.type,
    category_sync_id: req.category_id ?? null,
    amount: req.amount,
    period: req.period,
    start_day: req.start_day,
    enabled: req.enabled,
  };

  const changeResult = await db
    .prepare(
      `INSERT INTO sync_changes
       (user_id, ledger_id, entity_type, entity_sync_id, action, payload_json, updated_at, updated_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(userId, ledger.id, 'budget', syncId, 'upsert', safeJsonStringify(payload), serverNow, userId)
    .run();

  const newChangeId = changeResult.meta.last_row_id as number;

  await db
    .prepare(
      `INSERT INTO read_budget_projection
       (ledger_id, sync_id, user_id, budget_type, category_sync_id, amount,
        period, start_day, enabled, source_change_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      ledger.id, syncId, userId, req.type, req.category_id ?? null,
      req.amount, req.period, req.start_day, req.enabled ? 1 : 0, newChangeId,
    )
    .run();

  await insertAuditLog({
    db, userId, ledgerId: ledger.id, action: 'create', entityType: 'budget', entityId: syncId,
    details: { amount: req.amount, period: req.period },
  });

  return c.json({
    ledger_id: ledger.external_id,
    base_change_id: req.base_change_id,
    new_change_id: newChangeId,
    server_timestamp: serverNow,
    idempotency_replayed: false,
    entity_id: syncId,
  } as WriteCommitMeta);
});

// ---------------------------------------------------------------------------
// PATCH /write/budgets/:id - 更新预算
// ---------------------------------------------------------------------------

writeRouter.patch('/ledgers/:ledgerId/budgets/:id', zValidator('json', WriteBudgetUpdateSchema), async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const req = c.req.valid('json');
  const serverNow = nowUtc();
  const budgetSyncId = c.req.param('id');

  const ledger = await db
    .prepare('SELECT id, external_id FROM ledgers WHERE user_id = ?')
    .bind(userId)
    .first<{ id: string; external_id: string }>();

  if (!ledger) {
    return c.json({ error: 'No ledger found' }, 400);
  }

  const existingBudget = await db
    .prepare('SELECT budget_type, category_sync_id FROM read_budget_projection WHERE ledger_id = ? AND sync_id = ?')
    .bind(ledger.id, budgetSyncId)
    .first<{ budget_type: string; category_sync_id: string | null }>();

  if (!existingBudget) return c.json({ error: 'Budget not found' }, 404);

  const budgetType = existingBudget.budget_type;
  const categoryId = existingBudget.category_sync_id;
  const amount = req.amount ?? 0;
  const period = req.period ?? 'monthly';
  const startDay = req.start_day ?? 1;
  const enabled = req.enabled ?? true;

  const changeResult = await db
    .prepare(
      `INSERT INTO sync_changes
       (user_id, ledger_id, entity_type, entity_sync_id, action, payload_json, updated_at, updated_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(userId, ledger.id, 'budget', budgetSyncId, 'upsert', safeJsonStringify({
      budget_type: budgetType,
      category_sync_id: categoryId,
      amount,
      period,
      start_day: startDay,
      enabled,
    }), serverNow, userId)
    .run();

  const newChangeId = changeResult.meta.last_row_id as number;

  await db
    .prepare(
      `INSERT INTO read_budget_projection
       (ledger_id, sync_id, user_id, budget_type, category_sync_id, amount,
        period, start_day, enabled, source_change_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(ledger_id, sync_id) DO UPDATE SET budget_type = ?, category_sync_id = ?, amount = ?,
        period = ?, start_day = ?, enabled = ?, source_change_id = ?`
    )
    .bind(
      ledger.id, budgetSyncId, userId, budgetType, categoryId,
      amount, period, startDay, enabled ? 1 : 0, newChangeId,
      budgetType, categoryId, amount, period, startDay, enabled ? 1 : 0, newChangeId
    )
    .run();

  await insertAuditLog({
    db, userId, ledgerId: ledger.id, action: 'update', entityType: 'budget', entityId: budgetSyncId,
    details: { amount: req.amount },
  });

  return c.json({
    ledger_id: ledger.external_id,
    base_change_id: req.base_change_id,
    new_change_id: newChangeId,
    server_timestamp: serverNow,
    idempotency_replayed: false,
    entity_id: budgetSyncId,
  } as WriteCommitMeta);
});

// ---------------------------------------------------------------------------
// DELETE /write/budgets/:id - 删除预算
// ---------------------------------------------------------------------------

writeRouter.delete('/ledgers/:ledgerId/budgets/:id', zValidator('json', WriteBaseSchema), async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const req = c.req.valid('json');
  const serverNow = nowUtc();
  const budgetSyncId = c.req.param('id');

  const ledger = await db
    .prepare('SELECT id, external_id FROM ledgers WHERE user_id = ?')
    .bind(userId)
    .first<{ id: string; external_id: string }>();

  if (!ledger) {
    return c.json({ error: 'No ledger found' }, 400);
  }

  const changeResult = await db
    .prepare(
      `INSERT INTO sync_changes
       (user_id, ledger_id, entity_type, entity_sync_id, action, payload_json, updated_at, updated_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(userId, ledger.id, 'budget', budgetSyncId, 'delete', '{}', serverNow, userId)
    .run();

  const newChangeId = changeResult.meta.last_row_id as number;

  await db
    .prepare('DELETE FROM read_budget_projection WHERE sync_id = ? AND ledger_id = ?')
    .bind(budgetSyncId, ledger.id)
    .run();

  await insertAuditLog({
    db, userId, ledgerId: ledger.id, action: 'delete', entityType: 'budget', entityId: budgetSyncId,
  });

  return c.json({
    ledger_id: ledger.external_id,
    base_change_id: req.base_change_id,
    new_change_id: newChangeId,
    server_timestamp: serverNow,
    idempotency_replayed: false,
    entity_id: budgetSyncId,
  } as WriteCommitMeta);
});

// ---------------------------------------------------------------------------
// POST /write/categories/init-defaults - 创建默认分类
// ---------------------------------------------------------------------------

interface DefaultCategory {
  name: string;
  kind: 'expense' | 'income';
  level: number;
  sort_order: number;
  icon: string;
  children?: Array<{
    name: string;
    icon: string;
  }>;
}

const DEFAULT_CATEGORIES: DefaultCategory[] = [
  // 支出分类
  { name: '餐饮', kind: 'expense', level: 1, sort_order: 1, icon: '🍜', children: [
    { name: '一日三餐', icon: '🍚' },
    { name: '零食', icon: '🍪' },
    { name: '外卖', icon: '🛵' },
    { name: '聚餐', icon: '🍻' },
  ]},
  { name: '购物', kind: 'expense', level: 1, sort_order: 2, icon: '🛒', children: [
    { name: '日用品', icon: '🧴' },
    { name: '服装', icon: '👕' },
    { name: '数码', icon: '📱' },
    { name: '美妆', icon: '💄' },
  ]},
  { name: '交通', kind: 'expense', level: 1, sort_order: 3, icon: '🚗', children: [
    { name: '公交', icon: '🚌' },
    { name: '地铁', icon: '🚇' },
    { name: '打车', icon: '🚕' },
    { name: '加油', icon: '⛽' },
    { name: '停车', icon: '🅿️' },
  ]},
  { name: '居住', kind: 'expense', level: 1, sort_order: 4, icon: '🏠', children: [
    { name: '房租', icon: '🏦' },
    { name: '水电', icon: '💡' },
    { name: '物业', icon: '🏢' },
  ]},
  { name: '通讯', kind: 'expense', level: 1, sort_order: 5, icon: '📱', children: [
    { name: '话费', icon: '📞' },
    { name: '流量', icon: '📶' },
  ]},
  { name: '娱乐', kind: 'expense', level: 1, sort_order: 6, icon: '🎮', children: [
    { name: '电影', icon: '🎬' },
    { name: '音乐', icon: '🎵' },
    { name: '游戏', icon: '🎮' },
    { name: '旅游', icon: '✈️' },
  ]},
  { name: '医疗', kind: 'expense', level: 1, sort_order: 7, icon: '🏥', children: [
    { name: '门诊', icon: '🩺' },
    { name: '买药', icon: '💊' },
  ]},
  { name: '教育', kind: 'expense', level: 1, sort_order: 8, icon: '📚', children: [
    { name: '培训', icon: '🎓' },
    { name: '书籍', icon: '📖' },
  ]},
  { name: '金融', kind: 'expense', level: 1, sort_order: 9, icon: '💰', children: [
    { name: '手续费', icon: '💳' },
    { name: '利息', icon: '📊' },
  ]},
  { name: '保险', kind: 'expense', level: 1, sort_order: 10, icon: '🏛️', children: [
    { name: '医保', icon: '🏥' },
    { name: '车险', icon: '🚗' },
  ]},
  { name: '其他支出', kind: 'expense', level: 1, sort_order: 11, icon: '📦', children: [
    { name: '其他', icon: '❓' },
  ]},
  // 收入分类
  { name: '工资', kind: 'income', level: 1, sort_order: 21, icon: '💵', children: [
    { name: '基本工资', icon: '💰' },
    { name: '加班费', icon: '⏰' },
    { name: '补贴', icon: '🎁' },
  ]},
  { name: '奖金', kind: 'income', level: 1, sort_order: 22, icon: '🏆', children: [
    { name: '年终奖', icon: '🎊' },
    { name: '绩效', icon: '📈' },
  ]},
  { name: '投资', kind: 'income', level: 1, sort_order: 23, icon: '📈', children: [
    { name: '股票', icon: '📉' },
    { name: '基金', icon: '📊' },
    { name: '利息', icon: '💵' },
  ]},
  { name: '理财', kind: 'income', level: 1, sort_order: 24, icon: '💎', children: [
    { name: '理财收益', icon: '💰' },
  ]},
  { name: '兼职', kind: 'income', level: 1, sort_order: 25, icon: '💼', children: [
    { name: '外快', icon: '💵' },
  ]},
  { name: '礼金', kind: 'income', level: 1, sort_order: 26, icon: '🎁', children: [
    { name: '红包', icon: '🧧' },
    { name: '礼物', icon: '🎀' },
  ]},
  { name: '其他收入', kind: 'income', level: 1, sort_order: 27, icon: '💴', children: [
    { name: '其他', icon: '❓' },
  ]},
];

writeRouter.post('/categories/init-defaults', async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const serverNow = nowUtc();

  const ledger = await db
    .prepare('SELECT id, external_id FROM ledgers WHERE user_id = ?')
    .bind(userId)
    .first<{ id: string; external_id: string }>();

  if (!ledger) {
    return c.json({ error: 'No ledger found' }, 400);
  }

  const existingCategories = await db
    .prepare('SELECT name, kind FROM read_category_projection WHERE ledger_id = ? AND level = 1')
    .bind(ledger.id)
    .all<{ name: string; kind: string }>();

  const existingNames = new Set(existingCategories.results.map(c => `${c.kind}:${c.name}`));
  let createdCount = 0;
  const parentSyncIds: Record<string, string> = {};

  for (const cat of DEFAULT_CATEGORIES) {
    const key = `${cat.kind}:${cat.name}`;
    if (existingNames.has(key)) {
      continue;
    }

    const parentSyncId = randomUUID();
    parentSyncIds[cat.name] = parentSyncId;

    const payload: Record<string, unknown> = {
      name: cat.name,
      kind: cat.kind,
      level: 1,
      sort_order: cat.sort_order,
      icon: cat.icon,
      icon_type: 'emoji',
      parent_name: null,
    };

    await db
      .prepare(
        `INSERT INTO sync_changes
         (user_id, ledger_id, entity_type, entity_sync_id, action, payload_json, updated_at, updated_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(userId, ledger.id, 'category', parentSyncId, 'upsert', safeJsonStringify(payload), serverNow, userId)
      .run();

    await db
      .prepare(
        `INSERT INTO read_category_projection
         (ledger_id, sync_id, user_id, name, kind, level, sort_order,
          icon, icon_type, custom_icon_path, icon_cloud_file_id, icon_cloud_sha256,
          parent_name, source_change_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        ledger.id, parentSyncId, userId, cat.name, cat.kind, 1,
        cat.sort_order, cat.icon, 'emoji', null, null, null, null, 0,
      )
      .run();

    createdCount++;

    if (cat.children) {
      for (const child of cat.children) {
        const childSyncId = randomUUID();
        const childPayload: Record<string, unknown> = {
          name: child.name,
          kind: cat.kind,
          level: 2,
          sort_order: cat.sort_order * 100 + (cat.children.indexOf(child) + 1),
          icon: child.icon,
          icon_type: 'emoji',
          parent_name: cat.name,
        };

        await db
          .prepare(
            `INSERT INTO sync_changes
             (user_id, ledger_id, entity_type, entity_sync_id, action, payload_json, updated_at, updated_by_user_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(userId, ledger.id, 'category', childSyncId, 'upsert', safeJsonStringify(childPayload), serverNow, userId)
          .run();

        await db
          .prepare(
            `INSERT INTO read_category_projection
             (ledger_id, sync_id, user_id, name, kind, level, sort_order,
              icon, icon_type, custom_icon_path, icon_cloud_file_id, icon_cloud_sha256,
              parent_name, source_change_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(
            ledger.id, childSyncId, userId, child.name, cat.kind, 2,
            cat.sort_order * 100 + (cat.children.indexOf(child) + 1),
            child.icon, 'emoji', null, null, null, cat.name, 0,
          )
          .run();

        createdCount++;
      }
    }
  }

  await insertAuditLog({
    db, userId, ledgerId: ledger.id, action: 'init_defaults', entityType: 'category',
    details: { created_count: createdCount },
  });

  return c.json({
    success: true,
    message: `Created ${createdCount} default categories`,
    created_count: createdCount,
  });
});

writeRouter.get('/categories/defaults', async (c) => {
  return c.json({
    categories: DEFAULT_CATEGORIES,
  });
});

// ---------------------------------------------------------------------------
// PUT /write/exchange-rate-overrides - 设置汇率覆盖
// ---------------------------------------------------------------------------

const ExchangeRateSchema = z.object({
  base_currency: z.string().min(1),
  quote_currency: z.string().min(1),
  rate: z.string().or(z.number()),
});

writeRouter.put('/exchange-rate-overrides', zValidator('json', ExchangeRateSchema), async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const { base_currency, quote_currency, rate } = c.req.valid('json');
  const serverNow = nowUtc();

  const syncId = randomUUID();
  await db.prepare(`INSERT INTO sync_changes (user_id, ledger_id, entity_type, entity_sync_id, action, payload_json, updated_at, updated_by_user_id)
    VALUES (?, NULL, 'exchange_rate_override', ?, 'upsert', ?, ?, ?)`)
    .bind(userId, syncId, JSON.stringify({ base_currency, quote_currency, rate: String(rate) }), serverNow, userId).run();

  return c.json({ sync_id: syncId, base_currency, quote_currency, rate: String(rate) });
});

writeRouter.delete('/exchange-rate-overrides', async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const baseCurrency = c.req.query('base_currency');
  const quoteCurrency = c.req.query('quote_currency');
  const serverNow = nowUtc();

  if (!baseCurrency || !quoteCurrency) {
    return c.json({ error: 'base_currency and quote_currency are required' }, 400);
  }

  const syncId = randomUUID();
  await db.prepare(`INSERT INTO sync_changes (user_id, ledger_id, entity_type, entity_sync_id, action, payload_json, updated_at, updated_by_user_id)
    VALUES (?, NULL, 'exchange_rate_override', ?, 'delete', ?, ?, ?)`)
    .bind(userId, syncId, JSON.stringify({ base_currency: baseCurrency, quote_currency: quoteCurrency }), serverNow, userId).run();

  return c.json({ sync_id: syncId, base_currency: baseCurrency, quote_currency: quoteCurrency, rate: null });
});

export default writeRouter;
