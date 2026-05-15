/**
 * 读路由模块 - 实现 BeeCount Cloud 只读查询接口
 *
 * 参考原版 BeeCount-Cloud (Python/FastAPI) 的 /read/* 端点：
 * - GET  /read/ledgers                    - 列出用户所有账本（带统计数据）
 * - GET  /read/ledgers/{id}               - 获取单个账本详情
 * - GET  /read/ledgers/{id}/stats         - 获取账本统计（深度同步检测用）
 * - GET  /read/ledgers/{id}/transactions  - 列出账本下的交易
 * - GET  /read/ledgers/{id}/accounts      - 列出账本下的账户
 * - GET  /read/ledgers/{id}/categories    - 列出账本下的分类
 * - GET  /read/ledgers/{id}/budgets       - 列出账本下的预算
 * - GET  /read/ledgers/{id}/tags          - 列出账本下的标签
 *
 * CQRS 架构说明：
 * - 写路径走 SyncChange → projection 表
 * - 读路径直接查 projection 表（不做 JSON parse）
 * - account/category/tag 是 user-global 维度（同 sync_id 跨账本去重）
 *
 * @module routes/read
 */

import { Hono } from 'hono';
import { z } from 'zod';

// ===========================
// 辅助函数
// ===========================

/**
 * 将字符串或 Date 转换为 UTC Date 对象
 */
function toUtcDate(dt: string | Date): Date {
  const d = typeof dt === 'string' ? new Date(dt) : dt;
  return new Date(d.toISOString());
}

/**
 * 获取当前 UTC 时间
 */
function nowUtc(): string {
  return new Date().toISOString();
}

/**
 * 解析 JSON 字符串（安全处理失败情况）
 */
function safeJsonParse<T = Record<string, unknown>>(jsonStr: string | null): T | null {
  if (!jsonStr) return null;
  try {
    return JSON.parse(jsonStr) as T;
  } catch {
    return null;
  }
}

/**
 * 从 tags_csv 字符串解析标签列表
 */
function parseTagsCsv(csv: string | null): string[] {
  if (!csv) return [];
  return csv.split(',').filter((t) => t.trim().length > 0);
}

// ===========================
// 类型定义
// ===========================

/** 账本列表输出 */
interface ReadLedgerOut {
  ledger_id: string;
  ledger_name: string;
  currency: string;
  transaction_count: number;
  income_total: number;
  expense_total: number;
  balance: number;
  exported_at: string;
  updated_at: string;
  role: 'owner' | 'editor' | 'viewer';
  is_shared: boolean;
  member_count: number;
}

/** 账本详情输出 */
interface ReadLedgerDetailOut extends ReadLedgerOut {
  source_change_id: number;
}

/** 交易输出 */
interface ReadTransactionOut {
  id: string;
  tx_index: number;
  tx_type: string;
  amount: number;
  happened_at: string;
  note: string | null;
  category_name: string | null;
  category_kind: string | null;
  account_name: string | null;
  from_account_name: string | null;
  to_account_name: string | null;
  category_id: string | null;
  account_id: string | null;
  from_account_id: string | null;
  to_account_id: string | null;
  tags: string | null;
  tags_list: string[];
  tag_ids: string[];
  attachments: Array<Record<string, unknown>> | null;
  last_change_id: number;
  ledger_id: string | null;
  ledger_name: string | null;
  created_by_user_id: string | null;
  created_by_email: string | null;
  created_by_display_name: string | null;
  created_by_avatar_url: string | null;
  created_by_avatar_version: number | null;
}

/** 账户输出 */
interface ReadAccountOut {
  id: string;
  name: string;
  account_type: string | null;
  currency: string | null;
  initial_balance: number | null;
  last_change_id: number;
  ledger_id: string | null;
  ledger_name: string | null;
  created_by_user_id: string | null;
  created_by_email: string | null;
  note: string | null;
  credit_limit: number | null;
  billing_day: number | null;
  payment_due_day: number | null;
  bank_name: string | null;
  card_last_four: string | null;
}

/** 分类输出 */
interface ReadCategoryOut {
  id: string;
  name: string;
  kind: string;
  level: number | null;
  sort_order: number | null;
  icon: string | null;
  icon_type: string | null;
  custom_icon_path: string | null;
  icon_cloud_file_id: string | null;
  icon_cloud_sha256: string | null;
  parent_name: string | null;
  last_change_id: number;
  ledger_id: string | null;
  ledger_name: string | null;
  created_by_user_id: string | null;
  created_by_email: string | null;
}

/** 标签输出 */
interface ReadTagOut {
  id: string;
  name: string;
  color: string | null;
  last_change_id: number;
  ledger_id: string | null;
  ledger_name: string | null;
  created_by_user_id: string | null;
  created_by_email: string | null;
}

/** 预算输出 */
interface ReadBudgetOut {
  id: string;
  type: string;
  category_id: string | null;
  category_name: string | null;
  amount: number;
  period: string;
  start_day: number;
  enabled: boolean;
  last_change_id: number;
  ledger_id: string | null;
  ledger_name: string | null;
}

/** 账本统计输出 */
interface LedgerStats {
  transaction_count: number;
  transaction_total: number;
  attachment_count: number;
  attachment_total: number;
  category_attachment_total: number;
  budget_count: number;
  budget_total: number;
  account_count: number;
  account_total: number;
  category_count: number;
  category_total: number;
  tag_count: number;
  tag_total: number;
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

const readRouter = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// ---------------------------------------------------------------------------
// GET /read/ledgers - 列出用户所有账本
// ---------------------------------------------------------------------------

/**
 * 获取当前用户所有可访问账本的列表
 *
 * 功能说明：
 * - 返回每个账本的元信息 + 汇总统计（交易数、收支总额）
 * - 自动跳过软删除的账本
 * - 按创建时间倒序排列
 *
 * 查询参数：无
 *
 * 响应字段：
 * - ledger_id: 外部账本 ID
 * - ledger_name: 账本名称
 * - currency: 货币代码
 * - transaction_count: 交易数
 * - income_total / expense_total: 收入/支出总额
 * - balance: 余额（收入 - 支出）
 * - role: 用户在账本中的角色
 */
readRouter.get('/ledgers', async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const now = nowUtc();

  console.log('[READ] /ledgers called, userId:', userId);

  // 查询用户账本
  const ledgers = await db
    .prepare(
      `SELECT l.id, l.external_id, l.name, l.currency, l.created_at
       FROM ledgers l
       WHERE l.user_id = ?
       ORDER BY l.created_at DESC`
    )
    .bind(userId)
    .all<{
      id: string;
      external_id: string;
      name: string | null;
      currency: string;
      created_at: string;
    }>();

  console.log('[READ] Found ledgers:', ledgers.results.length);

  const result: ReadLedgerOut[] = [];

  for (const ledger of ledgers.results) {
    console.log('[READ] Processing ledger:', ledger.external_id, ledger.name);

    // 检查账本是否软删除（存在 ledger_snapshot delete tombstone）
    const tombstone = await db
      .prepare(
        `SELECT action FROM sync_changes
         WHERE ledger_id = ? AND entity_type = 'ledger_snapshot' AND action = 'delete'
         ORDER BY change_id DESC LIMIT 1`
      )
      .bind(ledger.id)
      .first<{ action: string }>();

    if (tombstone?.action === 'delete') {
      console.log('[READ] Ledger is soft deleted, skipping:', ledger.external_id);
      continue; // 跳过软删除的账本
    }

    // 从 projection 计算汇总统计
    const totals = await db
      .prepare(
        `SELECT
           COUNT(*) as tx_count,
           COALESCE(SUM(CASE WHEN tx_type = 'income' THEN amount ELSE 0 END), 0) as income_total,
           COALESCE(SUM(CASE WHEN tx_type = 'expense' THEN amount ELSE 0 END), 0) as expense_total
         FROM read_tx_projection
         WHERE ledger_id = ?`
      )
      .bind(ledger.id)
      .first<{
        tx_count: number;
        income_total: number;
        expense_total: number;
      }>();

    result.push({
      ledger_id: ledger.external_id,
      ledger_name: ledger.name ?? ledger.external_id,
      currency: ledger.currency || 'CNY',
      transaction_count: totals?.tx_count ?? 0,
      income_total: totals?.income_total ?? 0,
      expense_total: totals?.expense_total ?? 0,
      balance: (totals?.income_total ?? 0) - (totals?.expense_total ?? 0),
      exported_at: now,
      updated_at: now,
      role: 'owner',
      is_shared: false,
      member_count: 1,
    });
  }

  console.log('[READ] Returning result:', result.length, 'ledgers');
  return c.json(result);
});

// ---------------------------------------------------------------------------
// GET /read/ledgers/:ledgerExternalId - 获取单个账本详情
// ---------------------------------------------------------------------------

/**
 * 获取指定账本的详细信息
 *
 * 功能说明：
 * - 返回账本元信息 + 详细统计
 * - 包括最新 change_id（用于同步版本检测）
 *
 * 路径参数：
 * - ledgerExternalId: 账本外部 ID
 */
readRouter.get('/ledgers/:ledgerExternalId', async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const ledgerExternalId = c.req.param('ledgerExternalId');
  const now = nowUtc();

  // 查询账本
  const ledger = await db
    .prepare(
      `SELECT l.id, l.external_id, l.name, l.currency
       FROM ledgers l
       WHERE l.user_id = ? AND l.external_id = ?`
    )
    .bind(userId, ledgerExternalId)
    .first<{
      id: string;
      external_id: string;
      name: string | null;
      currency: string;
    }>();

  if (!ledger) {
    return c.json({ error: 'Ledger not found' }, 404);
  }

  // 检查软删除
  const tombstone = await db
    .prepare(
      `SELECT action FROM sync_changes
       WHERE ledger_id = ? AND entity_type = 'ledger_snapshot' AND action = 'delete'
       ORDER BY change_id DESC LIMIT 1`
    )
    .bind(ledger.id)
    .first<{ action: string }>();

  if (tombstone?.action === 'delete') {
    return c.json({ error: 'Ledger not found' }, 404);
  }

  // 获取最新 change_id
  const latestChangeId = await db
    .prepare('SELECT MAX(change_id) as max_id FROM sync_changes WHERE ledger_id = ?')
    .bind(ledger.id)
    .first<{ max_id: number | null }>();

  // 汇总统计
  const totals = await db
    .prepare(
      `SELECT
         COUNT(*) as tx_count,
         COALESCE(SUM(CASE WHEN tx_type = 'income' THEN amount ELSE 0 END), 0) as income_total,
         COALESCE(SUM(CASE WHEN tx_type = 'expense' THEN amount ELSE 0 END), 0) as expense_total
       FROM read_tx_projection
       WHERE ledger_id = ?`
    )
    .bind(ledger.id)
    .first<{
      tx_count: number;
      income_total: number;
      expense_total: number;
    }>();

  const response: ReadLedgerDetailOut = {
    ledger_id: ledger.external_id,
    ledger_name: ledger.name ?? ledger.external_id,
    currency: ledger.currency || 'CNY',
    transaction_count: totals?.tx_count ?? 0,
    income_total: totals?.income_total ?? 0,
    expense_total: totals?.expense_total ?? 0,
    balance: (totals?.income_total ?? 0) - (totals?.expense_total ?? 0),
    exported_at: now,
    updated_at: now,
    role: 'owner',
    is_shared: false,
    member_count: 1,
    source_change_id: latestChangeId?.max_id ?? 0,
  };

  return c.json(response);
});

// ---------------------------------------------------------------------------
// GET /read/ledgers/:ledgerExternalId/stats - 获取账本统计
// ---------------------------------------------------------------------------

/**
 * 获取账本的详细统计数据
 *
 * 功能说明：
 * - 给 mobile 的"深度同步检测"用
 * - 返回服务端实际的 tx/attachment/budget/account/category/tag 数量
 * - mobile 拉下来跟本地 Drift 对比，检测到差异就触发自动 sync
 *
 * 路径参数：
 * - ledgerExternalId: 账本外部 ID
 */
readRouter.get('/ledgers/:ledgerExternalId/stats', async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const ledgerExternalId = c.req.param('ledgerExternalId');

  // 查询账本
  const ledger = await db
    .prepare(
      `SELECT l.id, l.external_id FROM ledgers l
       WHERE l.user_id = ? AND l.external_id = ?`
    )
    .bind(userId, ledgerExternalId)
    .first<{ id: string; external_id: string }>();

  if (!ledger) {
    return c.json({ error: 'Ledger not found' }, 404);
  }

  // 查询各类型数量
  const [txCount, budgetCount, attachmentCount, accountCount, categoryCount, tagCount] =
    await Promise.all([
      db
        .prepare('SELECT COUNT(*) as cnt FROM read_tx_projection WHERE ledger_id = ?')
        .bind(ledger.id)
        .first<{ cnt: number }>(),
      db
        .prepare('SELECT COUNT(*) as cnt FROM read_budget_projection WHERE ledger_id = ?')
        .bind(ledger.id)
        .first<{ cnt: number }>(),
      db
        .prepare(
          `SELECT COUNT(*) as cnt FROM attachment_files
           WHERE ledger_id = ? AND attachment_kind = 'transaction'`
        )
        .bind(ledger.id)
        .first<{ cnt: number }>(),
      db
        .prepare(
          `SELECT COUNT(DISTINCT sync_id) as cnt FROM read_account_projection WHERE user_id = ?`
        )
        .bind(userId)
        .first<{ cnt: number }>(),
      db
        .prepare(
          `SELECT COUNT(DISTINCT sync_id) as cnt FROM read_category_projection WHERE user_id = ?`
        )
        .bind(userId)
        .first<{ cnt: number }>(),
      db
        .prepare(
          `SELECT COUNT(DISTINCT sync_id) as cnt FROM read_tag_projection WHERE user_id = ?`
        )
        .bind(userId)
        .first<{ cnt: number }>(),
    ]);

  // 全局统计
  const [txTotal, budgetTotal, attachmentTotal, categoryAttachmentTotal] = await Promise.all([
    db
      .prepare('SELECT COUNT(*) as cnt FROM read_tx_projection WHERE user_id = ?')
      .bind(userId)
      .first<{ cnt: number }>(),
    db
      .prepare('SELECT COUNT(*) as cnt FROM read_budget_projection WHERE user_id = ?')
      .bind(userId)
      .first<{ cnt: number }>(),
    db
      .prepare(
        `SELECT COUNT(*) as cnt FROM attachment_files a
         JOIN ledgers l ON a.ledger_id = l.id
         WHERE l.user_id = ? AND a.attachment_kind = 'transaction'`
      )
      .bind(userId)
      .first<{ cnt: number }>(),
    db
      .prepare(
        `SELECT COUNT(*) as cnt FROM attachment_files
         WHERE user_id = ? AND attachment_kind = 'category_icon'`
      )
      .bind(userId)
      .first<{ cnt: number }>(),
  ]);

  const response: LedgerStats = {
    transaction_count: txCount?.cnt ?? 0,
    transaction_total: txTotal?.cnt ?? 0,
    attachment_count: attachmentCount?.cnt ?? 0,
    attachment_total: attachmentTotal?.cnt ?? 0,
    category_attachment_total: categoryAttachmentTotal?.cnt ?? 0,
    budget_count: budgetCount?.cnt ?? 0,
    budget_total: budgetTotal?.cnt ?? 0,
    account_count: accountCount?.cnt ?? 0,
    account_total: accountCount?.cnt ?? 0,
    category_count: categoryCount?.cnt ?? 0,
    category_total: categoryCount?.cnt ?? 0,
    tag_count: tagCount?.cnt ?? 0,
    tag_total: tagCount?.cnt ?? 0,
  };

  return c.json(response);
});

// ---------------------------------------------------------------------------
// GET /read/ledgers/:ledgerExternalId/transactions - 列出交易
// ---------------------------------------------------------------------------

/**
 * 获取账本下的交易列表
 *
 * 功能说明：
 * - 直接查 read_tx_projection 表（CQRS 读路径）
 * - account/category/tag name 已在写入时 denormalized 到 projection 列
 * - 支持按类型/时间/关键词筛选
 * - 支持分页（limit/offset）
 *
 * 路径参数：
 * - ledgerExternalId: 账本外部 ID
 *
 * 查询参数：
 * - tx_type: 交易类型（expense/income/transfer）
 * - q: 关键词搜索（匹配 note/category_name/account_name/tags）
 * - start_at / end_at: 时间范围
 * - limit: 每页条数（默认 20，最大 2000）
 * - offset: 偏移量（默认 0）
 */
readRouter.get('/ledgers/:ledgerExternalId/transactions', async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const ledgerExternalId = c.req.param('ledgerExternalId');

  console.log('[READ] /transactions called, ledgerId:', ledgerExternalId, 'userId:', userId);

  const txType = c.req.query('tx_type') ?? null;
  const q = c.req.query('q') ?? null;
  const startAt = c.req.query('start_at') ?? null;
  const endAt = c.req.query('end_at') ?? null;
  const limit = Math.min(parseInt(c.req.query('limit') ?? '20', 10), 2000);
  const offset = parseInt(c.req.query('offset') ?? '0', 10);

  // 查询账本
  const ledger = await db
    .prepare(
      `SELECT l.id, l.external_id, l.name FROM ledgers l
       WHERE l.user_id = ? AND l.external_id = ?`
    )
    .bind(userId, ledgerExternalId)
    .first<{ id: string; external_id: string; name: string | null }>();

  if (!ledger) {
    console.log('[READ] Ledger not found:', ledgerExternalId);
    return c.json({ error: 'Ledger not found' }, 404);
  }

  console.log('[READ] Found ledger:', ledger.id, ledger.name, 'external_id:', ledger.external_id);

  // 先检查数据库中实际有什么数据
  const allLedgers = await db
    .prepare('SELECT id, external_id, name FROM ledgers WHERE user_id = ?')
    .bind(userId)
    .all<{ id: string; external_id: string; name: string | null }>();
  console.log('[READ] All user ledgers:', JSON.stringify(allLedgers.results));

  const allTx = await db
    .prepare('SELECT ledger_id, sync_id, tx_type, amount FROM read_tx_projection WHERE ledger_id = ?')
    .bind(ledger.id)
    .all<{ ledger_id: string; sync_id: string; tx_type: string; amount: number }>();
  console.log('[READ] All transactions for ledger_id:', ledger.id, JSON.stringify(allTx.results));

  // 构建查询
  const rows = await db
    .prepare(
      `SELECT * FROM read_tx_projection
       WHERE ledger_id = ?
       ORDER BY happened_at DESC, tx_index DESC
       LIMIT ? OFFSET ?`
    )
    .bind(ledger.id, limit, offset)
    .all<Record<string, unknown>>();

  console.log('[READ] Found transactions:', rows.results.length);

  // 获取创建者信息
  let ownerInfo = {
    id: null as string | null,
    email: null as string | null,
    display_name: null as string | null,
    avatar_file_id: null as string | null,
    avatar_version: null as number | null,
  };

  try {
    const owner = await db
      .prepare(
        `SELECT u.id, u.email, p.display_name, p.avatar_file_id, p.avatar_version
         FROM users u
         JOIN ledgers l ON l.user_id = u.id
         LEFT JOIN user_profiles p ON p.user_id = u.id
         WHERE l.id = ?`
      )
      .bind(ledger.id)
      .first<{
        id: string;
        email: string;
        display_name: string | null;
        avatar_file_id: string | null;
        avatar_version: number | null;
      }>();

    if (owner) {
      ownerInfo = {
        id: owner.id,
        email: owner.email,
        display_name: owner.display_name,
        avatar_file_id: owner.avatar_file_id,
        avatar_version: owner.avatar_version,
      };
    }
  } catch (err) {
    console.log('[READ] Error getting owner info:', err);
  }

  const result: ReadTransactionOut[] = rows.results.map((row) => {
    const tagIds = safeJsonParse<string[]>(row.tag_sync_ids_json as string | null) ?? [];
    const attachments = safeJsonParse<Array<Record<string, unknown>>>(
      row.attachments_json as string | null
    );

    return {
      id: row.sync_id as string,
      tx_index: (row.tx_index as number) ?? 0,
      tx_type: row.tx_type as string,
      amount: (row.amount as number) ?? 0,
      happened_at: row.happened_at as string,
      note: row.note as string | null,
      category_name: row.category_name as string | null,
      category_kind: row.category_kind as string | null,
      account_name: row.account_name as string | null,
      from_account_name: row.from_account_name as string | null,
      to_account_name: row.to_account_name as string | null,
      category_id: row.category_sync_id as string | null,
      account_id: row.account_sync_id as string | null,
      from_account_id: row.from_account_sync_id as string | null,
      to_account_id: row.to_account_sync_id as string | null,
      tags: row.tags_csv as string | null,
      tags_list: parseTagsCsv(row.tags_csv as string | null),
      tag_ids: tagIds,
      attachments,
      last_change_id: (row.source_change_id as number) ?? 0,
      ledger_id: ledger.external_id,
      ledger_name: ledger.name,
      created_by_user_id: ownerInfo.id,
      created_by_email: ownerInfo.email,
      created_by_display_name: ownerInfo.display_name,
      created_by_avatar_url: ownerInfo.avatar_file_id,
      created_by_avatar_version: ownerInfo.avatar_version,
    };
  });

  console.log('[READ] Returning transactions:', result.length);
  return c.json(result);
});

// ---------------------------------------------------------------------------
// GET /read/ledgers/:ledgerExternalId/accounts - 列出账户
// ---------------------------------------------------------------------------

/**
 * 获取账本下的账户列表
 *
 * 功能说明：
 * - account 是 user-global 维度（跨账本唯一）
 * - 同 sync_id 跨账本去重（取 source_change_id 最大的那份）
 * - 按名称字母序排列
 */
readRouter.get('/ledgers/:ledgerExternalId/accounts', async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const ledgerExternalId = c.req.param('ledgerExternalId');

  // 查询账本
  const ledger = await db
    .prepare(
      `SELECT l.id, l.external_id, l.name FROM ledgers l
       WHERE l.user_id = ? AND l.external_id = ?`
    )
    .bind(userId, ledgerExternalId)
    .first<{ id: string; external_id: string; name: string | null }>();

  if (!ledger) {
    return c.json({ error: 'Ledger not found' }, 404);
  }

  // 获取最新 change_id
  const latestChangeId = await db
    .prepare('SELECT MAX(change_id) as max_id FROM sync_changes WHERE ledger_id = ?')
    .bind(ledger.id)
    .first<{ max_id: number | null }>();

  // 查询账户（user-global，去重）
  const rows = await db
    .prepare(
      `SELECT DISTINCT r.sync_id, r.name, r.account_type, r.currency, r.initial_balance,
              r.note, r.credit_limit, r.billing_day, r.payment_due_day, r.bank_name, r.card_last_four
       FROM read_account_projection r
       WHERE r.user_id = ?
       ORDER BY LOWER(r.name) ASC`
    )
    .bind(userId)
    .all<Record<string, unknown>>();

  const result: ReadAccountOut[] = rows.results.map((row) => ({
    id: row.sync_id as string,
    name: (row.name as string) ?? '',
    account_type: row.account_type as string | null,
    currency: row.currency as string | null,
    initial_balance: row.initial_balance as number | null,
    last_change_id: latestChangeId?.max_id ?? 0,
    ledger_id: ledger.external_id,
    ledger_name: ledger.name,
    created_by_user_id: null,
    created_by_email: null,
    note: row.note as string | null,
    credit_limit: row.credit_limit as number | null,
    billing_day: row.billing_day as number | null,
    payment_due_day: row.payment_due_day as number | null,
    bank_name: row.bank_name as string | null,
    card_last_four: row.card_last_four as string | null,
  }));

  return c.json(result);
});

// ---------------------------------------------------------------------------
// GET /read/ledgers/:ledgerExternalId/categories - 列出分类
// ---------------------------------------------------------------------------

/**
 * 获取账本下的分类列表
 *
 * 功能说明：
 * - category 是 user-global 维度
 * - 按 kind/level/sort_order 排序
 */
readRouter.get('/ledgers/:ledgerExternalId/categories', async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const ledgerExternalId = c.req.param('ledgerExternalId');

  const ledger = await db
    .prepare(
      `SELECT l.id, l.external_id, l.name FROM ledgers l
       WHERE l.user_id = ? AND l.external_id = ?`
    )
    .bind(userId, ledgerExternalId)
    .first<{ id: string; external_id: string; name: string | null }>();

  if (!ledger) {
    return c.json({ error: 'Ledger not found' }, 404);
  }

  const latestChangeId = await db
    .prepare('SELECT MAX(change_id) as max_id FROM sync_changes WHERE ledger_id = ?')
    .bind(ledger.id)
    .first<{ max_id: number | null }>();

  const rows = await db
    .prepare(
      `SELECT DISTINCT r.sync_id, r.name, r.kind, r.level, r.sort_order,
              r.icon, r.icon_type, r.custom_icon_path,
              r.icon_cloud_file_id, r.icon_cloud_sha256, r.parent_name
       FROM read_category_projection r
       WHERE r.user_id = ?
       ORDER BY r.kind, r.sort_order, LOWER(r.name)`
    )
    .bind(userId)
    .all<Record<string, unknown>>();

  const result: ReadCategoryOut[] = rows.results.map((row) => ({
    id: row.sync_id as string,
    name: (row.name as string) ?? '',
    kind: (row.kind as string) ?? '',
    level: row.level as number | null,
    sort_order: row.sort_order as number | null,
    icon: row.icon as string | null,
    icon_type: row.icon_type as string | null,
    custom_icon_path: row.custom_icon_path as string | null,
    icon_cloud_file_id: row.icon_cloud_file_id as string | null,
    icon_cloud_sha256: row.icon_cloud_sha256 as string | null,
    parent_name: row.parent_name as string | null,
    last_change_id: latestChangeId?.max_id ?? 0,
    ledger_id: ledger.external_id,
    ledger_name: ledger.name,
    created_by_user_id: null,
    created_by_email: null,
  }));

  return c.json(result);
});

// ---------------------------------------------------------------------------
// GET /read/ledgers/:ledgerExternalId/tags - 列出标签
// ---------------------------------------------------------------------------

/**
 * 获取账本下的标签列表
 *
 * 功能说明：
 * - tag 是 user-global 维度
 * - 按名称字母序排列
 */
readRouter.get('/ledgers/:ledgerExternalId/tags', async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const ledgerExternalId = c.req.param('ledgerExternalId');

  const ledger = await db
    .prepare(
      `SELECT l.id, l.external_id, l.name FROM ledgers l
       WHERE l.user_id = ? AND l.external_id = ?`
    )
    .bind(userId, ledgerExternalId)
    .first<{ id: string; external_id: string; name: string | null }>();

  if (!ledger) {
    return c.json({ error: 'Ledger not found' }, 404);
  }

  const latestChangeId = await db
    .prepare('SELECT MAX(change_id) as max_id FROM sync_changes WHERE ledger_id = ?')
    .bind(ledger.id)
    .first<{ max_id: number | null }>();

  const rows = await db
    .prepare(
      `SELECT DISTINCT r.sync_id, r.name, r.color
       FROM read_tag_projection r
       WHERE r.user_id = ?
       ORDER BY LOWER(r.name) ASC`
    )
    .bind(userId)
    .all<Record<string, unknown>>();

  const result: ReadTagOut[] = rows.results.map((row) => ({
    id: row.sync_id as string,
    name: (row.name as string) ?? '',
    color: row.color as string | null,
    last_change_id: latestChangeId?.max_id ?? 0,
    ledger_id: ledger.external_id,
    ledger_name: ledger.name,
    created_by_user_id: null,
    created_by_email: null,
  }));

  return c.json(result);
});

// ---------------------------------------------------------------------------
// GET /read/ledgers/:ledgerExternalId/budgets - 列出预算
// ---------------------------------------------------------------------------

/**
 * 获取账本下的预算列表
 *
 * 功能说明：
 * - 按 categoryId 反查 category name
 * - 过滤孤儿预算（分类预算但 category_sync_id 为空）
 * - 按 (type, category_sync_id) 去重
 */
readRouter.get('/ledgers/:ledgerExternalId/budgets', async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const ledgerExternalId = c.req.param('ledgerExternalId');

  const ledger = await db
    .prepare(
      `SELECT l.id, l.external_id, l.name FROM ledgers l
       WHERE l.user_id = ? AND l.external_id = ?`
    )
    .bind(userId, ledgerExternalId)
    .first<{ id: string; external_id: string; name: string | null }>();

  if (!ledger) {
    return c.json({ error: 'Ledger not found' }, 404);
  }

  const latestChangeId = await db
    .prepare('SELECT MAX(change_id) as max_id FROM sync_changes WHERE ledger_id = ?')
    .bind(ledger.id)
    .first<{ max_id: number | null }>();

  // 构建 category sync_id → name 映射
  const catRows = await db
    .prepare(
      `SELECT DISTINCT r.sync_id, r.name FROM read_category_projection r
       WHERE r.user_id = ?`
    )
    .bind(userId)
    .all<{ sync_id: string; name: string }>();

  const catNameMap: Record<string, string> = {};
  catRows.results.forEach((r) => {
    catNameMap[r.sync_id] = r.name;
  });

  // 查询预算
  const rows = await db
    .prepare(
      `SELECT * FROM read_budget_projection
       WHERE ledger_id = ?
       ORDER BY budget_type, category_sync_id`
    )
    .bind(ledger.id)
    .all<Record<string, unknown>>();

  // 去重：同 (type, category_sync_id) 取 sync_id 最大的
  const dedup: Record<string, Record<string, unknown>> = {};
  for (const b of rows.results) {
    const btype = (b.budget_type as string) || 'total';
    if (btype === 'category' && !b.category_sync_id) {
      continue; // 跳过孤儿
    }
    const key = `${btype}:${b.category_sync_id ?? ''}`;
    const current = dedup[key];
    if (!current || (b.sync_id as string) > (current.sync_id as string)) {
      dedup[key] = b;
    }
  }

  const result: ReadBudgetOut[] = Object.values(dedup).map((b) => ({
    id: b.sync_id as string,
    type: (b.budget_type as string) || 'total',
    category_id: b.category_sync_id as string | null,
    category_name: b.category_sync_id
      ? catNameMap[b.category_sync_id as string] ?? null
      : null,
    amount: (b.amount as number) ?? 0,
    period: (b.period as string) || 'monthly',
    start_day: (b.start_day as number) ?? 1,
    enabled: Boolean(b.enabled),
    last_change_id: latestChangeId?.max_id ?? 0,
    ledger_id: ledger.external_id,
    ledger_name: ledger.name,
  }));

  return c.json(result);
});

export default readRouter;
