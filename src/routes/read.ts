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

import { normalizeTransactionAccounts } from '../lib/transaction-normalization';
import { serverLogger } from '../lib/logger';
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
  currency_code: string | null;
  native_amount: number | null;
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
  hidden: boolean;
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
  NODE_ENV?: string;
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

  serverLogger.info('src.routers.read', '[READ] /ledgers called, userId:', userId);

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

  serverLogger.info('src.routers.read', '[READ] Found ledgers:', ledgers.results.length);

  // 批量查询：软删除检查、收支汇总、成员数（避免 N+1）
  const ledgerIds = ledgers.results.map(l => l.id);
  const result: ReadLedgerOut[] = [];

  if (ledgerIds.length > 0) {
    const placeholders = ledgerIds.map(() => '?').join(',');

    // 1. 批量查软删除:按「最新 ledger_snapshot 动作」判定(删后重建的账本不应被误隐藏,
    //   对齐上游 _is_ledger_deleted)
    const tombstoneRows = await db.prepare(
      `SELECT ledger_id, action FROM sync_changes sc
       WHERE entity_type = 'ledger_snapshot'
         AND ledger_id IN (${placeholders})
         AND change_id = (SELECT MAX(sc2.change_id) FROM sync_changes sc2
                          WHERE sc2.ledger_id = sc.ledger_id AND sc2.entity_type = 'ledger_snapshot')`
    ).bind(...ledgerIds).all<{ ledger_id: string; action: string }>();
    const tombstoneSet = new Set(
      tombstoneRows.results.filter(r => r.action === 'delete').map(r => r.ledger_id)
    );

    // 2. 批量查收支汇总(对齐上游 _projection_totals:tx_count 含标记笔,
    //   income/expense 排除标记笔,balance_all 含标记笔,native_amount 回退 amount)
    const totalsRows = await db.prepare(
      `SELECT ledger_id,
              COUNT(*) as tx_count,
              COALESCE(SUM(CASE WHEN tx_type = 'income' AND (exclude_from_stats IS NULL OR exclude_from_stats = 0 OR exclude_from_stats = false) THEN COALESCE(native_amount, amount) ELSE 0 END), 0) as income_total,
              COALESCE(SUM(CASE WHEN tx_type = 'expense' AND (exclude_from_stats IS NULL OR exclude_from_stats = 0 OR exclude_from_stats = false) THEN COALESCE(native_amount, amount) ELSE 0 END), 0) as expense_total,
              COALESCE(SUM(CASE WHEN tx_type = 'income' THEN COALESCE(native_amount, amount) WHEN tx_type = 'expense' THEN -COALESCE(native_amount, amount) ELSE 0 END), 0) as balance_all
       FROM read_tx_projection WHERE ledger_id IN (${placeholders})
       GROUP BY ledger_id`
    ).bind(...ledgerIds).all<{ ledger_id: string; tx_count: number; income_total: number; expense_total: number; balance_all: number }>();
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
        balance: totals?.balance_all ?? 0,
        exported_at: now,
        updated_at: now,
        role: (ledger.role || 'owner') as 'owner' | 'editor' | 'viewer',
        is_shared: memberCount > 1,
        member_count: memberCount,
      });
    }
  }

  serverLogger.info('src.routers.read', '[READ] Returning result:', result.length, 'ledgers');
  return c.json(result);
});

// ---------------------------------------------------------------------------
// GET /read/workspace/transactions - 获取工作区交易列表（年度报告使用）
// ---------------------------------------------------------------------------

async function ensureTxProjectionSynced(db: D1Database, userId: string): Promise<void> {
  if (!userId) { console.error('[DEBUG] ensureTxProjectionSynced called with undefined userId'); return; }
  const sample = await db
    .prepare('SELECT COUNT(*) as cnt FROM read_tx_projection WHERE user_id = ?')
    .bind(userId)
    .first<{ cnt: number }>();
  
  if (sample && sample.cnt > 0) return;
  
  serverLogger.info('src.routers.read', '[READ] read_tx_projection is empty, syncing from sync_changes...');
  
  const ledgers = await db
    .prepare('SELECT id, external_id FROM ledgers WHERE user_id = ?')
    .bind(userId)
    .all<{ id: string; external_id: string }>();
  
  for (const ledger of ledgers.results) {
    const changes = await db
      .prepare(
        `SELECT change_id, entity_type, entity_sync_id, action, payload_json, user_id, updated_at, updated_by_user_id
         FROM sync_changes 
         WHERE (ledger_id = ? OR ledger_id = ?) AND entity_type = 'transaction' AND action != 'delete'
         ORDER BY change_id ASC`
      )
      .bind(ledger.id, ledger.external_id)
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

        // 与原版 transaction_normalization 对齐：重建投影同口径清空无效账户列
        const txAccountCols = normalizeTransactionAccounts(
          payload.tx_type ?? payload.txType ?? payload.type,
          {
            account_sync_id: payload.account_sync_id ?? payload.accountId ?? null,
            account_name: payload.account_name ?? payload.accountName ?? null,
            from_account_sync_id: payload.from_account_sync_id ?? payload.fromAccountId ?? null,
            from_account_name: payload.from_account_name ?? payload.fromAccountName ?? null,
            to_account_sync_id: payload.to_account_sync_id ?? payload.toAccountId ?? null,
            to_account_name: payload.to_account_name ?? payload.toAccountName ?? null,
          },
        );

        await db
          .prepare(
            `INSERT OR REPLACE INTO read_tx_projection
             (ledger_id, sync_id, user_id, tx_type, amount, happened_at, note,
              category_sync_id, category_name, category_kind,
              account_sync_id, account_name,
              from_account_sync_id, from_account_name,
              to_account_sync_id, to_account_name,
              tags_csv, tag_sync_ids_json, attachments_json, tx_index, source_change_id,
              created_by_user_id, last_edited_by_user_id,
              exclude_from_stats, exclude_from_budget,
              currency_code, native_amount)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(
            ledger.id,
            change.entity_sync_id,
            change.user_id,
            payload.tx_type || 'expense',
            payload.amount || 0,
            payload.happened_at || payload.happenedAt || change.updated_at,
            payload.note || null,
            payload.category_sync_id ?? payload.categoryId ?? null,
            payload.category_name ?? payload.categoryName ?? null,
            payload.category_kind ?? payload.categoryKind ?? null,
            txAccountCols.account_sync_id,
            txAccountCols.account_name,
            txAccountCols.from_account_sync_id,
            txAccountCols.from_account_name,
            txAccountCols.to_account_sync_id,
            txAccountCols.to_account_name,
            payload.tags ? (Array.isArray(payload.tags) ? payload.tags.join(',') : String(payload.tags)) : null,
            payload.tag_sync_ids ?? payload.tagIds ? JSON.stringify(payload.tag_sync_ids ?? payload.tagIds) : null,
            payload.attachments ? JSON.stringify(payload.attachments) : null,
            payload.tx_index ?? 0,
            change.change_id,
            change.updated_by_user_id ?? null,
            change.updated_by_user_id ?? null,
            payload.excludeFromStats != null ? (payload.excludeFromStats ? 1 : 0) : null,
            payload.excludeFromBudget != null ? (payload.excludeFromBudget ? 1 : 0) : null,
            payload.currency_code ?? payload.currencyCode ?? null,
            payload.native_amount ?? payload.nativeAmount ?? null,
          )
          .run();
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        serverLogger.error('src.routers.read', `[READ] Error syncing transaction ${change.entity_sync_id}: ${errorMsg}`);
      }
    }
  }
  
  serverLogger.info('src.routers.read', '[READ] Sync completed');
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
  const limit = Math.min(parseInt(c.req.query('limit') ?? '20', 10), 2000); // 对齐上游默认 20
  const offset = parseInt(c.req.query('offset') ?? '0', 10);

  serverLogger.info('src.routers.read', '[READ] /workspace/transactions called, ledgerId:', ledgerId, 'dateFrom:', dateFrom, 'dateTo:', dateTo, 'limit:', limit, 'offset:', offset);

  await ensureTxProjectionSynced(db, userId);

  let query = 'SELECT rt.*, l.external_id AS ledger_external_id FROM read_tx_projection rt LEFT JOIN ledgers l ON rt.ledger_id = l.id';
  const bindings: (string | number)[] = [];

  if (ledgerId) {
    // 支持共享账本 — 与原版 _visible_workspace_ledgers 对齐(排除软删账本)
    let ledger = await db
      .prepare(`SELECT id FROM ledgers WHERE user_id = ? AND external_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM sync_changes sc
          WHERE sc.ledger_id = ledgers.id AND sc.entity_type = 'ledger_snapshot'
            AND sc.action = 'delete'
            AND sc.change_id = (SELECT MAX(sc2.change_id) FROM sync_changes sc2
                                WHERE sc2.ledger_id = ledgers.id AND sc2.entity_type = 'ledger_snapshot')
        )`)
      .bind(userId, ledgerId)
      .first<{ id: string }>();
    if (!ledger) {
      ledger = await db
        .prepare(`SELECT l.id FROM ledgers l JOIN ledger_members lm ON l.id = lm.ledger_id WHERE lm.user_id = ? AND l.external_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM sync_changes sc
            WHERE sc.ledger_id = l.id AND sc.entity_type = 'ledger_snapshot'
              AND sc.action = 'delete'
              AND sc.change_id = (SELECT MAX(sc2.change_id) FROM sync_changes sc2
                                  WHERE sc2.ledger_id = l.id AND sc2.entity_type = 'ledger_snapshot')
          )`)
        .bind(userId, ledgerId)
        .first<{ id: string }>();
    }
    if (ledger) {
      query += ' WHERE rt.ledger_id = ?';
      bindings.push(ledger.id);
    } else {
      return c.json({ items: [], total: 0, limit, offset });
    }
  } else {
    query += ' WHERE rt.user_id = ?';
    bindings.push(userId);

    // 无 ledgerId 过滤时，查询用户可访问的所有账本(排除软删)
    const accessibleIds = await db.prepare(
      `SELECT l.id FROM ledgers l WHERE l.user_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM sync_changes sc
           WHERE sc.ledger_id = l.id AND sc.entity_type = 'ledger_snapshot'
             AND sc.action = 'delete'
             AND sc.change_id = (SELECT MAX(sc2.change_id) FROM sync_changes sc2
                                 WHERE sc2.ledger_id = l.id AND sc2.entity_type = 'ledger_snapshot')
         )
       UNION
       SELECT lm.ledger_id FROM ledger_members lm WHERE lm.user_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM sync_changes sc
           WHERE sc.ledger_id = lm.ledger_id AND sc.entity_type = 'ledger_snapshot'
             AND sc.action = 'delete'
             AND sc.change_id = (SELECT MAX(sc2.change_id) FROM sync_changes sc2
                                 WHERE sc2.ledger_id = lm.ledger_id AND sc2.entity_type = 'ledger_snapshot')
         )`
    ).bind(userId, userId).all<{ id: string }>();
    if (accessibleIds.results.length === 0) {
      return c.json({ items: [], total: 0, limit, offset });
    }
    const ids = accessibleIds.results.map(r => r.id);
    query += ` AND rt.ledger_id IN (${ids.map(() => '?').join(',')})`;
    bindings.push(...ids);
  }

  if (dateFrom) {
    query += ' AND rt.happened_at >= ?';
    bindings.push(dateFrom);
  }

  if (dateTo) {
    query += ' AND rt.happened_at < ?';
    bindings.push(dateTo);
  }

  if (filterUserId) {
    query += ' AND rt.user_id = ?';
    bindings.push(filterUserId);
  }
  if (txType) {
    query += ' AND rt.tx_type = ?';
    bindings.push(txType);
  }
  if (categorySyncId) {
    query += ' AND rt.category_sync_id = ?';
    bindings.push(categorySyncId);
  }
  if (accountSyncId) {
    // Account detail must include both ordinary transactions and transfers.
    // Transfers deliberately keep account_sync_id NULL and use from/to account ids.
    query += ' AND (rt.account_sync_id = ? OR rt.from_account_sync_id = ? OR rt.to_account_sync_id = ?)';
    bindings.push(accountSyncId, accountSyncId, accountSyncId);
  }
  if (amountMin !== null) {
    query += ' AND rt.amount >= ?';
    bindings.push(amountMin);
  }
  if (amountMax !== null) {
    query += ' AND rt.amount <= ?';
    bindings.push(amountMax);
  }
  if (q) {
    query += ' AND (rt.note LIKE ? OR rt.category_name LIKE ? OR rt.account_name LIKE ? OR rt.from_account_name LIKE ? OR rt.to_account_name LIKE ? OR rt.tags_csv LIKE ?)';
    const like = `%${q}%`;
    bindings.push(like, like, like, like, like, like);
  }
  if (txSyncId) {
    query += ' AND rt.sync_id = ?';
    bindings.push(txSyncId);
  }
  if (tagSyncId) {
    query += ' AND rt.tag_sync_ids_json LIKE ? ESCAPE ?';
    const escapedTag = tagSyncId.replace(/%/g, '\\%').replace(/_/g, '\\_');
    bindings.push(`%"${escapedTag}"%`, '\\');
  }
  if (accountName) {
    query += ` AND (rt.account_name LIKE ? OR rt.from_account_name LIKE ? OR rt.to_account_name LIKE ?)`;
    const pattern = `%${accountName}%`;
    bindings.push(pattern, pattern, pattern);
  }

  query += ' ORDER BY rt.happened_at DESC, rt.tx_index DESC LIMIT ? OFFSET ?'; // 对齐上游二级排序
  bindings.push(limit, offset);

  const rows = await db.prepare(query).bind(...bindings).all<Record<string, unknown>>();

  // 查询真实总数（与原版对齐）— 移除 ORDER BY/LIMIT/OFFSET
  const countQuery = query.replace(/ORDER BY.*$/, '');
  const countBindings = bindings.slice(0, -2); // 去掉最后的 limit 和 offset
  const totalResult = await db.prepare(`SELECT COUNT(*) as cnt FROM (${countQuery})`).bind(...countBindings).first<{ cnt: number }>();

  // 共享账本 §7:收集创建者/编辑者 + 账本 owner,一次查 users/user_profiles(对齐上游 user_info_map)
  const txLedgerIds = [...new Set(rows.results.map((r) => r.ledger_id as string).filter(Boolean))];
  const actorUids = new Set<string>();
  for (const r of rows.results) {
    if (r.created_by_user_id) actorUids.add(r.created_by_user_id as string);
    if (r.last_edited_by_user_id) actorUids.add(r.last_edited_by_user_id as string);
  }
  const ledgerInfoMap = new Map<string, { external_id: string; name: string | null; owner_uid: string }>();
  const userInfoMap = new Map<string, { email: string | null; display_name: string | null; avatar_file_id: string | null; avatar_version: number | null }>();
  const changeIdMap = new Map<string, number>();

  if (txLedgerIds.length > 0) {
    const ph = txLedgerIds.map(() => '?').join(',');
    const ledgerRows = await db
      .prepare(`SELECT id, external_id, name, user_id FROM ledgers WHERE id IN (${ph})`)
      .bind(...txLedgerIds)
      .all<{ id: string; external_id: string; name: string | null; user_id: string }>();
    for (const l of ledgerRows.results) {
      ledgerInfoMap.set(l.id, { external_id: l.external_id, name: l.name, owner_uid: l.user_id });
      if (l.user_id) actorUids.add(l.user_id);
    }

    if (actorUids.size > 0) {
      const ph2 = [...actorUids].map(() => '?').join(',');
      const userRows = await db
        .prepare(`SELECT u.id, u.email, p.display_name, p.avatar_file_id, p.avatar_version
                   FROM users u LEFT JOIN user_profiles p ON p.user_id = u.id
                   WHERE u.id IN (${ph2})`)
        .bind(...actorUids)
        .all<{ id: string; email: string | null; display_name: string | null; avatar_file_id: string | null; avatar_version: number | null }>();
      for (const u of userRows.results) {
        userInfoMap.set(u.id, { email: u.email, display_name: u.display_name, avatar_file_id: u.avatar_file_id, avatar_version: u.avatar_version });
      }
    }

    // 每账本最新 change_id(上游 per-tx last_change_id)
    const cidRows = await db
      .prepare(`SELECT ledger_id, MAX(change_id) as m FROM sync_changes WHERE ledger_id IN (${ph}) GROUP BY ledger_id`)
      .bind(...txLedgerIds)
      .all<{ ledger_id: string; m: number }>();
    for (const r of cidRows.results) changeIdMap.set(r.ledger_id, r.m);
  }

  const avatarUrl = (uid: string | null | undefined, u: { avatar_file_id: string | null; avatar_version: number | null } | undefined): string | null =>
    uid && u?.avatar_file_id ? `/api/v1/profile/avatar/${uid}?v=${u.avatar_version ?? 0}` : null;

  const items = rows.results.map((row) => {
    const tagIds = safeJsonParse<string[]>(row.tag_sync_ids_json as string | null) ?? [];
    const attachments = safeJsonParse<Array<Record<string, unknown>>>(
      row.attachments_json as string | null
    ) ?? [];
    const ledgerId = row.ledger_id as string;
    const info = ledgerInfoMap.get(ledgerId);
    const creatorUid = (row.created_by_user_id as string) || info?.owner_uid || null;
    const editorUid = (row.last_edited_by_user_id as string) || creatorUid;
    const creator = creatorUid ? userInfoMap.get(creatorUid) : undefined;
    const editor = editorUid ? userInfoMap.get(editorUid) : undefined;

    return {
      id: row.sync_id as string,
      tx_index: (row.tx_index as number) ?? 0,
      tx_type: row.tx_type as string,
      amount: row.amount as number,
      currency_code: (row.currency_code as string) ?? null,
      native_amount: (row.native_amount as number) ?? null,
      happened_at: row.happened_at as string,
      note: row.note as string | null,
      tags: (row.tags_csv as string) ?? null,
      tags_list: parseTagsCsv(row.tags_csv as string | null),
      tag_ids: tagIds,
      attachments,
      account_id: (row.account_sync_id as string) ?? null,
      account_name: row.account_name as string | null,
      from_account_id: (row.from_account_sync_id as string) ?? null,
      from_account_name: row.from_account_name as string | null,
      to_account_id: (row.to_account_sync_id as string) ?? null,
      to_account_name: row.to_account_name as string | null,
      category_id: (row.category_sync_id as string) ?? null,
      category_name: row.category_name as string | null,
      category_kind: row.category_kind as string | null,
      exclude_from_stats: !!(row.exclude_from_stats),
      exclude_from_budget: !!(row.exclude_from_budget),
      last_change_id: changeIdMap.get(ledgerId) ?? 0,
      ledger_id: info?.external_id ?? (row.ledger_external_id as string) ?? ledgerId,
      ledger_name: info?.name ?? null,
      created_by_user_id: creatorUid,
      created_by_email: creator?.email ?? null,
      created_by_display_name: creator?.display_name ?? null,
      created_by_avatar_url: avatarUrl(creatorUid, creator),
      created_by_avatar_version: creator?.avatar_file_id ? (creator.avatar_version ?? 0) : null,
      last_edited_by_user_id: editorUid,
      last_edited_by_email: editor?.email ?? null,
      last_edited_by_display_name: editor?.display_name ?? null,
      last_edited_by_avatar_url: avatarUrl(editorUid, editor),
      last_edited_by_avatar_version: editor?.avatar_file_id ? (editor.avatar_version ?? 0) : null,
    };
  });

  return c.json({
    items,
    total: totalResult?.cnt ?? rows.results.length,
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

  // 查询账本（先 external_id，再内部 id，再共享账本）
  let ledger = await db
    .prepare(
      `SELECT l.id, l.external_id, l.name, l.currency, l.month_start_day, l.user_id
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
      user_id: string;
    }>();

  if (!ledger) {
    // 尝试按内部 id 查找
    ledger = await db
      .prepare(
        `SELECT l.id, l.external_id, l.name, l.currency, l.month_start_day, l.user_id
         FROM ledgers l
         WHERE l.user_id = ? AND l.id = ?`
      )
      .bind(userId, ledgerExternalId)
      .first<{
        id: string;
        external_id: string;
        name: string | null;
        currency: string;
        month_start_day: number;
        user_id: string;
      }>();
  }

  if (!ledger) {
    // 共享账本：通过 ledger_members 查找
    ledger = await db
      .prepare(
        `SELECT l.id, l.external_id, l.name, l.currency, l.month_start_day, l.user_id
         FROM ledgers l
         JOIN ledger_members lm ON l.id = lm.ledger_id
         WHERE lm.user_id = ? AND (l.external_id = ? OR l.id = ?)`
      )
      .bind(userId, ledgerExternalId, ledgerExternalId)
      .first<{
        id: string;
        external_id: string;
        name: string | null;
        currency: string;
        month_start_day: number;
        user_id: string;
      }>();
  }

  if (!ledger) {
    return c.json({ error: 'Ledger not found' }, 404);
  }

  // 确定用户在该账本中的角色（与原版对齐）
  const memberRow = await db
    .prepare('SELECT role FROM ledger_members WHERE ledger_id = ? AND user_id = ?')
    .bind(ledger.id, userId)
    .first<{ role: string }>();
  const userRole = ledger.user_id === userId ? 'owner' : (memberRow?.role ?? 'owner');

  // 检查软删除(取最新 ledger_snapshot 动作;删后重建的账本不应被误判为已删)
  const tombstone = await db
    .prepare(
      `SELECT action FROM sync_changes
       WHERE ledger_id = ? AND entity_type = 'ledger_snapshot'
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

  // 汇总统计(对齐上游 _projection_totals:tx_count 含标记笔,
  // income/expense 排除标记笔,balance_all 含标记笔,native_amount 回退 amount)
  const totals = await db
    .prepare(
      `SELECT
         COUNT(*) as tx_count,
         COALESCE(SUM(CASE WHEN tx_type = 'income' AND (exclude_from_stats IS NULL OR exclude_from_stats = 0 OR exclude_from_stats = false) THEN COALESCE(native_amount, amount) ELSE 0 END), 0) as income_total,
         COALESCE(SUM(CASE WHEN tx_type = 'expense' AND (exclude_from_stats IS NULL OR exclude_from_stats = 0 OR exclude_from_stats = false) THEN COALESCE(native_amount, amount) ELSE 0 END), 0) as expense_total,
         COALESCE(SUM(CASE WHEN tx_type = 'income' THEN COALESCE(native_amount, amount) WHEN tx_type = 'expense' THEN -COALESCE(native_amount, amount) ELSE 0 END), 0) as balance_all
       FROM read_tx_projection
       WHERE ledger_id = ?`
    )
    .bind(ledger.id)
    .first<{
      tx_count: number;
      income_total: number;
      expense_total: number;
      balance_all: number;
    }>();

  // 计算成员数
  const memberCount = await db
    .prepare('SELECT COUNT(*) as cnt FROM ledger_members WHERE ledger_id = ?')
    .bind(ledger.id)
    .first<{ cnt: number }>();
  const totalMembers = (memberCount?.cnt ?? 0);

  const response: ReadLedgerDetailOut = {
    ledger_id: ledger.external_id,
    ledger_name: ledger.name ?? ledger.external_id,
    currency: ledger.currency || 'CNY',
    month_start_day: ledger.month_start_day ?? 1,
    transaction_count: totals?.tx_count ?? 0,
    income_total: totals?.income_total ?? 0,
    expense_total: totals?.expense_total ?? 0,
    balance: totals?.balance_all ?? 0,
    exported_at: now,
    updated_at: now,
    role: userRole as 'owner' | 'editor' | 'viewer',
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

  // 查询账本（支持共享账本成员）
  let ledger = await db
    .prepare(
      `SELECT l.id, l.external_id FROM ledgers l
       WHERE l.user_id = ? AND l.external_id = ?`
    )
    .bind(userId, ledgerExternalId)
    .first<{ id: string; external_id: string }>();

  if (!ledger) {
    // 尝试 ledger_members（共享账本）
    ledger = await db
      .prepare(
        `SELECT l.id, l.external_id FROM ledgers l
         JOIN ledger_members lm ON l.id = lm.ledger_id
         WHERE lm.user_id = ? AND l.external_id = ?`
      )
      .bind(userId, ledgerExternalId)
      .first<{ id: string; external_id: string }>();
  }

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
          `SELECT COUNT(DISTINCT sync_id) as cnt FROM user_account_projection WHERE user_id = ?`
        )
        .bind(userId)
        .first<{ cnt: number }>(),
      db
        .prepare(
          `SELECT COUNT(DISTINCT sync_id) as cnt FROM user_category_projection WHERE user_id = ?`
        )
        .bind(userId)
        .first<{ cnt: number }>(),
      db
        .prepare(
          `SELECT COUNT(DISTINCT sync_id) as cnt FROM user_tag_projection WHERE user_id = ?`
        )
        .bind(userId)
        .first<{ cnt: number }>(),
    ]);

  // 全局统计 — 跨所有可访问账本（自有 + 共享成员），与原版对齐
  const accessibleLedgerIds = await db
    .prepare(`SELECT l.id FROM ledgers l WHERE l.user_id = ?
              UNION
              SELECT lm.ledger_id FROM ledger_members lm WHERE lm.user_id = ?`)
    .bind(userId, userId)
    .all<{ id: string }>();
  const ledgerIds = accessibleLedgerIds.results.map(r => r.id);

  const [txTotal, budgetTotal, attachmentTotal, categoryAttachmentTotal] = await Promise.all([
    ledgerIds.length > 0
      ? db
          .prepare(`SELECT COUNT(*) as cnt FROM read_tx_projection WHERE ledger_id IN (${ledgerIds.map(() => '?').join(',')})`)
          .bind(...ledgerIds)
          .first<{ cnt: number }>()
      : Promise.resolve({ cnt: 0 }),
    ledgerIds.length > 0
      ? db
          .prepare(`SELECT COUNT(*) as cnt FROM read_budget_projection WHERE ledger_id IN (${ledgerIds.map(() => '?').join(',')})`)
          .bind(...ledgerIds)
          .first<{ cnt: number }>()
      : Promise.resolve({ cnt: 0 }),
    ledgerIds.length > 0
      ? db
          .prepare(
            `SELECT COUNT(*) as cnt FROM attachment_files a
             WHERE a.ledger_id IN (${ledgerIds.map(() => '?').join(',')}) AND a.attachment_kind = 'transaction'`
          )
          .bind(...ledgerIds)
          .first<{ cnt: number }>()
      : Promise.resolve({ cnt: 0 }),
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

  serverLogger.info('src.routers.read', '[READ] /transactions called, ledgerId:', ledgerExternalId, 'userId:', userId);

  const txType = c.req.query('tx_type') ?? null;
  const q = c.req.query('q') ?? null;
  const startAt = c.req.query('start_at') ?? null;
  const endAt = c.req.query('end_at') ?? null;
  const limit = Math.min(parseInt(c.req.query('limit') ?? '20', 10), 2000);
  const offset = parseInt(c.req.query('offset') ?? '0', 10);

  // 查询账本（先 external_id，再内部 id，再共享账本）
  let ledger = await db
    .prepare(
      `SELECT l.id, l.external_id, l.name FROM ledgers l
       WHERE l.user_id = ? AND l.external_id = ?`
    )
    .bind(userId, ledgerExternalId)
    .first<{ id: string; external_id: string; name: string | null }>();

  if (!ledger) {
    ledger = await db
      .prepare(
        `SELECT l.id, l.external_id, l.name FROM ledgers l
         WHERE l.user_id = ? AND l.id = ?`
      )
      .bind(userId, ledgerExternalId)
      .first<{ id: string; external_id: string; name: string | null }>();
  }

  if (!ledger) {
    ledger = await db
      .prepare(
        `SELECT l.id, l.external_id, l.name FROM ledgers l
         JOIN ledger_members lm ON l.id = lm.ledger_id
         WHERE lm.user_id = ? AND (l.external_id = ? OR l.id = ?)`
      )
      .bind(userId, ledgerExternalId, ledgerExternalId)
      .first<{ id: string; external_id: string; name: string | null }>();
  }

  if (!ledger) {
    serverLogger.info('src.routers.read', '[READ] Ledger not found:', ledgerExternalId);
    return c.json({ error: 'Ledger not found' }, 404);
  }

  serverLogger.info('src.routers.read', '[READ] Found ledger:', ledger.id, ledger.name, 'external_id:', ledger.external_id);

  // 构建查询
  let ledgerTxQuery = 'SELECT * FROM read_tx_projection WHERE ledger_id = ?';
  const ledgerTxBindings: (string | number)[] = [ledger.id];

  if (txType) {
    ledgerTxQuery += ' AND tx_type = ?';
    ledgerTxBindings.push(txType);
  }
  if (q) {
    ledgerTxQuery += ' AND (note LIKE ? OR category_name LIKE ? OR account_name LIKE ? OR from_account_name LIKE ? OR to_account_name LIKE ? OR tags_csv LIKE ?)';
    const like = `%${q}%`;
    ledgerTxBindings.push(like, like, like, like, like, like);
  }
  if (startAt) {
    ledgerTxQuery += ' AND happened_at >= ?';
    ledgerTxBindings.push(startAt);
  }
  if (endAt) {
    ledgerTxQuery += ' AND happened_at <= ?'; // 对齐上游 ledgers.py:274(含边界)
    ledgerTxBindings.push(endAt);
  }

  ledgerTxQuery += ' ORDER BY happened_at DESC, tx_index DESC LIMIT ? OFFSET ?';
  ledgerTxBindings.push(limit, offset);

  const rows = await db
    .prepare(ledgerTxQuery)
    .bind(...ledgerTxBindings)
    .all<Record<string, unknown>>();

  serverLogger.info('src.routers.read', '[READ] Found transactions:', rows.results.length);

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
    serverLogger.info('src.routers.read', '[READ] Error getting owner info:', err);
  }

  // 账本级最新 change_id(对齐上游 _get_latest_change_id,作为前端缓存失效 key;
  // 不能用行内 source_change_id,否则账户 A 变更后其他交易的缓存 key 不失效)
  const ledgerMaxChange = await db
    .prepare('SELECT COALESCE(MAX(change_id), 0) as max_id FROM sync_changes WHERE ledger_id = ?')
    .bind(ledger.id)
    .first<{ max_id: number }>();
  const ledgerLastChangeId = ledgerMaxChange?.max_id ?? 0;

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
      currency_code: (row.currency_code as string) ?? null,
      native_amount: (row.native_amount as number) ?? null,
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
      last_change_id: ledgerLastChangeId,
      ledger_id: ledger.external_id,
      ledger_name: ledger.name,
      created_by_user_id: ownerInfo.id,
      created_by_email: ownerInfo.email,
      created_by_display_name: ownerInfo.display_name,
      created_by_avatar_url: ownerInfo.avatar_file_id
        ? `/api/v1/profile/avatar/${ownerInfo.id}?v=${ownerInfo.avatar_version ?? 0}`
        : null,
      created_by_avatar_version: ownerInfo.avatar_version,
    };
  });

  serverLogger.info('src.routers.read', '[READ] Returning transactions:', result.length);
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

  // 查询账本（支持共享账本成员）
  let ledger = await db
    .prepare(
      `SELECT l.id, l.external_id, l.name FROM ledgers l
       WHERE l.user_id = ? AND l.external_id = ?`
    )
    .bind(userId, ledgerExternalId)
    .first<{ id: string; external_id: string; name: string | null }>();

  if (!ledger) {
    ledger = await db
      .prepare(
        `SELECT l.id, l.external_id, l.name FROM ledgers l
         JOIN ledger_members lm ON l.id = lm.ledger_id
         WHERE lm.user_id = ? AND l.external_id = ?`
      )
      .bind(userId, ledgerExternalId)
      .first<{ id: string; external_id: string; name: string | null }>();
  }

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
              r.note, r.credit_limit, r.billing_day, r.payment_due_day, r.bank_name, r.card_last_four, r.hidden
       FROM user_account_projection r
       WHERE r.user_id = ?
       ORDER BY LOWER(r.name) ASC`
    )
    .bind(userId)
    .all<Record<string, unknown>>();

  const result: ReadAccountOut[] = [];
  const rowsList = rows.results;

  // 单账本聚合:3 条 GROUP BY 取代逐账户循环查询(N+1)。
  // 账户维度读 amount 原币(与 workspace/accounts 同口径);转账影响分别按 from/to 计入
  const mainStats = await db.prepare(`
    SELECT account_sync_id,
           COALESCE(SUM(CASE WHEN tx_type = 'income' THEN amount ELSE 0 END), 0) as income,
           COALESCE(SUM(CASE WHEN tx_type = 'expense' THEN amount ELSE 0 END), 0) as expense
    FROM read_tx_projection
    WHERE ledger_id = ? AND account_sync_id IS NOT NULL AND tx_type IN ('income','expense')
    GROUP BY account_sync_id
  `).bind(ledger.id).all<{ account_sync_id: string; income: number; expense: number }>();

  const transferFrom = await db.prepare(`
    SELECT from_account_sync_id as account_sync_id, COALESCE(SUM(amount), 0) as amt
    FROM read_tx_projection
    WHERE ledger_id = ? AND tx_type = 'transfer' AND from_account_sync_id IS NOT NULL
    GROUP BY from_account_sync_id
  `).bind(ledger.id).all<{ account_sync_id: string; amt: number }>();

  const transferTo = await db.prepare(`
    SELECT to_account_sync_id as account_sync_id, COALESCE(SUM(amount), 0) as amt
    FROM read_tx_projection
    WHERE ledger_id = ? AND tx_type = 'transfer' AND to_account_sync_id IS NOT NULL
    GROUP BY to_account_sync_id
  `).bind(ledger.id).all<{ account_sync_id: string; amt: number }>();

  const txMap: Record<string, { income: number; expense: number; transferIn: number; transferOut: number }> = {};
  for (const r of mainStats.results) txMap[r.account_sync_id] = { income: Number(r.income), expense: Number(r.expense), transferIn: 0, transferOut: 0 };
  for (const r of transferFrom.results) (txMap[r.account_sync_id] ??= { income: 0, expense: 0, transferIn: 0, transferOut: 0 }).transferOut += Number(r.amt);
  for (const r of transferTo.results) (txMap[r.account_sync_id] ??= { income: 0, expense: 0, transferIn: 0, transferOut: 0 }).transferIn += Number(r.amt);

  for (const row of rowsList) {
    const accountSyncId = row.sync_id as string;
    const initialBalance = (row.initial_balance as number) ?? 0;
    const tx = txMap[accountSyncId] ?? { income: 0, expense: 0, transferIn: 0, transferOut: 0 };

    const balance = initialBalance + tx.income - tx.expense + tx.transferIn - tx.transferOut;

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
      hidden: !!row.hidden,
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

  let ledger = await db
    .prepare(
      `SELECT l.id, l.external_id, l.name FROM ledgers l
       WHERE l.user_id = ? AND l.external_id = ?`
    )
    .bind(userId, ledgerExternalId)
    .first<{ id: string; external_id: string; name: string | null }>();

  if (!ledger) {
    ledger = await db
      .prepare(
        `SELECT l.id, l.external_id, l.name FROM ledgers l
         JOIN ledger_members lm ON l.id = lm.ledger_id
         WHERE lm.user_id = ? AND l.external_id = ?`
      )
      .bind(userId, ledgerExternalId)
      .first<{ id: string; external_id: string; name: string | null }>();
  }

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
              r.icon_cloud_file_id, r.icon_cloud_sha256, r.parent_name, r.parent_sync_id
       FROM user_category_projection r
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
    parent_sync_id: row.parent_sync_id as string | null,
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

  let ledger = await db
    .prepare(
      `SELECT l.id, l.external_id, l.name FROM ledgers l
       WHERE l.user_id = ? AND l.external_id = ?`
    )
    .bind(userId, ledgerExternalId)
    .first<{ id: string; external_id: string; name: string | null }>();

  if (!ledger) {
    ledger = await db
      .prepare(
        `SELECT l.id, l.external_id, l.name FROM ledgers l
         JOIN ledger_members lm ON l.id = lm.ledger_id
         WHERE lm.user_id = ? AND l.external_id = ?`
      )
      .bind(userId, ledgerExternalId)
      .first<{ id: string; external_id: string; name: string | null }>();
  }

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
       FROM user_tag_projection r
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

  // 支持共享账本：先查 owner 账本，再查成员账本
  let ledger = await db
    .prepare(
      `SELECT l.id, l.external_id, l.name FROM ledgers l
       WHERE l.user_id = ? AND l.external_id = ?`
    )
    .bind(userId, ledgerExternalId)
    .first<{ id: string; external_id: string; name: string | null }>();

  if (!ledger) {
    ledger = await db
      .prepare(
        `SELECT l.id, l.external_id, l.name FROM ledgers l
         JOIN ledger_members lm ON l.id = lm.ledger_id AND lm.user_id = ?
         WHERE l.external_id = ?`
      )
      .bind(userId, ledgerExternalId)
      .first<{ id: string; external_id: string; name: string | null }>();
  }

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
      `SELECT DISTINCT r.sync_id, r.name FROM user_category_projection r
       WHERE r.user_id = ?`
    )
    .bind(userId)
    .all<{ sync_id: string; name: string }>();

  const catNameMap: Record<string, string> = {};
  catRows.results.forEach((r) => {
    // 对齐上游:同 sync_id 脏数据取第一份且 strip
    if (catNameMap[r.sync_id] === undefined) catNameMap[r.sync_id] = (r.name ?? '').trim();
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

  // 支持共享账本
  let ledger = await db
    .prepare('SELECT id, external_id FROM ledgers WHERE user_id = ? AND external_id = ?')
    .bind(userId, ledgerExtId)
    .first<{ id: string; external_id: string }>();
  if (!ledger) {
    ledger = await db
      .prepare('SELECT l.id, l.external_id FROM ledgers l JOIN ledger_members lm ON l.id = lm.ledger_id AND lm.user_id = ? WHERE l.external_id = ?')
      .bind(userId, ledgerExtId)
      .first<{ id: string; external_id: string }>();
  }
  if (!ledger) return c.json({ error: 'Ledger not found' }, 404);

  // 获取 month_start_day（与原版 _current_period_range 对齐）
  const ledgerDetail = await db.prepare('SELECT month_start_day FROM ledgers WHERE id = ?').bind(ledger.id).first<{ month_start_day: number }>();
  const monthStartDay = Math.min(Math.max(ledgerDetail?.month_start_day ?? 1, 1), 28);

  const now = new Date();
  const today = now.getDate();
  const year = now.getFullYear();
  const month = now.getMonth(); // 0-based

  // 与原版对齐的周期计算：如果 day >= monthStartDay，周期从当月 start_day 开始；否则从上月 start_day 开始
  let periodStart: Date;
  let periodEnd: Date;
  if (today >= monthStartDay) {
    periodStart = new Date(year, month, monthStartDay);
    periodEnd = new Date(year, month + 1, monthStartDay);
  } else {
    periodStart = new Date(year, month - 1, monthStartDay);
    periodEnd = new Date(year, month, monthStartDay);
  }

  const pad = (n: number) => String(n).padStart(2, '0');
  const formatDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const currentMonth = formatDate(periodStart);
  const nextMonth = formatDate(periodEnd);

  const budgets = await db
    .prepare('SELECT sync_id, budget_type, category_sync_id, amount, period FROM read_budget_projection WHERE ledger_id = ?')
    .bind(ledger.id)
    .all<{ sync_id: string; budget_type: string | null; category_sync_id: string | null; amount: number; period: string }>();

  // 与原版 list_budgets_usage 同款脏数据去重：(budget_type, category_sync_id) 维度，
  // sync_id 字典序最大胜出；usage 与 list_budgets 必须用同一份 budget 才一致
  const dedup = new Map<string, typeof budgets.results[0]>();
  for (const b of budgets.results) {
    const btype = b.budget_type || 'total';
    if (btype === 'category' && !b.category_sync_id) continue;
    const key = `${btype}:${b.category_sync_id || ''}`;
    const cur = dedup.get(key);
    if (!cur || cur.sync_id < b.sync_id) dedup.set(key, b);
  }

  const usage: Array<{
    budget_id: string;
    category_id: string | null;
    budget_amount: number;
    spent_amount: number;
    period: string;
  }> = [];

  for (const b of dedup.values()) {
    let spent = 0;
    if (b.category_sync_id) {
      // 子分类展开：查找所有子分类（用 parent_sync_id 匹配，与原版 _expand_category_to_children 对齐）
      const categorySyncIds: string[] = [b.category_sync_id];
      const children = await db
        .prepare('SELECT sync_id FROM user_category_projection WHERE user_id = ? AND parent_sync_id = ?')
        .bind(userId, b.category_sync_id)
        .all<{ sync_id: string }>();
      categorySyncIds.push(...children.results.map(c => c.sync_id));

      const placeholders = categorySyncIds.map(() => '?').join(',');
      const row = await db
        .prepare(`SELECT COALESCE(SUM(COALESCE(native_amount, amount)), 0) as total FROM read_tx_projection
                   WHERE ledger_id = ? AND category_sync_id IN (${placeholders}) AND tx_type = 'expense'
                   AND happened_at >= ? AND happened_at < ?
                   AND (exclude_from_budget IS NULL OR exclude_from_budget = 0 OR exclude_from_budget = false)`)
        .bind(ledger.id, ...categorySyncIds, currentMonth, nextMonth)
        .first<{ total: number }>();
      spent = row?.total ?? 0;
    } else {
      const row = await db
        .prepare(`SELECT COALESCE(SUM(COALESCE(native_amount, amount)), 0) as total FROM read_tx_projection
                   WHERE ledger_id = ? AND tx_type = 'expense'
                   AND happened_at >= ? AND happened_at < ?
                   AND (exclude_from_budget IS NULL OR exclude_from_budget = 0 OR exclude_from_budget = false)`)
        .bind(ledger.id, currentMonth, nextMonth)
        .first<{ total: number }>();
      spent = row?.total ?? 0;
    }

    usage.push({
      budget_id: b.sync_id,
      category_id: b.category_sync_id,
      budget_amount: b.amount,
      spent_amount: Math.abs(spent), // 对齐原版 ledgers.py: used=abs(used)
      period: b.period,
    });
  }

  return c.json({ items: usage.map(u => ({ budget_id: u.budget_id, used: u.spent_amount })) });
});

// ---------------------------------------------------------------------------
// Workspace 聚合端点 - 跨账本查询
// ---------------------------------------------------------------------------
// 调试端点 - 查看数据库原始数据
// ---------------------------------------------------------------------------

/** 调试端点 - 查看所有账本（仅开发环境可用） */
readRouter.get('/debug/ledgers', async (c) => {
  if (c.env.NODE_ENV !== 'development') {
    return c.json({ error: 'Not found' }, 404);
  }
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

/** 调试端点 - 查看所有交易（仅开发环境可用） */
readRouter.get('/debug/transactions', async (c) => {
  if (c.env.NODE_ENV !== 'development') {
    return c.json({ error: 'Not found' }, 404);
  }
  const userId = c.get('userId');
  const db = c.env.DB;

  const ledgers = await db
    .prepare('SELECT id, external_id FROM ledgers WHERE user_id = ?')
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
       FROM user_exchange_rate_projection
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
    updated_at: r.updated_at ? new Date(r.updated_at).toISOString() : null, // 对齐上游 _utc_iso
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

  const db = c.env.DB;
  const env = c.env as unknown as Record<string, string | undefined>;
  // 对齐上游 config:exchange_rate_proxy_enabled 默认 true;EXCHANGE_RATE_CACHE_TTL_HOURS 默认 12
  if (env.EXCHANGE_RATE_PROXY_ENABLED === 'false') {
    return c.json({ error: 'Exchange rate proxy disabled' }, 404);
  }
  const ttlMs = (parseInt(env.EXCHANGE_RATE_CACHE_TTL_HOURS ?? '12', 10) || 12) * 3600 * 1000;
  const b = base.toUpperCase();
  const now = Date.now();

  const parsePayload = (raw: unknown): Record<string, string> => {
    if (typeof raw === 'string') {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') return parsed as Record<string, string>;
      } catch { /* fallthrough */ }
    } else if (raw && typeof raw === 'object') {
      return raw as Record<string, string>;
    }
    return {};
  };

  // 缓存优先(对齐上游 fetcher.get_rates:TTL 内直接返回,不 hit 外网)
  const cached = await db
    .prepare('SELECT base_currency, rate_date, source, payload_json, fetched_at FROM exchange_rate_cache WHERE base_currency = ?')
    .bind(b)
    .first<{ base_currency: string; rate_date: string; source: string; payload_json: unknown; fetched_at: string }>();

  const fresh = !!cached && !!cached.fetched_at && now - new Date(cached.fetched_at).getTime() < ttlMs;

  if (cached && fresh) {
    return c.json({
      base: b,
      rate_date: cached.rate_date,
      source: cached.source,
      fetched_at: cached.fetched_at,
      stale: false,
      rates: parsePayload(cached.payload_json),
    });
  }

  try {
    const response = await fetch(`https://api.exchangerate-api.com/v4/latest/${b}`);
    if (!response.ok) throw new Error(`upstream status ${response.status}`);
    const data = await response.json() as { rates: Record<string, number>; date: string };
    const fetchedAt = new Date().toISOString();
    const ratesJson = JSON.stringify(data.rates);
    await db.prepare(
      `INSERT OR REPLACE INTO exchange_rate_cache (base_currency, rate_date, source, payload_json, fetched_at)
       VALUES (?, ?, 'exchangerate-api.com', ?, ?)`
    ).bind(b, data.date, ratesJson, fetchedAt).run();

    return c.json({
      base: b,
      rate_date: data.date,
      source: 'exchangerate-api.com',
      fetched_at: fetchedAt,
      stale: false,
      rates: Object.fromEntries(Object.entries(data.rates).map(([k, v]) => [k, String(v)])),
    });
  } catch {
    // 上游失败:有过期缓存 → stale=true 返回旧数据(对齐上游);无缓存 → 503
    if (cached) {
      return c.json({
        base: b,
        rate_date: cached.rate_date,
        source: cached.source,
        fetched_at: cached.fetched_at,
        stale: true,
        rates: parsePayload(cached.payload_json),
      });
    }
    return c.json({ error: 'Exchange rate fetch failed' }, 503);
  }
});

/** 调试端点 - 查看所有同步变更（仅开发环境可用） */
readRouter.get('/debug/sync-changes', async (c) => {
  if (c.env.NODE_ENV !== 'development') {
    return c.json({ error: 'Not found' }, 404);
  }
  const userId = c.get('userId');
  const db = c.env.DB;

  const changes = await db
    .prepare('SELECT * FROM sync_changes WHERE user_id = ? ORDER BY change_id DESC LIMIT 50')
    .bind(userId)
    .all();

  return c.json({ changes: changes.results });
});

// ---------------------------------------------------------------------------
// GET /read/workspace/attachments - 票据墙：当前账本附件按文件去重分页
// （对齐上游 read/attachment_gallery.py 的 GalleryAttachmentPageOut 契约）
// ---------------------------------------------------------------------------
type GalleryRef = {
  file_key: string;
  cloud_file_id: string | null;
  ref: Record<string, unknown>;
  original_name: string | null;
  file_name: string | null;
  sync_id: string;
  ledger_external_id: string;
  happened_at: string;
  note: string | null;
  category_name: string | null;
  category_sync_id: string | null;
  amount: number;
  tx_type: string;
  currency_code: string | null;
  native_amount: number | null;
  account_name: string | null;
};

readRouter.get('/workspace/attachments', async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;

  const ledgerExternalId = c.req.query('ledger_id') ?? null;
  const q = c.req.query('q') ?? null;
  const categorySyncId = c.req.query('category_sync_id') ?? null;
  const dateFrom = c.req.query('date_from') ?? null;
  const dateTo = c.req.query('date_to') ?? null;
  const limit = Math.min(parseInt(c.req.query('limit') ?? '40', 10), 100);
  const offset = Math.max(parseInt(c.req.query('offset') ?? '0', 10), 0);

  if (!ledgerExternalId) {
    return c.json({ items: [], total: 0, transaction_total: 0, limit, offset });
  }

  // 账本访问校验（支持共享账本，与 /workspace/transactions 同口径）
  let ledger = await db
    .prepare('SELECT id, external_id FROM ledgers WHERE user_id = ? AND external_id = ?')
    .bind(userId, ledgerExternalId)
    .first<{ id: string; external_id: string }>();
  if (!ledger) {
    ledger = await db
      .prepare('SELECT l.id, l.external_id FROM ledgers l JOIN ledger_members lm ON l.id = lm.ledger_id WHERE lm.user_id = ? AND l.external_id = ?')
      .bind(userId, ledgerExternalId)
      .first<{ id: string; external_id: string }>();
  }
  if (!ledger) {
    return c.json({ items: [], total: 0, transaction_total: 0, limit, offset });
  }

  // 拉取该账本全部带附件的交易（票据墙默认全量，账本级数据量可控）
  let query = `SELECT sync_id, happened_at, note, category_name, category_sync_id, amount, tx_type,
                      currency_code, native_amount, account_name, attachments_json
               FROM read_tx_projection
               WHERE ledger_id = ? AND attachments_json IS NOT NULL AND attachments_json != ''`;
  const bindings: (string | number)[] = [ledger.id];
  if (dateFrom) { query += ' AND happened_at >= ?'; bindings.push(dateFrom); }
  if (dateTo) { query += ' AND happened_at < ?'; bindings.push(dateTo); }
  if (categorySyncId) { query += ' AND category_sync_id = ?'; bindings.push(categorySyncId); }
  query += ' ORDER BY happened_at DESC';
  const txs = await db.prepare(query).bind(...bindings).all<{
    sync_id: string; happened_at: string; note: string | null; category_name: string | null;
    category_sync_id: string | null; amount: number; tx_type: string; currency_code: string | null;
    native_amount: number | null; account_name: string | null; attachments_json: string;
  }>();

  // 在应用层展开 attachments_json 数组（对齐上游 json_each 展开语义）
  const refs: GalleryRef[] = [];
  for (const tx of txs.results) {
    let atts: unknown;
    try { atts = JSON.parse(tx.attachments_json); } catch { continue; }
    if (!Array.isArray(atts)) continue;
    atts.forEach((raw, index) => {
      if (!raw || typeof raw !== 'object') return;
      const att = raw as Record<string, unknown>;
      const cloudFileId = typeof att.cloudFileId === 'string' && att.cloudFileId.trim() ? att.cloudFileId.trim() : null;
      const originalName = typeof att.originalName === 'string' ? att.originalName : null;
      const fileName = typeof att.fileName === 'string' ? att.fileName : null;
      const fileKey = cloudFileId ?? `local:${tx.sync_id}:${index}`;
      refs.push({
        file_key: fileKey,
        cloud_file_id: cloudFileId,
        ref: att,
        original_name: originalName,
        file_name: fileName,
        sync_id: tx.sync_id,
        ledger_external_id: ledger!.external_id,
        happened_at: tx.happened_at,
        note: tx.note,
        category_name: tx.category_name,
        category_sync_id: tx.category_sync_id,
        amount: Number(tx.amount || 0),
        tx_type: tx.tx_type,
        currency_code: tx.currency_code,
        native_amount: tx.native_amount,
        account_name: tx.account_name,
      });
    });
  }

  // q 搜索：对齐上游对 original_name/file_name/note/category_name/account_name/amount 的 ilike
  let filtered = refs;
  if (q && q.trim()) {
    const pattern = q.trim().toLowerCase();
    filtered = filtered.filter((r) => {
      const amountStr = String(r.amount);
      return [r.original_name, r.file_name, r.note, r.category_name, r.account_name]
        .concat(amountStr)
        .some((v) => v !== null && v !== undefined && String(v).toLowerCase().includes(pattern));
    });
  }

  // 按 file_key 去重分组，取最近 happened_at
  const byKey = new Map<string, GalleryRef>();
  for (const r of filtered) {
    const existing = byKey.get(r.file_key);
    if (!existing || r.happened_at > existing.happened_at) byKey.set(r.file_key, r);
  }
  const keys = [...byKey.keys()].sort((a, b) => {
    const ha = byKey.get(a)!.happened_at;
    const hb = byKey.get(b)!.happened_at;
    return ha === hb ? (a < b ? -1 : a > b ? 1 : 0) : (ha < hb ? 1 : -1);
  });
  const total = keys.length;
  const transactionTotal = new Set(filtered.map((r) => r.sync_id)).size;
  const pageKeys = keys.slice(offset, offset + limit);
  if (pageKeys.length === 0) {
    return c.json({ items: [], total, transaction_total: transactionTotal, limit, offset });
  }

  // 页面内全部关联交易（一次查询）
  const pageRefs = filtered.filter((r) => pageKeys.includes(r.file_key));
  const cloudIds = [...new Set(pageRefs.map((r) => r.cloud_file_id).filter((v): v is string => Boolean(v)))];
  const stored = new Map<string, { mime_type: string | null }>();
  if (cloudIds.length > 0) {
    const placeholders = cloudIds.map(() => '?').join(',');
    const rows = await db.prepare(
      `SELECT id, mime_type FROM attachment_files
       WHERE id IN (${placeholders}) AND ledger_id = ? AND attachment_kind = 'transaction'`
    ).bind(...cloudIds, ledger.id).all<{ id: string; mime_type: string | null }>();
    for (const row of rows.results) stored.set(row.id, row);
  }

  const seen = new Set<string>();
  const pageTxSyncIds = new Set<string>();
  for (const r of pageRefs) {
    const key = `${r.file_key}:${r.sync_id}`;
    if (!seen.has(key)) { seen.add(key); pageTxSyncIds.add(r.sync_id); }
  }

  const items = pageKeys.map((key) => {
    const head = byKey.get(key)!;
    const related = pageRefs.filter((r) => r.file_key === key);
    const txSeen = new Set<string>();
    const transactions: Record<string, unknown>[] = [];
    for (const r of related) {
      if (txSeen.has(r.sync_id)) continue;
      txSeen.add(r.sync_id);
      transactions.push({
        id: r.sync_id,
        ledger_id: r.ledger_external_id,
        note: r.note,
        category_name: r.category_name,
        category_id: r.category_sync_id,
        amount: r.amount,
        tx_type: r.tx_type,
        currency_code: r.currency_code,
        native_amount: r.native_amount,
        happened_at: r.happened_at,
      });
    }
    const file = head.cloud_file_id ? stored.get(head.cloud_file_id) : undefined;
    const status = !head.cloud_file_id ? 'pending' : file ? 'ready' : 'missing';
    return {
      key,
      attachment: head.ref,
      happened_at: head.happened_at,
      mime_type: file?.mime_type ?? null,
      status,
      transactions,
    };
  });

  return c.json({ items, total, transaction_total: transactionTotal, limit, offset });
});

export default readRouter;
