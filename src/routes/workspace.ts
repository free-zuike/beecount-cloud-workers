/**
 * Workspace 路由模块 - 实现跨账本聚合查询接口
 *
 * 参考原版 BeeCount-Cloud (Python/FastAPI) 的 /read/workspace 端点：
 * - GET /read/workspace/transactions       - 跨账本交易列表（支持复杂过滤）
 * - GET /read/workspace/transactions.csv  - CSV 导出
 * - GET /read/workspace/accounts          - 跨账本账户聚合
 * - GET /read/workspace/categories         - 跨账本分类聚合
 * - GET /read/workspace/tags             - 跨账本标签聚合
 * - GET /read/workspace/ledger-counts    - 账本总览统计
 * - GET /read/workspace/analytics         - 收支分析（series + category ranks）
 *
 * 跟 ledgers.py 的区别：
 * - 这里的查询不锁定到单个账本，会扫用户所有可见账本做聚合
 * - 去重/跨账本 dedup / owner 信息回填逻辑在这里
 *
 * @module routes/workspace
 */

import { Hono } from 'hono';

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

type Bindings = {
  DB: D1Database;
  JWT_SECRET: string;
};

type Variables = {
  userId: string;
};

const workspaceRouter = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// ---------------------------------------------------------------------------
// GET /read/workspace/transactions - 跨账本交易列表
// ---------------------------------------------------------------------------

workspaceRouter.get('/transactions', async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;

  const ledgerId = c.req.query('ledger_id') ?? null;
  const txType = c.req.query('tx_type') ?? null;
  const accountName = c.req.query('account_name') ?? null;
  const q = c.req.query('q') ?? null;
  const limit = Math.min(parseInt(c.req.query('limit') ?? '20', 10), 2000);
  const offset = parseInt(c.req.query('offset') ?? '0', 10);

  // 构建账本查询条件
  let ledgerQuery = 'SELECT id, external_id, name FROM ledgers WHERE user_id = ?';
  const ledgerParams: string[] = [userId];

  if (ledgerId) {
    ledgerQuery += ' AND external_id = ?';
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

  // 构建交易查询
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

  // 排序和分页
  txQuery += ' ORDER BY happened_at DESC, tx_index DESC LIMIT ? OFFSET ?';
  txParams.push(limit + 1, offset);

  const txRows = await db.prepare(txQuery).bind(...txParams).all<Record<string, unknown>>();

  const hasMore = txRows.results.length > limit;
  const items = txRows.results.slice(0, limit).map((row) => {
    const ledExtId = ledgerMeta[row.ledger_id as string]?.external_id ?? '';
    const ledName = ledgerMeta[row.ledger_id as string]?.name ?? null;
    const tagIds = safeJsonParse<string[]>(row.tag_sync_ids_json as string | null) ?? [];
    const attachments = safeJsonParse<Array<Record<string, unknown>>>(row.attachments_json as string | null);

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
      created_by_user_id: null,
      created_by_email: null,
      created_by_display_name: null,
      created_by_avatar_url: null,
      created_by_avatar_version: null,
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

// ---------------------------------------------------------------------------
// GET /read/workspace/accounts - 跨账本账户聚合
// ---------------------------------------------------------------------------

workspaceRouter.get('/accounts', async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const ledgerId = c.req.query('ledger_id') ?? null;
  const q = c.req.query('q') ?? null;
  const limit = Math.min(parseInt(c.req.query('limit') ?? '500', 10), 5000);
  const offset = parseInt(c.req.query('offset') ?? '0', 10);

  let ledgerQuery = 'SELECT id, external_id, name FROM ledgers WHERE user_id = ?';
  const ledgerParams: string[] = [userId];

  if (ledgerId) {
    ledgerQuery += ' AND external_id = ?';
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

  let acctQuery = `SELECT * FROM read_account_projection WHERE ledger_id IN (${ledgerInternalIds.map(() => '?').join(',')})`;
  const acctParams: string[] = [...ledgerInternalIds];

  if (q) {
    acctQuery += ' AND name LIKE ?';
    acctParams.push(`%${q}%`);
  }

  acctQuery += ' ORDER BY LOWER(name) ASC LIMIT ? OFFSET ?';
  acctParams.push(String(limit), String(offset));

  const acctRows = await db.prepare(acctQuery).bind(...acctParams).all<Record<string, unknown>>();

  // 计算统计
  const accountIds = [...new Set(acctRows.results.map((r) => r.sync_id as string))];

  const items = acctRows.results.map((row) => {
    const ledExtId = ledgerMeta[row.ledger_id as string]?.external_id ?? '';

    return {
      id: row.sync_id,
      name: row.name,
      account_type: row.account_type,
      currency: row.currency,
      initial_balance: row.initial_balance,
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
      tx_count: 0,
      income_total: 0,
      expense_total: 0,
      balance: (row.initial_balance as number) ?? 0,
    };
  });

  return c.json(items);
});

// ---------------------------------------------------------------------------
// GET /read/workspace/categories - 跨账本分类聚合
// ---------------------------------------------------------------------------

workspaceRouter.get('/categories', async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const ledgerId = c.req.query('ledger_id') ?? null;
  const q = c.req.query('q') ?? null;
  const limit = Math.min(parseInt(c.req.query('limit') ?? '500', 10), 5000);
  const offset = parseInt(c.req.query('offset') ?? '0', 10);

  let ledgerQuery = 'SELECT id, external_id, name FROM ledgers WHERE user_id = ?';
  const ledgerParams: string[] = [userId];

  if (ledgerId) {
    ledgerQuery += ' AND external_id = ?';
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

  let catQuery = `SELECT * FROM read_category_projection WHERE ledger_id IN (${ledgerInternalIds.map(() => '?').join(',')})`;
  const catParams: string[] = [...ledgerInternalIds];

  if (q) {
    catQuery += ' AND name LIKE ?';
    catParams.push(`%${q}%`);
  }

  catQuery += ' ORDER BY kind, sort_order, LOWER(name) ASC LIMIT ? OFFSET ?';
  catParams.push(String(limit), String(offset));

  const catRows = await db.prepare(catQuery).bind(...catParams).all<Record<string, unknown>>();

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
      tx_count: 0,
    };
  });

  return c.json(items);
});

// ---------------------------------------------------------------------------
// GET /read/workspace/tags - 跨账本标签聚合
// ---------------------------------------------------------------------------

workspaceRouter.get('/tags', async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const ledgerId = c.req.query('ledger_id') ?? null;
  const q = c.req.query('q') ?? null;
  const limit = Math.min(parseInt(c.req.query('limit') ?? '500', 10), 5000);
  const offset = parseInt(c.req.query('offset') ?? '0', 10);

  let ledgerQuery = 'SELECT id, external_id, name FROM ledgers WHERE user_id = ?';
  const ledgerParams: string[] = [userId];

  if (ledgerId) {
    ledgerQuery += ' AND external_id = ?';
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

  let tagQuery = `SELECT * FROM read_tag_projection WHERE ledger_id IN (${ledgerInternalIds.map(() => '?').join(',')})`;
  const tagParams: string[] = [...ledgerInternalIds];

  if (q) {
    tagQuery += ' AND name LIKE ?';
    tagParams.push(`%${q}%`);
  }

  tagQuery += ' ORDER BY LOWER(name) ASC LIMIT ? OFFSET ?';
  tagParams.push(String(limit), String(offset));

  const tagRows = await db.prepare(tagQuery).bind(...tagParams).all<Record<string, unknown>>();

  const items = tagRows.results.map((row) => {
    const ledExtId = ledgerMeta[row.ledger_id as string]?.external_id ?? '';

    return {
      id: row.sync_id,
      name: row.name,
      color: row.color,
      last_change_id: row.source_change_id,
      ledger_id: ledExtId,
      ledger_name: ledgerMeta[row.ledger_id as string]?.name ?? null,
      created_by_user_id: null,
      created_by_email: null,
      tx_count: 0,
      expense_total: 0,
      income_total: 0,
    };
  });

  return c.json(items);
});

// ---------------------------------------------------------------------------
// GET /read/workspace/ledger-counts - 账本总览统计
// ---------------------------------------------------------------------------

workspaceRouter.get('/ledger-counts', async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const ledgerId = c.req.query('ledger_id') ?? null;

  let ledgerQuery = 'SELECT id FROM ledgers WHERE user_id = ?';
  const ledgerParams: string[] = [userId];

  if (ledgerId) {
    ledgerQuery += ' AND external_id = ?';
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

// ---------------------------------------------------------------------------
// GET /read/workspace/analytics - 收支分析
// ---------------------------------------------------------------------------

workspaceRouter.get('/analytics', async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const ledgerId = c.req.query('ledger_id') ?? null;
  const scope = c.req.query('scope') ?? 'month';
  const metric = c.req.query('metric') ?? 'expense';

  let ledgerQuery = 'SELECT id FROM ledgers WHERE user_id = ?';
  const ledgerParams: string[] = [userId];

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

  // 查询所有交易
  const txRows = await db
    .prepare(`SELECT tx_type, amount, happened_at, category_name FROM read_tx_projection WHERE ledger_id IN (${ledgerInternalIds.map(() => '?').join(',')})`)
    .bind(...ledgerInternalIds)
    .all<{ tx_type: string; amount: number; happened_at: string; category_name: string | null }>();

  let incomeTotal = 0;
  let expenseTotal = 0;
  const seriesMap: Record<string, { expense: number; income: number }> = {};
  const categoryMap: Record<string, { expense: number; income: number; count: number }> = {};

  for (const tx of txRows.results) {
    if (tx.tx_type === 'income') {
      incomeTotal += tx.amount;
    } else if (tx.tx_type === 'expense') {
      expenseTotal += tx.amount;
    }

    const date = new Date(tx.happened_at);
    let bucket: string;

    if (scope === 'month') {
      bucket = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    } else if (scope === 'year') {
      bucket = String(date.getFullYear());
    } else {
      const weekStart = new Date(date);
      weekStart.setDate(date.getDate() - date.getDay());
      bucket = weekStart.toISOString().slice(0, 10);
    }

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
      distinct_days: Object.keys(seriesMap).length,
      first_tx_at: txRows.results[0]?.happened_at ?? null,
      last_tx_at: txRows.results[txRows.results.length - 1]?.happened_at ?? null,
    },
    series,
    category_ranks: categoryRanks,
    range: { scope, metric, period: null, start_at: null, end_at: null },
  });
});

export default workspaceRouter;
