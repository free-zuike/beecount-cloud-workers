/**
 * Workspace 路由模块 - 实现跨账本聚合查询接口 + 共享账本管理
 *
 * 参考原版 BeeCount-Cloud (Python/FastAPI) 的 /read/workspace 端点：
 * - GET /read/workspace/transactions       - 跨账本交易列表（支持复杂过滤）
 * - GET /read/workspace/accounts          - 跨账本账户聚合
 * - GET /read/workspace/categories         - 跨账本分类聚合
 * - GET /read/workspace/tags             - 跨账本标签聚合
 * - GET /read/workspace/budgets          - 跨账本预算聚合
 * - GET /read/workspace/ledger-counts    - 账本总览统计
 * - GET /read/workspace/analytics         - 收支分析（series + category ranks）
 *
 * 共享账本端点：
 * - POST   /workspace/ledgers/:id/invite           - 生成邀请码
 * - GET    /workspace/ledgers/:id/invites          - 列出活跃邀请
 * - DELETE /workspace/ledgers/:id/invites/:code     - 撤销邀请
 * - POST   /workspace/ledgers/join                 - 通过邀请码加入账本
 * - POST   /workspace/invites/:code/preview         - 预览邀请详情
 * - GET    /workspace/ledgers/:id/members           - 列出成员
 * - DELETE /workspace/ledgers/:id/members/:userId   - 移除成员
 * - PATCH  /workspace/ledgers/:id                   - 修改账本元数据
 * - GET    /workspace/ledgers/:id/member-stats      - 成员统计
 * - GET    /workspace/ledgers/:id/shared-resources   - 共享资源
 * - POST   /workspace/ledgers/:id/transfer          - 转让 Owner
 *
 * @module routes/workspace
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

function safeJsonParse<T = Record<string, unknown>>(jsonStr: string | null): T | null {
  if (!jsonStr) return null;
  try {
    return JSON.parse(jsonStr) as T;
  } catch {
    return null;
  }
}

function parseTagsList(csv: string | null): string[] {
  if (!csv) return [];
  return csv.split(',').filter((t) => t.trim().length > 0);
}

const INVITE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateInviteCode(): string {
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += INVITE_CHARS[Math.floor(Math.random() * INVITE_CHARS.length)];
  }
  return code;
}

type Bindings = {
  DB: D1Database;
  JWT_SECRET: string;
  BEECOUNT_DO: DurableObjectNamespace;
};

type Variables = {
  userId: string;
};

const workspaceRouter = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// ===========================
// 辅助：查找账本（支持 owner + member）
// ===========================

async function findLedgerForUser(
  db: D1Database,
  ledgerExternalId: string,
  userId: string,
): Promise<{ id: string; user_id: string; external_id: string; name: string | null; currency: string; is_shared: number } | null> {
  const ledger = await db
    .prepare('SELECT id, user_id, external_id, name, currency, is_shared FROM ledgers WHERE external_id = ?')
    .bind(ledgerExternalId)
    .first<{ id: string; user_id: string; external_id: string; name: string | null; currency: string; is_shared: number }>();

  if (!ledger) return null;

  if (ledger.user_id === userId) return ledger;

  const member = await db
    .prepare('SELECT id FROM ledger_members WHERE ledger_id = ? AND user_id = ?')
    .bind(ledger.id, userId)
    .first();

  if (member) return ledger;

  return null;
}

async function getUserRoleInLedger(
  db: D1Database,
  ledgerId: string,
  userId: string,
): Promise<'owner' | 'editor' | null> {
  const ledger = await db
    .prepare('SELECT user_id FROM ledgers WHERE id = ?')
    .bind(ledgerId)
    .first<{ user_id: string }>();

  if (!ledger) return null;
  if (ledger.user_id === userId) return 'owner';

  const member = await db
    .prepare('SELECT role FROM ledger_members WHERE ledger_id = ? AND user_id = ?')
    .bind(ledgerId, userId)
    .first<{ role: string }>();

  return member ? (member.role as 'editor') : null;
}

// ===========================================================================
// GET /read/workspace/transactions.csv - CSV 导出（前端调用路径别名）
// ===========================================================================

workspaceRouter.get('/transactions.csv', async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;

  const ledgerId = c.req.query('ledger_id');
  if (!ledgerId) {
    return c.json({ error: 'ledger_id is required' }, 400);
  }

  const ledger = await db
    .prepare('SELECT id, name FROM ledgers WHERE user_id = ? AND external_id = ?')
    .bind(userId, ledgerId)
    .first<{ id: string; name: string | null }>();

  if (!ledger) {
    return c.json({ error: 'Ledger not found or access denied' }, 404);
  }

  let txQuery = 'SELECT * FROM read_tx_projection WHERE ledger_id = ?';
  const params: (string | number)[] = [ledger.id];

  const dateFrom = c.req.query('date_from');
  const dateTo = c.req.query('date_to');
  const categoryName = c.req.query('category_name');
  const accountName = c.req.query('account_name');
  const txType = c.req.query('tx_type');
  const q = c.req.query('q');
  const accountSyncId = c.req.query('account_sync_id');
  const categorySyncId = c.req.query('category_sync_id');
  const tagSyncId = c.req.query('tag_sync_id');
  const amountMin = c.req.query('amount_min') ? Number(c.req.query('amount_min')) : null;
  const amountMax = c.req.query('amount_max') ? Number(c.req.query('amount_max')) : null;

  if (txType) {
    txQuery += ' AND tx_type = ?';
    params.push(txType);
  }

  if (categoryName) {
    txQuery += ' AND category_name LIKE ?';
    params.push(`%${categoryName}%`);
  }

  if (accountName) {
    txQuery += ' AND (account_name LIKE ? OR from_account_name LIKE ? OR to_account_name LIKE ?)';
    const pattern = `%${accountName}%`;
    params.push(pattern, pattern, pattern);
  }

  if (dateFrom) {
    txQuery += ' AND happened_at >= ?';
    params.push(dateFrom);
  }

  if (dateTo) {
    txQuery += ' AND happened_at <= ?';
    params.push(dateTo + 'T23:59:59.999Z');
  }

  if (q) {
    txQuery += ' AND (note LIKE ? OR category_name LIKE ? OR account_name LIKE ?)';
    const like = `%${q}%`;
    params.push(like, like, like);
  }
  if (accountSyncId) {
    txQuery += ' AND account_sync_id = ?';
    params.push(accountSyncId);
  }
  if (categorySyncId) {
    txQuery += ' AND category_sync_id = ?';
    params.push(categorySyncId);
  }
  if (tagSyncId) {
    txQuery += ' AND tag_sync_ids_json LIKE ?';
    params.push(`%"${tagSyncId}"%`);
  }
  if (amountMin !== null && Number.isFinite(amountMin)) {
    txQuery += ' AND amount >= ?';
    params.push(amountMin);
  }
  if (amountMax !== null && Number.isFinite(amountMax)) {
    txQuery += ' AND amount <= ?';
    params.push(amountMax);
  }

  txQuery += ' ORDER BY happened_at DESC, tx_index DESC';

  const txRows = await db.prepare(txQuery).bind(...params).all<Record<string, unknown>>();

  function escapeCsvField(field: string | number | null): string {
    if (field === null || field === undefined) return '';
    const str = String(field);
    if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
      return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
  }

  const header = ['日期', '类型', '金额', '账户', '分类', '标签', '备注'];
  const rows = [header.join(',')];

  for (const tx of txRows.results) {
    const date = String(tx.happened_at ?? '').slice(0, 10);
    const txTypeVal = String(tx.tx_type ?? '');
    const amount = String(tx.amount ?? 0);
    const account = String(tx.account_name ?? tx.from_account_name ?? '');
    const category = String(tx.category_name ?? '');
    const tags = String(tx.tags_csv ?? '');
    const note = String(tx.note ?? '');

    rows.push(
      [date, txTypeVal, amount, account, category, tags, note].map(escapeCsvField).join(',')
    );
  }

  const csvContent = '\uFEFF' + rows.join('\r\n');
  const fileName = `${ledger.name || ledgerId}_transactions_${new Date().toISOString().slice(0, 10)}.csv`;

  return new Response(csvContent, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${fileName}"`,
    },
  });
});

// ===========================================================================
// GET /read/workspace/transactions - 跨账本交易列表
// ===========================================================================

workspaceRouter.get('/transactions', async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;

  const ledgerId = c.req.query('ledger_id') ?? null;
  const txType = c.req.query('tx_type') ?? null;
  const accountName = c.req.query('account_name') ?? null;
  const tagSyncId = c.req.query('tag_sync_id') ?? null;
  const categorySyncId = c.req.query('category_sync_id') ?? null;
  const q = c.req.query('q') ?? null;
  const limit = Math.min(parseInt(c.req.query('limit') ?? '20', 10), 2000);
  const offset = parseInt(c.req.query('offset') ?? '0', 10);

  // 查询用户可见账本（含共享账本，与原版 _visible_workspace_ledgers 对齐）
  let ledgerQuery = `SELECT DISTINCT l.id, l.external_id, l.name FROM ledgers l
    LEFT JOIN ledger_members lm ON l.id = lm.ledger_id AND lm.user_id = ?
    WHERE l.user_id = ? OR lm.user_id = ?`;
  const ledgerParams: string[] = [userId, userId, userId];

  if (ledgerId) {
    ledgerQuery += ' AND l.external_id = ?';
    ledgerParams.push(ledgerId);
  }

  const ledgers = await db.prepare(ledgerQuery).bind(...ledgerParams).all<{ id: string; external_id: string; name: string | null }>();

  if (ledgers.results.length === 0) {
    return c.json({ items: [], total: 0, limit, offset });
  }

  const ledgerInternalIds = ledgers.results.map((l) => l.id);
  const ledgerMeta: Record<string, { external_id: string; name: string | null }> = {};
  ledgers.results.forEach((l) => {
    ledgerMeta[l.id] = { external_id: l.external_id, name: l.name };
  });

  let txQuery = `SELECT * FROM read_tx_projection WHERE ledger_id IN (${ledgerInternalIds.map(() => '?').join(',')})`;
  const txParams: (string | number)[] = [...ledgerInternalIds];

  if (txType) {
    txQuery += ' AND tx_type = ?';
    txParams.push(txType);
  }

  if (accountName) {
    txQuery += ` AND (account_name LIKE ? OR from_account_name LIKE ? OR to_account_name LIKE ?)`;
    const pattern = `%${accountName}%`;
    txParams.push(pattern, pattern, pattern);
  }

  if (q) {
    txQuery += ` AND (note LIKE ? OR category_name LIKE ? OR account_name LIKE ? OR tags_csv LIKE ?)`;
    const pattern = `%${q}%`;
    txParams.push(pattern, pattern, pattern, pattern);
  }

  // 按 tag_sync_id 精确过滤（原版对齐）
  if (tagSyncId) {
    txQuery += ` AND tag_sync_ids_json LIKE ?`;
    txParams.push(`%"${tagSyncId}"%`);
  }

  // 按 category_sync_id 精确过滤（原版对齐）
  if (categorySyncId) {
    txQuery += ` AND category_sync_id = ?`;
    txParams.push(categorySyncId);
  }

  txQuery += ' ORDER BY happened_at DESC, tx_index DESC LIMIT ? OFFSET ?';
  txParams.push(limit + 1, offset);

  const txRows = await db.prepare(txQuery).bind(...txParams).all<Record<string, unknown>>();

  // 收集所有 created_by_user_id 做批量查询
  const creatorIds = new Set<string>();
  for (const row of txRows.results) {
    const uid = row.created_by_user_id as string;
    if (uid) creatorIds.add(uid);
  }
  const creatorMap: Record<string, { email: string | null; display_name: string | null; avatar_file_id: string | null; avatar_version: number }> = {};
  if (creatorIds.size > 0) {
    const ids = [...creatorIds];
    const placeholders = ids.map(() => '?').join(',');
    const users = await db.prepare(`SELECT u.id, u.email, p.display_name, p.avatar_file_id, p.avatar_version FROM users u LEFT JOIN user_profiles p ON p.user_id = u.id WHERE u.id IN (${placeholders})`).bind(...ids).all<{ id: string; email: string; display_name: string | null; avatar_file_id: string | null; avatar_version: number }>();
    for (const u of users.results) {
      creatorMap[u.id] = { email: u.email, display_name: u.display_name, avatar_file_id: u.avatar_file_id, avatar_version: u.avatar_version || 0 };
    }
  }

  const hasMore = txRows.results.length > limit;
  const items = txRows.results.slice(0, limit).map((row) => {
    const ledExtId = ledgerMeta[row.ledger_id as string]?.external_id ?? '';
    const ledName = ledgerMeta[row.ledger_id as string]?.name ?? null;
    const tagIds = safeJsonParse<string[]>(row.tag_sync_ids_json as string | null) ?? [];
    const attachments = safeJsonParse<Array<Record<string, unknown>>>(row.attachments_json as string | null);
    const creatorUid = row.created_by_user_id as string | null;
    const creator = creatorUid ? creatorMap[creatorUid] : null;

    return {
      id: row.sync_id,
      tx_index: row.tx_index,
      tx_type: row.tx_type,
      amount: row.amount,
      happened_at: row.happened_at,
      note: row.note,
      category_name: row.category_name,
      category_kind: row.category_kind,
      account_name: row.account_name,
      from_account_name: row.from_account_name,
      to_account_name: row.to_account_name,
      category_id: row.category_sync_id,
      account_id: row.account_sync_id,
      from_account_id: row.from_account_sync_id,
      to_account_id: row.to_account_sync_id,
      tags: row.tags_csv,
      tags_list: parseTagsList(row.tags_csv as string | null),
      tag_ids: tagIds,
      attachments,
      last_change_id: row.source_change_id,
      ledger_id: ledExtId,
      ledger_name: ledName,
      created_by_user_id: creatorUid,
      created_by_email: creator?.email ?? null,
      created_by_display_name: creator?.display_name ?? null,
      created_by_avatar_url: creator?.avatar_file_id ? `/api/v1/profile/avatar/${creatorUid}?v=${creator?.avatar_version}` : null,
      created_by_avatar_version: creator?.avatar_version ?? null,
    };
  });

  return c.json({
    items,
    total: items.length + (hasMore ? 1 : 0) * (items.length > 0 ? (offset + items.length) : 0),
    limit,
    offset,
    has_more: hasMore,
  });
});

// ===========================================================================
// GET /read/workspace/accounts - 跨账本账户聚合
// ===========================================================================

workspaceRouter.get('/accounts', async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const ledgerId = c.req.query('ledger_id') ?? null;
  const filterUserId = c.req.query('user_id') ?? null;
  const q = c.req.query('q') ?? null;
  const limit = Math.min(parseInt(c.req.query('limit') ?? '500', 10), 5000);
  const offset = parseInt(c.req.query('offset') ?? '0', 10);

  // 含共享账本
  let ledgerQuery = `SELECT DISTINCT l.id, l.external_id, l.name FROM ledgers l
    LEFT JOIN ledger_members lm ON l.id = lm.ledger_id AND lm.user_id = ?
    WHERE l.user_id = ? OR lm.user_id = ?`;
  const ledgerParams: string[] = [userId, userId, userId];

  if (ledgerId) {
    ledgerQuery += ' AND l.external_id = ?';
    ledgerParams.push(ledgerId);
  }

  const ledgers = await db.prepare(ledgerQuery).bind(...ledgerParams).all<{ id: string; external_id: string; name: string | null }>();

  if (ledgers.results.length === 0) {
    return c.json([]);
  }

  const ledgerInternalIds = ledgers.results.map((l) => l.id);
  const ledgerMeta: Record<string, { external_id: string; name: string | null }> = {};
  ledgers.results.forEach((l) => {
    ledgerMeta[l.id] = { external_id: l.external_id, name: l.name };
  });

  let acctQuery = `SELECT * FROM read_account_projection WHERE (ledger_id IN (${ledgerInternalIds.map(() => '?').join(',')}) OR ledger_id IS NULL)`;
  const acctParams: string[] = [...ledgerInternalIds];

  if (filterUserId) {
    acctQuery += ' AND user_id = ?';
    acctParams.push(filterUserId);
  }

  if (q) {
    acctQuery += ' AND name LIKE ?';
    acctParams.push(`%${q}%`);
  }

  acctQuery += ' ORDER BY LOWER(name) ASC LIMIT ? OFFSET ?';
  acctParams.push(String(limit), String(offset));

  const acctRows = await db.prepare(acctQuery).bind(...acctParams).all<Record<string, unknown>>();

  const items = [];
  for (const row of acctRows.results) {
    const ledExtId = ledgerMeta[row.ledger_id as string]?.external_id ?? '';
    const accountSyncId = row.sync_id as string;
    const initialBalance = (row.initial_balance as number) ?? 0;

    // 计算该账户关联的交易统计
    const txStats = await db.prepare(`
      SELECT 
        COALESCE(SUM(CASE WHEN tx_type = 'expense' AND account_sync_id = ? THEN amount ELSE 0 END), 0) as expense_in,
        COALESCE(SUM(CASE WHEN tx_type = 'income' AND account_sync_id = ? THEN amount ELSE 0 END), 0) as income_in,
        COALESCE(SUM(CASE WHEN tx_type = 'transfer' AND from_account_sync_id = ? THEN amount ELSE 0 END), 0) as expense_transfer,
        COALESCE(SUM(CASE WHEN tx_type = 'transfer' AND to_account_sync_id = ? THEN amount ELSE 0 END), 0) as income_transfer,
        COUNT(CASE WHEN account_sync_id = ? OR from_account_sync_id = ? OR to_account_sync_id = ? THEN 1 END) as tx_count
      FROM read_tx_projection WHERE ledger_id IN (${ledgerInternalIds.map(() => '?').join(',')})
    `).bind(accountSyncId, accountSyncId, accountSyncId, accountSyncId, accountSyncId, accountSyncId, accountSyncId, ...ledgerInternalIds).first<{ expense_in: number; income_in: number; expense_transfer: number; income_transfer: number; tx_count: number }>();

    const incomeTotal = (txStats?.income_in ?? 0) + (txStats?.income_transfer ?? 0);
    const expenseTotal = (txStats?.expense_in ?? 0) + (txStats?.expense_transfer ?? 0);
    const balance = initialBalance + incomeTotal - expenseTotal;

    items.push({
      id: accountSyncId,
      name: row.name,
      account_type: row.account_type,
      currency: row.currency,
      initial_balance: initialBalance,
      last_change_id: row.source_change_id,
      ledger_id: ledExtId,
      ledger_name: ledgerMeta[row.ledger_id as string]?.name ?? null,
      created_by_user_id: null,
      created_by_email: null,
      note: row.note,
      credit_limit: row.credit_limit,
      billing_day: row.billing_day,
      payment_due_day: row.payment_due_day,
      bank_name: row.bank_name,
      card_last_four: row.card_last_four,
      tx_count: txStats?.tx_count ?? 0,
      income_total: incomeTotal,
      expense_total: expenseTotal,
      balance,
    });
  }

  return c.json(items);
});

// ===========================================================================
// GET /read/workspace/categories - 跨账本分类聚合
// ===========================================================================

workspaceRouter.get('/categories', async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const ledgerId = c.req.query('ledger_id') ?? null;
  const filterUserId = c.req.query('user_id') ?? null;
  const q = c.req.query('q') ?? null;
  const limit = Math.min(parseInt(c.req.query('limit') ?? '500', 10), 5000);
  const offset = parseInt(c.req.query('offset') ?? '0', 10);

  // 含共享账本
  let ledgerQuery = `SELECT DISTINCT l.id, l.external_id, l.name FROM ledgers l
    LEFT JOIN ledger_members lm ON l.id = lm.ledger_id AND lm.user_id = ?
    WHERE l.user_id = ? OR lm.user_id = ?`;
  const ledgerParams: string[] = [userId, userId, userId];

  if (ledgerId) {
    ledgerQuery += ' AND l.external_id = ?';
    ledgerParams.push(ledgerId);
  }

  const ledgers = await db.prepare(ledgerQuery).bind(...ledgerParams).all<{ id: string; external_id: string; name: string | null }>();

  if (ledgers.results.length === 0) {
    return c.json([]);
  }

  const ledgerInternalIds = ledgers.results.map((l) => l.id);
  const ledgerMeta: Record<string, { external_id: string; name: string | null }> = {};
  ledgers.results.forEach((l) => {
    ledgerMeta[l.id] = { external_id: l.external_id, name: l.name };
  });

  let catQuery = `SELECT * FROM read_category_projection WHERE (ledger_id IN (${ledgerInternalIds.map(() => '?').join(',')}) OR ledger_id IS NULL)`;
  const catParams: string[] = [...ledgerInternalIds];

  if (filterUserId) {
    catQuery += ' AND user_id = ?';
    catParams.push(filterUserId);
  }

  if (q) {
    catQuery += ' AND name LIKE ?';
    catParams.push(`%${q}%`);
  }

  catQuery += ' ORDER BY kind, sort_order, LOWER(name) ASC LIMIT ? OFFSET ?';
  catParams.push(String(limit), String(offset));

  const catRows = await db.prepare(catQuery).bind(...catParams).all<Record<string, unknown>>();

  // 预聚合每个 category 的 tx_count
  const txCountMap: Record<string, number> = {};
  const txCountQuery = `SELECT category_sync_id, COUNT(*) as cnt FROM read_tx_projection WHERE ledger_id IN (${ledgerInternalIds.map(() => '?').join(',')}) AND category_sync_id IS NOT NULL GROUP BY category_sync_id`;
  const txCountRows = await db.prepare(txCountQuery).bind(...ledgerInternalIds).all<{ category_sync_id: string; cnt: number }>();
  for (const r of txCountRows.results) {
    txCountMap[r.category_sync_id] = r.cnt;
  }

  const items = catRows.results.map((row) => {
    const ledExtId = ledgerMeta[row.ledger_id as string]?.external_id ?? '';

    return {
      id: row.sync_id,
      name: row.name,
      kind: row.kind,
      level: row.level,
      sort_order: row.sort_order,
      icon: row.icon,
      icon_type: row.icon_type,
      custom_icon_path: row.custom_icon_path,
      icon_cloud_file_id: row.icon_cloud_file_id,
      icon_cloud_sha256: row.icon_cloud_sha256,
      parent_name: row.parent_name,
      last_change_id: row.source_change_id,
      ledger_id: ledExtId,
      ledger_name: ledgerMeta[row.ledger_id as string]?.name ?? null,
      created_by_user_id: null,
      created_by_email: null,
      tx_count: txCountMap[row.sync_id as string] ?? 0,
    };
  });

  return c.json(items);
});

// ===========================================================================
// GET /read/workspace/tags - 跨账本标签聚合
// ===========================================================================

workspaceRouter.get('/tags', async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const ledgerId = c.req.query('ledger_id') ?? null;
  const filterUserId = c.req.query('user_id') ?? null;
  const q = c.req.query('q') ?? null;
  const limit = Math.min(parseInt(c.req.query('limit') ?? '500', 10), 5000);
  const offset = parseInt(c.req.query('offset') ?? '0', 10);

  // 含共享账本
  let ledgerQuery = `SELECT DISTINCT l.id, l.external_id, l.name FROM ledgers l
    LEFT JOIN ledger_members lm ON l.id = lm.ledger_id AND lm.user_id = ?
    WHERE l.user_id = ? OR lm.user_id = ?`;
  const ledgerParams: string[] = [userId, userId, userId];

  if (ledgerId) {
    ledgerQuery += ' AND l.external_id = ?';
    ledgerParams.push(ledgerId);
  }

  const ledgers = await db.prepare(ledgerQuery).bind(...ledgerParams).all<{ id: string; external_id: string; name: string | null }>();

  if (ledgers.results.length === 0) {
    return c.json([]);
  }

  const ledgerInternalIds = ledgers.results.map((l) => l.id);
  const ledgerMeta: Record<string, { external_id: string; name: string | null }> = {};
  ledgers.results.forEach((l) => {
    ledgerMeta[l.id] = { external_id: l.external_id, name: l.name };
  });

  let tagQuery = `SELECT * FROM read_tag_projection WHERE (ledger_id IN (${ledgerInternalIds.map(() => '?').join(',')}) OR ledger_id IS NULL)`;
  const tagParams: string[] = [...ledgerInternalIds];

  if (filterUserId) {
    tagQuery += ' AND user_id = ?';
    tagParams.push(filterUserId);
  }

  if (q) {
    tagQuery += ' AND name LIKE ?';
    tagParams.push(`%${q}%`);
  }

  tagQuery += ' ORDER BY LOWER(name) ASC LIMIT ? OFFSET ?';
  tagParams.push(String(limit), String(offset));

  const tagRows = await db.prepare(tagQuery).bind(...tagParams).all<Record<string, unknown>>();

  // 预聚合每个 tag 的 tx 统计
  const tagStats: Record<string, { tx_count: number; expense_total: number; income_total: number }> = {};
  const tagRowsForStats = await db.prepare(`SELECT sync_id, ledger_id FROM read_tag_projection WHERE (ledger_id IN (${ledgerInternalIds.map(() => '?').join(',')}) OR ledger_id IS NULL)`).bind(...ledgerInternalIds).all<{ sync_id: string; ledger_id: string | null }>();
  const tagSyncIds = tagRowsForStats.results.map(r => r.sync_id);

  if (tagSyncIds.length > 0) {
    // 按 tag_sync_ids_json 匹配
    for (const tagId of tagSyncIds) {
      // 检查该标签是否为 user-global（ledger_id IS NULL）
      const tagRow = tagRowsForStats.results.find(r => r.sync_id === tagId);
      const isUserGlobal = tagRow && !tagRow.ledger_id;
      
      let txRows;
      if (isUserGlobal) {
        // user-global 标签：匹配所有账本的交易
        txRows = await db.prepare(`SELECT tx_type, amount FROM read_tx_projection WHERE tag_sync_ids_json LIKE ?`).bind(`%"${tagId}"%`).all<{ tx_type: string; amount: number }>();
      } else {
        // ledger-scoped 标签：只匹配对应账本的交易
        txRows = await db.prepare(`SELECT tx_type, amount FROM read_tx_projection WHERE ledger_id IN (${ledgerInternalIds.map(() => '?').join(',')}) AND tag_sync_ids_json LIKE ?`).bind(...ledgerInternalIds, `%"${tagId}"%`).all<{ tx_type: string; amount: number }>();
      }
      let txCount = 0, expenseTotal = 0, incomeTotal = 0;
      for (const r of txRows.results) {
        txCount++;
        if (r.tx_type === 'expense') expenseTotal += r.amount;
        else if (r.tx_type === 'income') incomeTotal += r.amount;
      }
      tagStats[tagId] = { tx_count: txCount, expense_total: expenseTotal, income_total: incomeTotal };
    }
  }

  const items = tagRows.results.map((row) => {
    const ledExtId = ledgerMeta[row.ledger_id as string]?.external_id ?? '';
    const stats = tagStats[row.sync_id as string] ?? { tx_count: 0, expense_total: 0, income_total: 0 };

    return {
      id: row.sync_id,
      name: row.name,
      color: row.color,
      last_change_id: row.source_change_id,
      ledger_id: ledExtId,
      ledger_name: ledgerMeta[row.ledger_id as string]?.name ?? null,
      created_by_user_id: null,
      created_by_email: null,
      tx_count: stats.tx_count,
      expense_total: stats.expense_total,
      income_total: stats.income_total,
    };
  });

  return c.json(items);
});

// ===========================================================================
// GET /read/workspace/budgets - 跨账本预算聚合
// ===========================================================================

workspaceRouter.get('/budgets', async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const ledgerId = c.req.query('ledger_id') ?? null;
  const q = c.req.query('q') ?? null;
  const limit = Math.min(parseInt(c.req.query('limit') ?? '500', 10), 5000);
  const offset = parseInt(c.req.query('offset') ?? '0', 10);

  // 含共享账本
  let ledgerQuery = `SELECT DISTINCT l.id, l.external_id, l.name FROM ledgers l
    LEFT JOIN ledger_members lm ON l.id = lm.ledger_id AND lm.user_id = ?
    WHERE l.user_id = ? OR lm.user_id = ?`;
  const ledgerParams: string[] = [userId, userId, userId];

  if (ledgerId) {
    ledgerQuery += ' AND l.external_id = ?';
    ledgerParams.push(ledgerId);
  }

  const ledgers = await db.prepare(ledgerQuery).bind(...ledgerParams).all<{ id: string; external_id: string; name: string | null }>();

  if (ledgers.results.length === 0) {
    return c.json([]);
  }

  const ledgerInternalIds = ledgers.results.map((l) => l.id);
  const ledgerMeta: Record<string, { external_id: string; name: string | null }> = {};
  ledgers.results.forEach((l) => {
    ledgerMeta[l.id] = { external_id: l.external_id, name: l.name };
  });

  let budgetQuery = `SELECT * FROM read_budget_projection WHERE ledger_id IN (${ledgerInternalIds.map(() => '?').join(',')})`;
  const budgetParams: string[] = [...ledgerInternalIds];

  budgetQuery += ' ORDER BY source_change_id DESC LIMIT ? OFFSET ?';
  budgetParams.push(String(limit), String(offset));

  const budgetRows = await db.prepare(budgetQuery).bind(...budgetParams).all<Record<string, unknown>>();

  const items = budgetRows.results.map((row) => {
    const ledExtId = ledgerMeta[row.ledger_id as string]?.external_id ?? '';

    return {
      id: row.sync_id,
      type: row.budget_type,
      category_id: row.category_sync_id,
      category_name: null,
      amount: row.amount,
      period: row.period,
      start_day: row.start_day,
      enabled: !!row.enabled,
      spent: 0,
      last_change_id: row.source_change_id,
      ledger_id: ledExtId,
      ledger_name: ledgerMeta[row.ledger_id as string]?.name ?? null,
      created_by_user_id: null,
      created_by_email: null,
    };
  });

  return c.json(items);
});

// ===========================================================================
// GET /read/workspace/ledger-counts - 账本总览统计
// ===========================================================================

workspaceRouter.get('/ledger-counts', async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const ledgerId = c.req.query('ledger_id') ?? null;
  const filterUserId = c.req.query('user_id') ?? null;

  // 含共享账本
  let ledgerQuery = `SELECT DISTINCT l.id FROM ledgers l
    LEFT JOIN ledger_members lm ON l.id = lm.ledger_id AND lm.user_id = ?
    WHERE l.user_id = ? OR lm.user_id = ?`;
  const ledgerParams: string[] = [userId, userId, userId];

  if (ledgerId) {
    ledgerQuery += ' AND l.external_id = ?';
    ledgerParams.push(ledgerId);
  }

  const ledgers = await db.prepare(ledgerQuery).bind(...ledgerParams).all<{ id: string }>();

  if (ledgers.results.length === 0) {
    return c.json({ tx_count: 0, days_since_first_tx: 0, distinct_days: 0, first_tx_at: null });
  }

  const ledgerInternalIds = ledgers.results.map((l) => l.id);

  const txCountRow = await db
    .prepare(`SELECT COUNT(*) as cnt, MIN(happened_at) as first_at FROM read_tx_projection WHERE ledger_id IN (${ledgerInternalIds.map(() => '?').join(',')})`)
    .bind(...ledgerInternalIds)
    .first<{ cnt: number; first_at: string | null }>();

  const txCount = txCountRow?.cnt ?? 0;
  const firstAt = txCountRow?.first_at ?? null;

  let daysSinceFirstTx = 0;
  if (firstAt) {
    const firstDate = new Date(firstAt);
    const now = new Date();
    daysSinceFirstTx = Math.floor((now.getTime() - firstDate.getTime()) / (1000 * 60 * 60 * 24)) + 1;
  }

  return c.json({
    tx_count: txCount,
    days_since_first_tx: daysSinceFirstTx,
    distinct_days: txCount,
    first_tx_at: firstAt,
  });
});

// ===========================================================================
// GET /read/workspace/analytics - 收支分析
// ===========================================================================

workspaceRouter.get('/analytics', async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const ledgerId = c.req.query('ledger_id') ?? null;
  const filterUserId = c.req.query('user_id') ?? null;
  const scope = c.req.query('scope') ?? 'month';
  const metric = c.req.query('metric') ?? 'expense';
  const period = c.req.query('period') ?? null;
  const tzOffsetMinutes = parseInt(c.req.query('tz_offset_minutes') ?? '0', 10);

  // 含共享账本
  let ledgerQuery = `SELECT DISTINCT l.id FROM ledgers l
    LEFT JOIN ledger_members lm ON l.id = lm.ledger_id AND lm.user_id = ?
    WHERE l.user_id = ? OR lm.user_id = ?`;
  const ledgerParams: string[] = [userId, userId, userId];

  if (ledgerId) {
    ledgerQuery += ' AND external_id = ?';
    ledgerParams.push(ledgerId);
  }

  const ledgers = await db.prepare(ledgerQuery).bind(...ledgerParams).all<{ id: string }>();

  if (ledgers.results.length === 0) {
    return c.json({
      summary: { transaction_count: 0, income_total: 0, expense_total: 0, balance: 0, distinct_days: 0, first_tx_at: null, last_tx_at: null },
      series: [],
      category_ranks: [],
      range: { scope, metric, period: null, start_at: null, end_at: null },
    });
  }

  const ledgerInternalIds = ledgers.results.map((l) => l.id);

  // exclude_from_stats=true 的交易不计入收支统计（与原版对齐）
  let txQuery = `SELECT tx_type, amount, happened_at, category_name FROM read_tx_projection WHERE ledger_id IN (${ledgerInternalIds.map(() => '?').join(',')}) AND (exclude_from_stats IS NULL OR exclude_from_stats = 0 OR exclude_from_stats = false)`;
  const txParams: (string | number)[] = [...ledgerInternalIds];

  if (period) {
    const [yearStr, monthStr] = period.split('-');
    const year = parseInt(yearStr, 10);
    const month = parseInt(monthStr, 10);
    if (year && month) {
      // 用时区偏移计算本地月份边界，再转回UTC
      const localStart = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0) - tzOffsetMinutes * 60000);
      const localEnd = new Date(Date.UTC(year, month, 1, 0, 0, 0) - tzOffsetMinutes * 60000);
      const startAt = localStart.toISOString();
      const endAt = localEnd.toISOString();
      txQuery += ' AND happened_at >= ? AND happened_at < ?';
      txParams.push(startAt, endAt);
    }
  }

  const txRows = await db
    .prepare(txQuery)
    .bind(...txParams)
    .all<{ tx_type: string; amount: number; happened_at: string; category_name: string | null }>();

  let incomeTotal = 0;
  let expenseTotal = 0;
  const seriesMap: Record<string, { expense: number; income: number }> = {};
  const categoryMap: Record<string, { expense: number; income: number; count: number }> = {};
  const distinctDays = new Set<string>();
  let firstTxAt: string | null = null;
  let lastTxAt: string | null = null;

  for (const tx of txRows.results) {
    if (tx.tx_type === 'income') {
      incomeTotal += tx.amount;
    } else if (tx.tx_type === 'expense') {
      expenseTotal += tx.amount;
    }

    const date = new Date(tx.happened_at);
    // 应用时区偏移后再切桶（与原版 _bucket_key 对齐）
    const localDate = new Date(date.getTime() + tzOffsetMinutes * 60000);
    let bucket: string;

    if (scope === 'month') {
      bucket = `${localDate.getUTCFullYear()}-${String(localDate.getUTCMonth() + 1).padStart(2, '0')}`;
    } else if (scope === 'year') {
      bucket = String(localDate.getUTCFullYear());
    } else {
      const weekStart = new Date(localDate);
      weekStart.setUTCDate(localDate.getUTCDate() - localDate.getUTCDay());
      bucket = weekStart.toISOString().slice(0, 10);
    }

    // distinct_days 用时区调整后的日期
    distinctDays.add(localDate.toISOString().slice(0, 10));

    // 记录首尾交易时间
    if (!firstTxAt || tx.happened_at < firstTxAt) firstTxAt = tx.happened_at;
    if (!lastTxAt || tx.happened_at > lastTxAt) lastTxAt = tx.happened_at;

    if (!seriesMap[bucket]) {
      seriesMap[bucket] = { expense: 0, income: 0 };
    }
    if (!categoryMap[tx.category_name ?? 'Uncategorized']) {
      categoryMap[tx.category_name ?? 'Uncategorized'] = { expense: 0, income: 0, count: 0 };
    }

    if (tx.tx_type === 'income') {
      seriesMap[bucket].income += tx.amount;
      categoryMap[tx.category_name ?? 'Uncategorized'].income += tx.amount;
    } else if (tx.tx_type === 'expense') {
      seriesMap[bucket].expense += tx.amount;
      categoryMap[tx.category_name ?? 'Uncategorized'].expense += tx.amount;
    }
    categoryMap[tx.category_name ?? 'Uncategorized'].count += 1;
  }

  const series = Object.entries(seriesMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([bucket, data]) => ({
      bucket,
      expense: data.expense,
      income: data.income,
      balance: data.income - data.expense,
    }));

  const metricKey = metric === 'income' ? 'income' : 'expense';
  const categoryRanks = Object.entries(categoryMap)
    .filter(([, data]) => data[metricKey] > 0)
    .map(([category_name, data]) => ({
      category_name,
      total: data[metricKey],
      tx_count: data.count,
    }))
    .sort((a, b) => b.total - a.total);

  return c.json({
    summary: {
      transaction_count: txRows.results.length,
      income_total: incomeTotal,
      expense_total: expenseTotal,
      balance: incomeTotal - expenseTotal,
      distinct_days: distinctDays.size,
      first_tx_at: firstTxAt,
      last_tx_at: lastTxAt,
    },
    series,
    category_ranks: categoryRanks,
    anomaly_months: [],
    range: { scope, metric, period, start_at: null, end_at: null },
  });
});

// ===========================
// Shared Ledger Schemas
// ===========================

const InviteSchema = z.object({
  expires_in_hours: z.number().int().min(1).max(168).default(24),
  target_role: z.enum(['editor']).default('editor'),
});

const JoinSchema = z.object({
  invite_code: z.string().min(6).max(12),
});

const UpdateLedgerSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  currency: z.string().min(1).max(16).optional(),
});

const TransferSchema = z.object({
  target_user_id: z.string().min(1),
});

const MemberStatsQuerySchema = z.object({
  scope: z.enum(['month', 'year', 'all']).default('month'),
  period: z.string().optional(),
  tz_offset_minutes: z.coerce.number().int().default(0),
});

// ===========================================================================
// POST /workspace/ledgers/:id/invite - 生成邀请码（仅 Owner）
// ===========================================================================

workspaceRouter.post('/ledgers/:id/invite', zValidator('json', InviteSchema), async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const ledgerExternalId = c.req.param('id');
  const req = c.req.valid('json');

  const ledger = await db
    .prepare('SELECT id, user_id, is_shared FROM ledgers WHERE user_id = ? AND external_id = ?')
    .bind(userId, ledgerExternalId)
    .first<{ id: string; user_id: string; is_shared: number }>();

  if (!ledger) {
    return c.json({ error: 'Ledger not found or not owned by you' }, 404);
  }

  if (ledger.user_id !== userId) {
    return c.json({ error: 'Only the owner can generate invite codes' }, 403);
  }

  const memberCount = await db
    .prepare('SELECT COUNT(*) as cnt FROM ledger_members WHERE ledger_id = ?')
    .bind(ledger.id)
    .first<{ cnt: number }>();

  if ((memberCount?.cnt ?? 0) >= 4) {
    return c.json({ error: 'Ledger has reached the maximum of 5 members (owner + 4 editors)' }, 400);
  }

  const activeInviteCount = await db
    .prepare(
      `SELECT COUNT(*) as cnt FROM ledger_invites
       WHERE ledger_id = ? AND used_at IS NULL AND expires_at > ?`
    )
    .bind(ledger.id, nowUtc())
    .first<{ cnt: number }>();

  if ((activeInviteCount?.cnt ?? 0) >= 10) {
    return c.json({ error: 'Ledger has reached the maximum of 10 active invites' }, 400);
  }

  let inviteCode = generateInviteCode();
  let attempts = 0;
  while (attempts < 10) {
    const existing = await db
      .prepare('SELECT id FROM ledger_invites WHERE code = ?')
      .bind(inviteCode)
      .first();
    if (!existing) break;
    inviteCode = generateInviteCode();
    attempts++;
  }

  const expiresAt = new Date(Date.now() + req.expires_in_hours * 3600 * 1000).toISOString();

  await db
    .prepare(
      `INSERT INTO ledger_invites (id, ledger_id, code, target_role, invited_by, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(randomUUID(), ledger.id, inviteCode, req.target_role, userId, expiresAt)
    .run();

  await db
    .prepare('UPDATE ledgers SET is_shared = 1 WHERE id = ?')
    .bind(ledger.id)
    .run();

  await insertAuditLog({
    db, userId, ledgerId: ledger.id, action: 'invite', entityType: 'ledger_invites', entityId: inviteCode,
    details: { expires_at: expiresAt, target_role: req.target_role },
  });

  return c.json({
    code: inviteCode,
    expires_at: expiresAt,
    target_role: req.target_role,
    share_link: `/invite/${inviteCode}`,
  });
});

// ===========================================================================
// GET /workspace/ledgers/:id/invites - 列出未过期未使用的邀请
// ===========================================================================

workspaceRouter.get('/ledgers/:id/invites', async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const ledgerExternalId = c.req.param('id');

  const ledger = await db
    .prepare('SELECT id, user_id FROM ledgers WHERE user_id = ? AND external_id = ?')
    .bind(userId, ledgerExternalId)
    .first<{ id: string; user_id: string }>();

  if (!ledger) {
    return c.json({ error: 'Ledger not found or not owned by you' }, 404);
  }

  if (ledger.user_id !== userId) {
    return c.json({ error: 'Only the owner can list invites' }, 403);
  }

  const invites = await db
    .prepare(
      `SELECT id, code, target_role, invited_by, expires_at, used_at, used_by, created_at
       FROM ledger_invites
       WHERE ledger_id = ? AND used_at IS NULL AND expires_at > ?
       ORDER BY created_at DESC`
    )
    .bind(ledger.id, nowUtc())
    .all<{
      id: string;
      code: string;
      target_role: string;
      invited_by: string;
      expires_at: string;
      used_at: string | null;
      used_by: string | null;
      created_at: string;
    }>();

  return c.json({
    invites: invites.results.map((inv) => ({
      id: inv.id,
      code: inv.code,
      target_role: inv.target_role,
      invited_by: inv.invited_by,
      expires_at: inv.expires_at,
      created_at: inv.created_at,
      share_link: `/invite/${inv.code}`,
    })),
  });
});

// ===========================================================================
// DELETE /workspace/ledgers/:id/invites/:code - 撤销邀请
// ===========================================================================

workspaceRouter.delete('/ledgers/:id/invites/:code', async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const ledgerExternalId = c.req.param('id');
  const inviteCode = c.req.param('code');

  const ledger = await db
    .prepare('SELECT id, user_id FROM ledgers WHERE user_id = ? AND external_id = ?')
    .bind(userId, ledgerExternalId)
    .first<{ id: string; user_id: string }>();

  if (!ledger) {
    return c.json({ error: 'Ledger not found or not owned by you' }, 404);
  }

  if (ledger.user_id !== userId) {
    return c.json({ error: 'Only the owner can revoke invites' }, 403);
  }

  const result = await db
    .prepare(
      `UPDATE ledger_invites SET expires_at = '1970-01-01T00:00:00.000Z'
       WHERE ledger_id = ? AND code = ? AND used_at IS NULL`
    )
    .bind(ledger.id, inviteCode)
    .run();

  if (result.meta.changes === 0) {
    return c.json({ error: 'Invite not found or already used/expired' }, 404);
  }

  await insertAuditLog({
    db, userId, ledgerId: ledger.id, action: 'revoke_invite', entityType: 'ledger_invites', entityId: inviteCode,
  });

  return c.json({ success: true });
});

// ===========================================================================
// POST /workspace/invites/:code/preview - 预览邀请详情（公开端点）
// ===========================================================================

workspaceRouter.post('/invites/:code/preview', async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const inviteCode = c.req.param('code');

  const invite = await db
    .prepare(
      `SELECT li.id, li.code, li.target_role, li.expires_at, li.used_at, li.invited_by,
              l.external_id, l.name as ledger_name, l.currency,
              u.email as owner_email
       FROM ledger_invites li
       JOIN ledgers l ON li.ledger_id = l.id
       JOIN users u ON l.user_id = u.id
       WHERE li.code = ?`
    )
    .bind(inviteCode)
    .first<{
      id: string;
      code: string;
      target_role: string;
      expires_at: string;
      used_at: string | null;
      invited_by: string;
      external_id: string;
      ledger_name: string | null;
      currency: string;
      owner_email: string;
    }>();

  if (!invite) {
    return c.json({ error: 'Invalid invite code' }, 404);
  }

  if (invite.used_at) {
    return c.json({ error: 'Invite has already been used' }, 410);
  }

  if (new Date(invite.expires_at) < new Date()) {
    return c.json({ error: 'Invite has expired' }, 410);
  }

  if (invite.invited_by === userId) {
    return c.json({ error: 'Cannot accept your own invite' }, 400);
  }

  await insertAuditLog({
    db, userId, action: 'preview_invite', entityType: 'ledger_invites', entityId: inviteCode,
  });

  return c.json({
    code: invite.code,
    target_role: invite.target_role,
    ledger_id: invite.external_id,
    ledger_name: invite.ledger_name,
    currency: invite.currency,
    owner_email: invite.owner_email,
    expires_at: invite.expires_at,
  });
});

// ===========================================================================
// POST /workspace/ledgers/join - 通过邀请码加入账本
// ===========================================================================

workspaceRouter.post('/ledgers/join', zValidator('json', JoinSchema), async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const req = c.req.valid('json');

  const invite = await db
    .prepare(
      `SELECT li.id, li.ledger_id, li.code, li.target_role, li.expires_at, li.used_at, li.invited_by,
              l.external_id, l.name as ledger_name, l.user_id as owner_user_id
       FROM ledger_invites li
       JOIN ledgers l ON li.ledger_id = l.id
       WHERE li.code = ?`
    )
    .bind(req.invite_code)
    .first<{
      id: string;
      ledger_id: string;
      code: string;
      target_role: string;
      expires_at: string;
      used_at: string | null;
      invited_by: string;
      external_id: string;
      ledger_name: string | null;
      owner_user_id: string;
    }>();

  if (!invite) {
    return c.json({ error: 'Invalid invite code' }, 404);
  }

  if (invite.used_at) {
    return c.json({ error: 'Invite has already been used' }, 410);
  }

  if (new Date(invite.expires_at) < new Date()) {
    return c.json({ error: 'Invite code has expired' }, 410);
  }

  if (invite.owner_user_id === userId) {
    return c.json({ error: 'Cannot join your own ledger' }, 400);
  }

  const existingMember = await db
    .prepare('SELECT id FROM ledger_members WHERE ledger_id = ? AND user_id = ?')
    .bind(invite.ledger_id, userId)
    .first();

  if (existingMember) {
    return c.json({ message: 'Already a member', ledger_id: invite.external_id, ledger_name: invite.ledger_name });
  }

  const memberCount = await db
    .prepare('SELECT COUNT(*) as cnt FROM ledger_members WHERE ledger_id = ?')
    .bind(invite.ledger_id)
    .first<{ cnt: number }>();

  if ((memberCount?.cnt ?? 0) >= 4) {
    return c.json({ error: 'Ledger has reached the maximum member limit' }, 400);
  }

  await db
    .prepare('INSERT INTO ledger_members (ledger_id, user_id, role) VALUES (?, ?, ?)')
    .bind(invite.ledger_id, userId, invite.target_role)
    .run();

  await db
    .prepare('UPDATE ledger_invites SET used_at = ?, used_by = ? WHERE id = ?')
    .bind(nowUtc(), userId, invite.id)
    .run();

  await insertAuditLog({
    db, userId, ledgerId: invite.ledger_id, action: 'join', entityType: 'ledger', entityId: invite.external_id,
    details: { invite_code: invite.code, target_role: invite.target_role },
  });

  return c.json({
    ledger_id: invite.external_id,
    ledger_name: invite.ledger_name,
    role: invite.target_role,
  });
});

// ===========================================================================
// GET /workspace/ledgers/:id/members - 列出成员
// ===========================================================================

workspaceRouter.get('/ledgers/:id/members', async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const ledgerExternalId = c.req.param('id');

  const ledger = await db
    .prepare('SELECT id, user_id FROM ledgers WHERE external_id = ? AND (user_id = ? OR is_shared = 1)')
    .bind(ledgerExternalId, userId)
    .first<{ id: string; user_id: string }>();

  if (!ledger) {
    return c.json({ error: 'Ledger not found or access denied' }, 404);
  }

  const members = await db
    .prepare(`
      SELECT lm.user_id, lm.role, lm.joined_at, u.email
      FROM ledger_members lm
      JOIN users u ON lm.user_id = u.id
      WHERE lm.ledger_id = ?
    `)
    .bind(ledger.id)
    .all<{ user_id: string; role: string; joined_at: string; email: string }>();

  const owner = await db
    .prepare('SELECT id, email FROM users WHERE id = ?')
    .bind(ledger.user_id)
    .first<{ id: string; email: string }>();

  const result = [
    ...(owner ? [{ user_id: owner.id, role: 'owner', joined_at: '', email: owner.email }] : []),
    ...members.results,
  ];

  return c.json({ members: result });
});

// ===========================================================================
// DELETE /workspace/ledgers/:id/members/:memberUserId - 移除成员（仅 Owner）
// ===========================================================================

workspaceRouter.delete('/ledgers/:id/members/:memberUserId', async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const ledgerExternalId = c.req.param('id');
  const memberUserId = c.req.param('memberUserId');

  const ledger = await db
    .prepare('SELECT id, user_id FROM ledgers WHERE user_id = ? AND external_id = ?')
    .bind(userId, ledgerExternalId)
    .first<{ id: string; user_id: string }>();

  if (!ledger) {
    return c.json({ error: 'Ledger not found or not owned by you' }, 404);
  }

  if (ledger.user_id !== userId) {
    return c.json({ error: 'Only the owner can remove members' }, 403);
  }

  if (memberUserId === userId) {
    return c.json({ error: 'Cannot remove the owner' }, 400);
  }

  const result = await db
    .prepare('DELETE FROM ledger_members WHERE ledger_id = ? AND user_id = ?')
    .bind(ledger.id, memberUserId)
    .run();

  if (result.meta.changes === 0) {
    return c.json({ error: 'Member not found' }, 404);
  }

  await insertAuditLog({
    db, userId, ledgerId: ledger.id, action: 'remove_member', entityType: 'ledger', entityId: ledgerExternalId,
    details: { removed_user_id: memberUserId },
  });

  // WS 广播 member_change（与原版 broadcast_to_ledger + extra_user_ids 对齐）
  try {
    const members = await db.prepare('SELECT user_id FROM ledger_members WHERE ledger_id = ?').bind(ledger.id).all<{ user_id: string }>();
    const allUserIds = new Set([userId, ...members.results.map(m => m.user_id), memberUserId]);
    const payload = { type: 'member_change', ledgerId: ledgerExternalId, changeType: 'removed', userId: memberUserId, isSelf: false };
    for (const uid of allUserIds) {
      try {
        const doId = c.env.BEECOUNT_DO.idFromName(`ws-${uid}`);
        const doStub = c.env.BEECOUNT_DO.get(doId);
        await doStub.fetch(new Request('https://dummy/broadcast', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: JSON.stringify(payload) }) }));
      } catch {}
      try {
        const { getWsManager } = await import('../lib/ws-manager');
        await getWsManager().broadcastToUser(uid, payload);
      } catch {}
    }
  } catch {}

  return c.json({ success: true });
});

// ===========================================================================
// PATCH /workspace/ledgers/:id - 修改账本元数据（仅 Owner）
// ===========================================================================

workspaceRouter.patch('/ledgers/:id', zValidator('json', UpdateLedgerSchema), async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const ledgerExternalId = c.req.param('id');
  const req = c.req.valid('json');

  const ledger = await db
    .prepare('SELECT id, user_id, name, currency FROM ledgers WHERE user_id = ? AND external_id = ?')
    .bind(userId, ledgerExternalId)
    .first<{ id: string; user_id: string; name: string | null; currency: string }>();

  if (!ledger) {
    return c.json({ error: 'Ledger not found or not owned by you' }, 404);
  }

  if (ledger.user_id !== userId) {
    return c.json({ error: 'Only the owner can update ledger settings' }, 403);
  }

  const newName = req.name ?? ledger.name;
  const newCurrency = req.currency ?? ledger.currency;

  await db
    .prepare('UPDATE ledgers SET name = ?, currency = ? WHERE id = ?')
    .bind(newName, newCurrency, ledger.id)
    .run();

  await insertAuditLog({
    db, userId, ledgerId: ledger.id, action: 'update_meta', entityType: 'ledger', entityId: ledgerExternalId,
    details: { name: newName, currency: newCurrency },
  });

  return c.json({ ledger_id: ledgerExternalId, name: newName, currency: newCurrency });
});

// ===========================================================================
// GET /workspace/ledgers/:id/member-stats - 成员统计
// ===========================================================================

workspaceRouter.get('/ledgers/:id/member-stats', zValidator('query', MemberStatsQuerySchema), async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const ledgerExternalId = c.req.param('id');
  const { scope, period, tz_offset_minutes } = c.req.valid('query');

  const ledger = await findLedgerForUser(db, ledgerExternalId, userId);
  if (!ledger) {
    return c.json({ error: 'Ledger not found or access denied' }, 404);
  }

  const owner = await db
    .prepare('SELECT id FROM users WHERE id = ?')
    .bind(ledger.user_id)
    .first<{ id: string }>();

  const members = await db
    .prepare('SELECT user_id FROM ledger_members WHERE ledger_id = ?')
    .bind(ledger.id)
    .all<{ user_id: string }>();

  const allUserIds = [
    ...(owner ? [owner.id] : []),
    ...members.results.map((m) => m.user_id),
  ];

  let dateFilter = '';
  const dateParams: string[] = [];

  if (scope === 'month') {
    const now = new Date();
    const tzMs = tz_offset_minutes * 60 * 1000;
    const localNow = new Date(now.getTime() + tzMs);
    const year = localNow.getUTCFullYear();
    const month = localNow.getUTCMonth() + 1;
    const startOfMonth = `${year}-${String(month).padStart(2, '0')}-01T00:00:00.000Z`;
    dateFilter = 'AND happened_at >= ?';
    dateParams.push(startOfMonth);
  } else if (scope === 'year') {
    const now = new Date();
    const tzMs = tz_offset_minutes * 60 * 1000;
    const localNow = new Date(now.getTime() + tzMs);
    const year = localNow.getUTCFullYear();
    const startOfYear = `${year}-01-01T00:00:00.000Z`;
    dateFilter = 'AND happened_at >= ?';
    dateParams.push(startOfYear);
  } else if (period) {
    dateFilter = 'AND happened_at >= ?';
    dateParams.push(period);
  }

  const stats: Record<string, { income: number; expense: number; tx_count: number }> = {};
  for (const uid of allUserIds) {
    stats[uid] = { income: 0, expense: 0, tx_count: 0 };
  }

  if (allUserIds.length > 0) {
    const placeholders = allUserIds.map(() => '?').join(',');
    const txRows = await db
      .prepare(
        `SELECT created_by_user_id, tx_type, amount
         FROM read_tx_projection
         WHERE ledger_id = ? AND created_by_user_id IN (${placeholders})
           AND tx_type != 'transfer'
           ${dateFilter}`
      )
      .bind(ledger.id, ...allUserIds, ...dateParams)
      .all<{ created_by_user_id: string | null; tx_type: string; amount: number }>();

    for (const tx of txRows.results) {
      if (!tx.created_by_user_id) continue;
      if (!stats[tx.created_by_user_id]) continue;
      stats[tx.created_by_user_id].tx_count += 1;
      if (tx.tx_type === 'income') {
        stats[tx.created_by_user_id].income += tx.amount;
      } else if (tx.tx_type === 'expense') {
        stats[tx.created_by_user_id].expense += tx.amount;
      }
    }
  }

  const result = allUserIds.map((uid) => ({
    user_id: uid,
    income: stats[uid].income,
    expense: stats[uid].expense,
    tx_count: stats[uid].tx_count,
  }));

  return c.json({ member_stats: result });
});

// ===========================================================================
// GET /workspace/ledgers/:id/shared-resources - 共享资源
// ===========================================================================

workspaceRouter.get('/ledgers/:id/shared-resources', async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const ledgerExternalId = c.req.param('id');

  const ledger = await db
    .prepare('SELECT id, user_id FROM ledgers WHERE external_id = ?')
    .bind(ledgerExternalId)
    .first<{ id: string; user_id: string }>();

  if (!ledger) {
    return c.json({ error: 'Ledger not found' }, 404);
  }

  const role = await getUserRoleInLedger(db, ledger.id, userId);
  if (!role) {
    return c.json({ error: 'Access denied' }, 403);
  }

  const ownerId = ledger.user_id;

  const ownerCategories = await db
    .prepare(
      `SELECT DISTINCT name, kind, level, sort_order, icon, icon_type
       FROM read_category_projection
       WHERE user_id = ?
       ORDER BY kind, sort_order, LOWER(name) ASC`
    )
    .bind(ownerId)
    .all<{ name: string | null; kind: string | null; level: number | null; sort_order: number | null; icon: string | null; icon_type: string | null }>();

  const ownerAccounts = await db
    .prepare(
      `SELECT DISTINCT name, account_type, currency
       FROM read_account_projection
       WHERE user_id = ?
       ORDER BY LOWER(name) ASC`
    )
    .bind(ownerId)
    .all<{ name: string | null; account_type: string | null; currency: string | null }>();

  const ownerTags = await db
    .prepare(
      `SELECT DISTINCT name, color
       FROM read_tag_projection
       WHERE user_id = ?
       ORDER BY LOWER(name) ASC`
    )
    .bind(ownerId)
    .all<{ name: string | null; color: string | null }>();

  return c.json({
    categories: ownerCategories.results.map((cat) => ({
      name: cat.name,
      kind: cat.kind,
      level: cat.level,
      sort_order: cat.sort_order,
      icon: cat.icon,
      icon_type: cat.icon_type,
    })),
    accounts: ownerAccounts.results.map((acct) => ({
      name: acct.name,
      account_type: acct.account_type,
      currency: acct.currency,
    })),
    tags: ownerTags.results.map((tag) => ({
      name: tag.name,
      color: tag.color,
    })),
  });
});

// ===========================================================================
// POST /workspace/ledgers/:id/transfer - 转让 Owner
// ===========================================================================

workspaceRouter.post('/ledgers/:id/transfer', zValidator('json', TransferSchema), async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const ledgerExternalId = c.req.param('id');
  const req = c.req.valid('json');

  const ledger = await db
    .prepare('SELECT id, user_id FROM ledgers WHERE user_id = ? AND external_id = ?')
    .bind(userId, ledgerExternalId)
    .first<{ id: string; user_id: string }>();

  if (!ledger) {
    return c.json({ error: 'Ledger not found or not owned by you' }, 404);
  }

  if (ledger.user_id !== userId) {
    return c.json({ error: 'Only the owner can transfer ownership' }, 403);
  }

  if (req.target_user_id === userId) {
    return c.json({ error: 'Cannot transfer ownership to yourself' }, 400);
  }

  const targetMember = await db
    .prepare('SELECT id, user_id, role FROM ledger_members WHERE ledger_id = ? AND user_id = ?')
    .bind(ledger.id, req.target_user_id)
    .first<{ id: string; user_id: string; role: string }>();

  if (!targetMember) {
    return c.json({ error: 'Target user is not a member of this ledger' }, 400);
  }

  await db
    .prepare('UPDATE ledgers SET user_id = ? WHERE id = ?')
    .bind(req.target_user_id, ledger.id)
    .run();

  await db
    .prepare('DELETE FROM ledger_members WHERE ledger_id = ? AND user_id = ?')
    .bind(ledger.id, req.target_user_id)
    .run();

  const existingOwnerMember = await db
    .prepare('SELECT id FROM ledger_members WHERE ledger_id = ? AND user_id = ?')
    .bind(ledger.id, userId)
    .first();

  if (!existingOwnerMember) {
    await db
      .prepare('INSERT INTO ledger_members (ledger_id, user_id, role) VALUES (?, ?, ?)')
      .bind(ledger.id, userId, 'editor')
      .run();
  }

  await insertAuditLog({
    db, userId, ledgerId: ledger.id, action: 'transfer_owner', entityType: 'ledger', entityId: ledgerExternalId,
    details: { from_user_id: userId, to_user_id: req.target_user_id },
  });

  // WS 广播双 role_changed（与原版对齐）
  try {
    const members = await db.prepare('SELECT user_id FROM ledger_members WHERE ledger_id = ?').bind(ledger.id).all<{ user_id: string }>();
    const allUserIds = new Set([userId, ...members.results.map(m => m.user_id)]);
    const events = [
      { type: 'member_change', ledgerId: ledgerExternalId, changeType: 'role_changed', userId: req.target_user_id, newRole: 'owner' },
      { type: 'member_change', ledgerId: ledgerExternalId, changeType: 'role_changed', userId: userId, newRole: 'editor' },
    ];
    for (const uid of allUserIds) {
      for (const payload of events) {
        try {
          const doId = c.env.BEECOUNT_DO.idFromName(`ws-${uid}`);
          const doStub = c.env.BEECOUNT_DO.get(doId);
          await doStub.fetch(new Request('https://dummy/broadcast', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: JSON.stringify(payload) }) }));
        } catch {}
        try {
          const { getWsManager } = await import('../lib/ws-manager');
          await getWsManager().broadcastToUser(uid, payload);
        } catch {}
      }
    }
  } catch {}

  return c.json({ success: true, new_owner_id: req.target_user_id });
});

// ===========================================================================
// GET /read/workspace/net-worth-history - 净资产历史
// ===========================================================================

workspaceRouter.get('/net-worth-history', async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;

  const ledgers = await db
    .prepare('SELECT id, external_id, currency FROM ledgers WHERE user_id = ?')
    .bind(userId)
    .all<{ id: string; external_id: string; currency: string }>();

  if (ledgers.results.length === 0) {
    return c.json({ series: [], multi_currency: false });
  }

  const ledgerInternalIds = ledgers.results.map(l => l.id);
  const placeholders = ledgerInternalIds.map(() => '?').join(',');

  // 获取所有账户
  const accounts = await db
    .prepare(`SELECT sync_id, initial_balance, currency FROM read_account_projection WHERE user_id = ?`)
    .bind(userId)
    .all<{ sync_id: string; initial_balance: number; currency: string | null }>();

  // 获取所有交易
  const txs = await db
    .prepare(`SELECT happened_at, tx_type, amount, account_sync_id, from_account_sync_id, to_account_sync_id FROM read_tx_projection WHERE ledger_id IN (${placeholders})`)
    .bind(...ledgerInternalIds)
    .all<{ happened_at: string; tx_type: string; amount: number; account_sync_id: string | null; from_account_sync_id: string | null; to_account_sync_id: string | null }>();

  // 检查是否多币种
  const currencies = new Set(accounts.results.map(a => a.currency).filter(Boolean));
  const multiCurrency = currencies.size > 1;

  // 按月聚合
  const monthlyMap: Record<string, { net_worth: number; assets: number; liabilities: number }> = {};

  // 计算初始余额总和
  let totalAssets = 0;
  let totalLiabilities = 0;
  for (const acc of accounts.results) {
    const bal = acc.initial_balance ?? 0;
    if (bal >= 0) totalAssets += bal;
    else totalLiabilities += Math.abs(bal);
  }

  // 按月累加交易
  for (const tx of txs.results) {
    const month = tx.happened_at.slice(0, 7); // YYYY-MM
    if (!monthlyMap[month]) {
      monthlyMap[month] = { net_worth: 0, assets: 0, liabilities: 0 };
    }

    if (tx.tx_type === 'income') {
      monthlyMap[month].assets += tx.amount;
    } else if (tx.tx_type === 'expense') {
      monthlyMap[month].liabilities += tx.amount;
    } else if (tx.tx_type === 'transfer') {
      // 转账不影响净值
    }
  }

  // 构建 series
  const series = Object.entries(monthlyMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([bucket, data]) => ({
      bucket,
      net_worth: totalAssets + data.assets - totalLiabilities - data.liabilities,
      assets: totalAssets + data.assets,
      liabilities: totalLiabilities + data.liabilities,
    }));

  return c.json({ series, multi_currency: multiCurrency });
});

export default workspaceRouter;
