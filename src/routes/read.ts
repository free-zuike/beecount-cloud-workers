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
  month_start_day: number;
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
  exclude_from_stats: boolean;
  exclude_from_budget: boolean;
}

/** 账户输出 */
interface ReadAccountOut {
  id: string;
  name: string;
  account_type: string | null;
  currency: string | null;
  initial_balance: number | null;
  balance: number;
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

  // 查询用户账本（含共享账本，与原版 list_accessible_memberships 对齐）
  const ledgers = await db
    .prepare(
      `SELECT DISTINCT l.id, l.external_id, l.name, l.currency, l.created_at, l.month_start_day,
              COALESCE(lm.role, 'owner') as role
       FROM ledgers l
       LEFT JOIN ledger_members lm ON l.id = lm.ledger_id AND lm.user_id = ?
       WHERE l.user_id = ? OR lm.user_id = ?
       ORDER BY l.created_at DESC`
    )
    .bind(userId, userId, userId)
    .all<{
      id: string;
      external_id: string;
      name: string | null;
      currency: string;
      created_at: string;
      month_start_day: number | null;
      role: string;
    }>();

  console.log('[READ] Found ledgers:', ledgers.results.length);

  // 批量查询：软删除检查、收支汇总、成员数（避免 N+1）
  const ledgerIds = ledgers.results.map(l => l.id);
  const result: ReadLedgerOut[] = [];

  if (ledgerIds.length > 0) {
    const placeholders = ledgerIds.map(() => '?').join(',');

    // 1. 批量查软删除
    const tombstoneRows = await db.prepare(
      `SELECT ledger_id, action FROM sync_changes
       WHERE entity_type = 'ledger_snapshot' AND action = 'delete'
       AND ledger_id IN (${placeholders})
       GROUP BY ledger_id`
    ).bind(...ledgerIds).all<{ ledger_id: string; action: string }>();
    const tombstoneSet = new Set(tombstoneRows.results.map(r => r.ledger_id));

    // 2. 批量查收支汇总
    const totalsRows = await db.prepare(
      `SELECT ledger_id,
              COUNT(*) as tx_count,
              COALESCE(SUM(CASE WHEN tx_type = 'income' THEN amount ELSE 0 END), 0) as income_total,
              COALESCE(SUM(CASE WHEN tx_type = 'expense' THEN amount ELSE 0 END), 0) as expense_total
       FROM read_tx_projection WHERE ledger_id IN (${placeholders})
       GROUP BY ledger_id`
    ).bind(...ledgerIds).all<{ ledger_id: string; tx_count: number; income_total: number; expense_total: number }>();
    const totalsMap = new Map(totalsRows.results.map(r => [r.ledger_id, r]));

    // 3. 批量查成员数
    const memberRows = await db.prepare(
      `SELECT ledger_id, COUNT(*) as cnt FROM ledger_members
       WHERE ledger_id IN (${placeholders}) GROUP BY ledger_id`
    ).bind(...ledgerIds).all<{ ledger_id: string; cnt: number }>();
    const memberMap = new Map(memberRows.results.map(r => [r.ledger_id, r.cnt]));

    for (const ledger of ledgers.results) {
      if (tombstoneSet.has(ledger.id)) continue;

      const totals = totalsMap.get(ledger.id);
      const memberCount = memberMap.get(ledger.id) ?? 0;

      result.push({
        ledger_id: ledger.external_id,
        ledger_name: ledger.name ?? ledger.external_id,
        currency: ledger.currency || 'CNY',
        month_start_day: ledger.month_start_day ?? 1,
        transaction_count: totals?.tx_count ?? 0,
        income_total: totals?.income_total ?? 0,
        expense_total: totals?.expense_total ?? 0,
        balance: (totals?.income_total ?? 0) - (totals?.expense_total ?? 0),
        exported_at: now,
        updated_at: now,
        role: (ledger.role || 'owner') as 'owner' | 'editor' | 'viewer',
        is_shared: memberCount > 0,
        member_count: memberCount + 1,
      });
    }
  }

  console.log('[READ] Returning result:', result.length, 'ledgers');
  return c.json(result);
});

// ---------------------------------------------------------------------------
// GET /read/workspace/transactions - 获取工作区交易列表（年度报告使用）
// ---------------------------------------------------------------------------

async function ensureTxProjectionSynced(db: D1Database, userId: string): Promise<void> {
  const sample = await db
    .prepare('SELECT COUNT(*) as cnt FROM read_tx_projection WHERE user_id = ?')
    .bind(userId)
    .first<{ cnt: number }>();
  
  if (sample && sample.cnt > 0) return;
  
  console.log('[READ] read_tx_projection is empty, syncing from sync_changes...');
  
  const ledgers = await db
    .prepare('SELECT id FROM ledgers WHERE user_id = ?')
    .bind(userId)
    .all<{ id: string }>();
  
  for (const ledger of ledgers.results) {
    const changes = await db
      .prepare(
        `SELECT change_id, entity_type, entity_sync_id, action, payload_json, user_id, updated_at, updated_by_user_id
         FROM sync_changes 
         WHERE ledger_id = ? AND entity_type = 'transaction' AND action != 'delete'
         ORDER BY change_id ASC`
      )
      .bind(ledger.id)
      .all<{
        change_id: number;
        entity_type: string;
        entity_sync_id: string;
        action: string;
        payload_json: string;
        user_id: string;
        updated_at: string;
        updated_by_user_id: string | null;
      }>();
    
    for (const change of changes.results) {
      try {
        const payload = JSON.parse(change.payload_json);
        
        await db
          .prepare(
            `INSERT OR REPLACE INTO read_tx_projection
             (ledger_id, sync_id, user_id, tx_type, amount, happened_at, note,
              category_sync_id, category_name, category_kind,
              account_sync_id, account_name,
              from_account_sync_id, from_account_name,
              to_account_sync_id, to_account_name,
              tags_csv, tag_sync_ids_json, attachments_json, tx_index, source_change_id,
              created_at, created_by, created_by_user_id, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(
            ledger.id,
            change.entity_sync_id,
            change.user_id,
            payload.tx_type || 'expense',
            Math.round((payload.amount || 0) * 100),
            payload.happened_at || change.updated_at,
            payload.note || null,
            payload.category_sync_id || null,
            payload.category_name || null,
            payload.category_kind || null,
            payload.account_sync_id || null,
            payload.account_name || null,
            payload.from_account_sync_id || null,
            payload.from_account_name || null,
            payload.to_account_sync_id || null,
            payload.to_account_name || null,
            payload.tags ? payload.tags.join(',') : null,
            payload.tag_sync_ids ? JSON.stringify(payload.tag_sync_ids) : null,
            payload.attachments ? JSON.stringify(payload.attachments) : null,
            payload.tx_index ?? 0,
            change.change_id,
            change.updated_at,
            null,
            change.updated_by_user_id,
            change.updated_at,
          )
          .run();
      } catch (err) {
        console.error('[READ] Error syncing transaction:', change.entity_sync_id, err);
      }
    }
  }
  
  console.log('[READ] Sync completed');
}

readRouter.get('/workspace/transactions', async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;

  const ledgerId = c.req.query('ledger_id') ?? null;
  const filterUserId = c.req.query('user_id') ?? null;
  const txType = c.req.query('tx_type') ?? null;
  const accountName = c.req.query('account_name') ?? null;
  const q = c.req.query('q') ?? null;
  const txSyncId = c.req.query('tx_sync_id') ?? null;
  const tagSyncId = c.req.query('tag_sync_id') ?? null;
  const categorySyncId = c.req.query('category_sync_id') ?? null;
  const accountSyncId = c.req.query('account_sync_id') ?? null;
  const amountMin = c.req.query('amount_min') ? Number(c.req.query('amount_min')) : null;
  const amountMax = c.req.query('amount_max') ? Number(c.req.query('amount_max')) : null;
  const dateFrom = c.req.query('date_from') ?? null;
  const dateTo = c.req.query('date_to') ?? null;
  const limit = Math.min(parseInt(c.req.query('limit') ?? '200', 10), 5000);
  const offset = parseInt(c.req.query('offset') ?? '0', 10);

  console.log('[READ] /workspace/transactions called, ledgerId:', ledgerId, 'dateFrom:', dateFrom, 'dateTo:', dateTo, 'limit:', limit, 'offset:', offset);

  await ensureTxProjectionSynced(db, userId);

  let query = 'SELECT * FROM read_tx_projection WHERE user_id = ?';
  const bindings: (string | number)[] = [userId];

  if (ledgerId) {
    const ledger = await db
      .prepare('SELECT id FROM ledgers WHERE user_id = ? AND external_id = ?')
      .bind(userId, ledgerId)
      .first<{ id: string }>();
    
    if (ledger) {
      query += ' AND ledger_id = ?';
      bindings.push(ledger.id);
    }
  }

  if (dateFrom) {
    query += ' AND happened_at >= ?';
    bindings.push(dateFrom);
  }

  if (dateTo) {
    query += ' AND happened_at < ?';
    bindings.push(dateTo);
  }

  if (filterUserId) {
    query += ' AND user_id = ?';
    bindings.push(filterUserId);
  }
  if (txType) {
    query += ' AND tx_type = ?';
    bindings.push(txType);
  }
  if (categorySyncId) {
    query += ' AND category_sync_id = ?';
    bindings.push(categorySyncId);
  }
  if (accountSyncId) {
    query += ' AND account_sync_id = ?';
    bindings.push(accountSyncId);
  }
  if (amountMin !== null) {
    query += ' AND amount >= ?';
    bindings.push(amountMin);
  }
  if (amountMax !== null) {
    query += ' AND amount <= ?';
    bindings.push(amountMax);
  }
  if (q) {
    query += ' AND (note LIKE ? OR category_name LIKE ? OR account_name LIKE ?)';
    const like = `%${q}%`;
    bindings.push(like, like, like);
  }
  if (txSyncId) {
    query += ' AND sync_id = ?';
    bindings.push(txSyncId);
  }
  if (tagSyncId) {
    query += ' AND tag_sync_ids_json LIKE ?';
    bindings.push(`%"${tagSyncId}"%`);
  }
  if (accountName) {
    query += ' AND account_name = ?';
    bindings.push(accountName);
  }

  query += ' ORDER BY happened_at DESC LIMIT ? OFFSET ?';
  bindings.push(limit, offset);

  const rows = await db.prepare(query).bind(...bindings).all<Record<string, unknown>>();

  const items = rows.results.map((row) => {
    const tagIds = safeJsonParse<string[]>(row.tag_sync_ids_json as string | null) ?? [];
    const attachments = safeJsonParse<Array<Record<string, unknown>>>(
      row.attachments_json as string | null
    ) ?? [];

    return {
      id: (row.id as string) || (row.sync_id as string),
      sync_id: row.sync_id as string,
      ledger_id: row.ledger_id as string,
      tx_type: row.tx_type as string,
      amount: row.amount as number,
      happened_at: row.happened_at as string,
      note: row.note as string | null,
      tags_list: parseTagsCsv(row.tags_csv as string | null),
      attachments: attachments,
      account_id: row.account_id as string | null,
      account_name: row.account_name as string | null,
      category_id: row.category_id as string | null,
      category_sync_id: row.category_sync_id as string | null,
      category_name: row.category_name as string | null,
      category_kind: row.category_kind as string | null,
      created_at: row.created_at as string,
      created_by: row.created_by as string | null,
      created_by_user_id: row.created_by_user_id as string | null,
      created_by_avatar_url: null,
      updated_at: row.updated_at as string,
    };
  });

  return c.json({
    items,
    total: rows.results.length,
    limit,
    offset,
  });
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
      `SELECT l.id, l.external_id, l.name, l.currency, l.month_start_day
       FROM ledgers l
       WHERE l.user_id = ? AND l.external_id = ?`
    )
    .bind(userId, ledgerExternalId)
    .first<{
      id: string;
      external_id: string;
      name: string | null;
      currency: string;
      month_start_day: number;
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

  // 计算成员数
  const memberCount = await db
    .prepare('SELECT COUNT(*) as cnt FROM ledger_members WHERE ledger_id = ?')
    .bind(ledger.id)
    .first<{ cnt: number }>();
  const totalMembers = (memberCount?.cnt ?? 0) + 1;

  const response: ReadLedgerDetailOut = {
    ledger_id: ledger.external_id,
    ledger_name: ledger.name ?? ledger.external_id,
    currency: ledger.currency || 'CNY',
    month_start_day: ledger.month_start_day ?? 1,
    transaction_count: totals?.tx_count ?? 0,
    income_total: totals?.income_total ?? 0,
    expense_total: totals?.expense_total ?? 0,
    balance: (totals?.income_total ?? 0) - (totals?.expense_total ?? 0),
    exported_at: now,
    updated_at: now,
    role: 'owner',
    is_shared: totalMembers > 1,
    member_count: totalMembers,
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
        `SELECT COUNT(*) as cnt FROM read_category_projection
         WHERE user_id = ? AND icon_cloud_file_id IS NOT NULL AND icon_cloud_file_id != ''`
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
  let ledgerTxQuery = 'SELECT * FROM read_tx_projection WHERE ledger_id = ?';
  const ledgerTxBindings: (string | number)[] = [ledger.id];

  if (txType) {
    ledgerTxQuery += ' AND tx_type = ?';
    ledgerTxBindings.push(txType);
  }
  if (q) {
    ledgerTxQuery += ' AND (note LIKE ? OR category_name LIKE ? OR account_name LIKE ?)';
    const like = `%${q}%`;
    ledgerTxBindings.push(like, like, like);
  }
  if (startAt) {
    ledgerTxQuery += ' AND happened_at >= ?';
    ledgerTxBindings.push(startAt);
  }
  if (endAt) {
    ledgerTxQuery += ' AND happened_at <= ?';
    ledgerTxBindings.push(endAt);
  }

  ledgerTxQuery += ' ORDER BY happened_at DESC, tx_index DESC LIMIT ? OFFSET ?';
  ledgerTxBindings.push(limit, offset);

  const rows = await db
    .prepare(ledgerTxQuery)
    .bind(...ledgerTxBindings)
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
      exclude_from_stats: Boolean(row.exclude_from_stats),
      exclude_from_budget: Boolean(row.exclude_from_budget),
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

  // 查询账户（user-global，去重）并计算余额
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

  const result: ReadAccountOut[] = [];
  for (const row of rows.results) {
    const accountSyncId = row.sync_id as string;
    const initialBalance = (row.initial_balance as number) ?? 0;

    // 计算该账户关联的交易总额
    const txTotals = await db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN tx_type = 'income' AND account_sync_id = ? THEN amount ELSE 0 END), 0) as income_in,
           COALESCE(SUM(CASE WHEN tx_type = 'expense' AND account_sync_id = ? THEN amount ELSE 0 END), 0) as expense_in,
           COALESCE(SUM(CASE WHEN tx_type = 'transfer' AND to_account_sync_id = ? THEN amount ELSE 0 END), 0) as income_transfer,
           COALESCE(SUM(CASE WHEN tx_type = 'transfer' AND from_account_sync_id = ? THEN amount ELSE 0 END), 0) as expense_transfer
         FROM read_tx_projection
         WHERE ledger_id = ?`
      )
      .bind(accountSyncId, accountSyncId, accountSyncId, accountSyncId, ledger.id)
      .first<{ income_in: number; expense_in: number; income_transfer: number; expense_transfer: number }>();

    const balance = initialBalance
      + (txTotals?.income_in ?? 0)
      - (txTotals?.expense_in ?? 0)
      + (txTotals?.income_transfer ?? 0)
      - (txTotals?.expense_transfer ?? 0);

    result.push({
      id: accountSyncId,
      name: (row.name as string) ?? '',
      account_type: row.account_type as string | null,
      currency: row.currency as string | null,
      initial_balance: initialBalance,
      balance,
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
    });
  }

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

// GET /read/ledgers/:ledgerExternalId/budgets/usage - 预算使用情况
readRouter.get('/ledgers/:ledgerExternalId/budgets/usage', async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const ledgerExtId = c.req.param('ledgerExternalId');

  const ledger = await db
    .prepare('SELECT id, external_id FROM ledgers WHERE user_id = ? AND external_id = ?')
    .bind(userId, ledgerExtId)
    .first<{ id: string; external_id: string }>();
  if (!ledger) return c.json({ error: 'Ledger not found' }, 404);

  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const nextMonth = now.getMonth() === 11
    ? `${now.getFullYear() + 1}-01`
    : `${now.getFullYear()}-${String(now.getMonth() + 2).padStart(2, '0')}`;

  const budgets = await db
    .prepare('SELECT sync_id, category_sync_id, amount, period FROM read_budget_projection WHERE ledger_id = ? AND enabled = 1')
    .bind(ledger.id)
    .all<{ sync_id: string; category_sync_id: string | null; amount: number; period: string }>();

  const usage: Array<{
    budget_id: string;
    category_id: string | null;
    budget_amount: number;
    spent_amount: number;
    period: string;
  }> = [];

  for (const b of budgets.results) {
    let spent = 0;
    if (b.category_sync_id) {
      const row = await db
        .prepare(`SELECT COALESCE(SUM(amount), 0) as total FROM read_tx_projection
                   WHERE ledger_id = ? AND category_sync_id = ? AND tx_type = 'expense'
                   AND happened_at >= ? AND happened_at < ?`)
        .bind(ledger.id, b.category_sync_id, `${currentMonth}-01`, `${nextMonth}-01`)
        .first<{ total: number }>();
      spent = row?.total ?? 0;
    } else {
      const row = await db
        .prepare(`SELECT COALESCE(SUM(amount), 0) as total FROM read_tx_projection
                   WHERE ledger_id = ? AND tx_type = 'expense'
                   AND happened_at >= ? AND happened_at < ?`)
        .bind(ledger.id, `${currentMonth}-01`, `${nextMonth}-01`)
        .first<{ total: number }>();
      spent = row?.total ?? 0;
    }

    usage.push({
      budget_id: b.sync_id,
      category_id: b.category_sync_id,
      budget_amount: b.amount,
      spent_amount: spent,
      period: b.period,
    });
  }

  return c.json(usage);
});

// ---------------------------------------------------------------------------
// Workspace 聚合端点 - 跨账本查询
// ---------------------------------------------------------------------------
// 调试端点 - 查看数据库原始数据
// ---------------------------------------------------------------------------

/** 调试端点 - 查看所有账本 */
readRouter.get('/debug/ledgers', async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;

  const ledgers = await db
    .prepare('SELECT * FROM ledgers WHERE user_id = ?')
    .bind(userId)
    .all();

  // 为每个账本检查软删除状态
  const results = [];
  for (const ledger of ledgers.results) {
    const tombstone = await db
      .prepare(
        `SELECT action FROM sync_changes
         WHERE ledger_id = ? AND entity_type = 'ledger_snapshot' AND action = 'delete'
         ORDER BY change_id DESC LIMIT 1`
      )
      .bind(ledger.id)
      .first<{ action: string }>();

    results.push({
      ...ledger,
      is_soft_deleted: !!tombstone?.action
    });
  }

  return c.json({ ledgers: results });
});

/** 调试端点 - 查看所有交易 */
readRouter.get('/debug/transactions', async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;

  const ledgers = await db
    .prepare('SELECT id FROM ledgers WHERE user_id = ?')
    .bind(userId)
    .all();

  const ledgerIds = ledgers.results.map((l: any) => l.id);

  if (ledgerIds.length === 0) {
    return c.json({ transactions: [] });
  }

  const placeholders = ledgerIds.map(() => '?').join(',');
  const transactions = await db
    .prepare(`SELECT * FROM read_tx_projection WHERE ledger_id IN (${placeholders})`)
    .bind(...ledgerIds)
    .all();

  return c.json({ transactions: transactions.results });
});

// ---------------------------------------------------------------------------
// GET /read/exchange-rate-overrides - 列出用户的汇率覆盖
// ---------------------------------------------------------------------------

readRouter.get('/exchange-rate-overrides', async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;

  const rows = await db
    .prepare(
      `SELECT sync_id, base_currency, quote_currency, rate, updated_at
       FROM exchange_rate_overrides
       WHERE user_id = ?
       ORDER BY quote_currency, sync_id`
    )
    .bind(userId)
    .all<{ sync_id: string; base_currency: string; quote_currency: string; rate: string; updated_at: string }>();

  return c.json(rows.results.map(r => ({
    sync_id: r.sync_id,
    base_currency: r.base_currency,
    quote_currency: r.quote_currency,
    rate: r.rate,
    updated_at: r.updated_at,
  })));
});

// ---------------------------------------------------------------------------
// GET /read/exchange-rates - 获取实时汇率
// ---------------------------------------------------------------------------

readRouter.get('/exchange-rates', async (c) => {
  const base = c.req.query('base');
  if (!base || !/^[A-Za-z]{3,8}$/.test(base)) {
    return c.json({ error: 'Invalid base currency' }, 400);
  }

  try {
    // 从外部 API 获取汇率
    const response = await fetch(`https://api.exchangerate-api.com/v4/latest/${base}`);
    if (!response.ok) {
      return c.json({ error: 'Failed to fetch rates' }, 502);
    }
    const data = await response.json() as { rates: Record<string, number>; date: string };

    return c.json({
      base: base.toUpperCase(),
      rate_date: data.date,
      source: 'exchangerate-api.com',
      fetched_at: new Date().toISOString(),
      stale: false,
      rates: Object.fromEntries(
        Object.entries(data.rates).map(([k, v]) => [k, String(v)])
      ),
    });
  } catch (error) {
    return c.json({ error: 'Exchange rate fetch failed' }, 502);
  }
});

/** 调试端点 - 查看所有同步变更 */
readRouter.get('/debug/sync-changes', async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;

  const changes = await db
    .prepare('SELECT * FROM sync_changes WHERE user_id = ? ORDER BY change_id DESC LIMIT 50')
    .bind(userId)
    .all();

  return c.json({ changes: changes.results });
});

export default readRouter;
