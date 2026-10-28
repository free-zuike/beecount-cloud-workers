/**
 * MCP 读工具（对齐原版 src/mcp/tools/read_tools.py + #133 扩展）。
 *
 * - list_transactions：修订绑定分页（签名游标，过滤条件变化/数据变化 → CURSOR_INVALIDATED）
 * - get_transaction：revision 字段 = source_change_id
 * - _serialize_tx：完整序列化契约（补回 UTC tzinfo）
 */
import { decodeCursor, encodeCursor, fingerprint, revision as calcRevision, parseDateBoundary } from '../query-context';
import { listLiveLedgers } from '../transaction-service';
import { analyticsRange, bucketKey, computeAnomalyMonths } from '../../routes/workspace';
import type { McpContext, LedgerInfo, TxRow } from '../types';

/** 日期边界（对齐上游 date_boundary：裸日期含当天、无时区按 UTC；end 包尾） */
function parseDateBoundaryLocal(value: string, timeZone: string | null, end = false): Date {
  return parseDateBoundary(value, { end, timeZone: timeZone ?? undefined });
}

/** 序列化交易行（对齐上游 _serialize_tx） */
export function serializeTx(row: TxRow, categoryName?: string | null): Record<string, unknown> {
  // 对齐原版：happened_at 输出 ...+00:00（原版 dt.replace(tzinfo=utc).isoformat()），不是 .000Z
  const happened = row.happened_at ? `${new Date(row.happened_at).toISOString().slice(0, 19)}+00:00` : null;
  let tagIds: string[] = [];
  if (row.tag_sync_ids_json) {
    try { tagIds = JSON.parse(row.tag_sync_ids_json); } catch { tagIds = []; }
  }
  return {
    sync_id: row.sync_id,
    revision: row.source_change_id ?? 0,
    tx_type: row.tx_type,
    amount: Number(row.amount ?? 0),
    happened_at: happened,
    note: row.note,
    category_name: categoryName ?? row.category_name,
    category_id: row.category_sync_id,
    account_name: row.account_name,
    account_id: row.account_sync_id,
    from_account_name: row.from_account_name,
    from_account_id: row.from_account_sync_id,
    to_account_name: row.to_account_name,
    to_account_id: row.to_account_sync_id,
    tags: row.tags_csv ?? '',
    tag_ids: tagIds,
    currency_code: row.currency_code,
    native_amount: row.native_amount,
    exclude_from_stats: Boolean(row.exclude_from_stats),
    exclude_from_budget: Boolean(row.exclude_from_budget),
    created_by_user_id: row.created_by_user_id,
    last_edited_by_user_id: row.last_edited_by_user_id,
  };
}

/**
 * 解析单个作用域账本（对齐上游 _resolve_ledger）：
 * - 指定 ledger_id → 按 external_id 精确匹配；多个命中 → Ambiguous ledger identifier；无命中 → null
 * - 未指定 → 第一个未软删账本（created_at 升序）
 */
async function resolveLedger(c: McpContext, ledgerId?: string | null): Promise<LedgerInfo | null> {
  const live = await listLiveLedgers(c.db, c.userId, ledgerId ?? null);
  if (!ledgerId) return live[0] ?? null;
  if (live.length > 1) throw new Error('Ambiguous ledger identifier');
  return live[0] ?? null;
}

/** 当前用户可见账本列表（含共享成员，排除软删），对齐上游 list_ledgers 字段 */
export async function listLedgers(c: McpContext): Promise<Array<Record<string, unknown>>> {
  const ledgers = await listLiveLedgers(c.db, c.userId);
  return ledgers.map(l => ({
    id: l.external_id,
    name: l.name || l.external_id,
    currency: l.currency || 'CNY',
    month_start_day: l.month_start_day ?? null,
    owner_user_id: l.user_id,
    shared: l.user_id !== c.userId,
    created_at: l.created_at ?? null,
  }));
}

/** LIKE 通配符转义（对齐上游 _search_condition：\ % _ 都要转义） */
function escapeLike(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/** 全文搜索条件：备注/分类/账户/标签名 + 标签 sync_id 关联（对齐上游 _search_condition） */
async function searchCondition(
  c: McpContext,
  text: string,
): Promise<{ sql: string; params: unknown[] }> {
  const pattern = `%${escapeLike(text)}%`;
  const columns = ['note', 'category_name', 'account_name', 'from_account_name', 'to_account_name', 'tags_csv'];
  const parts = columns.map(col => `${col} LIKE ? ESCAPE '\\'`);
  const params: unknown[] = columns.map(() => pattern);
  const tagRows = await c.db.prepare(
    'SELECT sync_id FROM user_tag_projection WHERE user_id = ? AND name LIKE ? ESCAPE \'\\\''
  ).bind(c.userId, pattern).all<{ sync_id: string }>();
  for (const t of tagRows.results) {
    parts.push(`tag_sync_ids_json LIKE ? ESCAPE '\\'`);
    params.push(`%"${t.sync_id}"%`);
  }
  return { sql: '(' + parts.join(' OR ') + ')', params };
}

export async function getActiveLedger(c: McpContext): Promise<Record<string, unknown> | null> {
  const live = await listLiveLedgers(c.db, c.userId);
  if (live.length === 0) return null;
  const l = live[0];
  return { id: l.external_id, name: l.name, currency: l.currency || 'CNY' };
}

/**
 * 修订绑定分页（对齐上游 list_transactions）。
 * cursor 携带 {ledger_ids, user_global, revision, filters}，校验修订/过滤条件一致，
 * 否则 CURSOR_INVALIDATED。next_cursor 用最新 revision 签发（has_more=false 也保留）。
 */
export async function listTransactions(
  c: McpContext,
  opts: {
    ledger_id?: string | null;
    date_from?: string | null;
    date_to?: string | null;
    category?: string | null;
    account?: string | null;
    min_amount?: number | null;
    max_amount?: number | null;
    q?: string | null;
    limit?: number | null;
    cursor?: string | null;
    tx_type?: string | null;
    category_id?: string | null;
    account_id?: string | null;
    tag_id?: string | null;
    time_zone?: string | null;
  } = {},
): Promise<Record<string, unknown>> {
  const { db, userId, jwtSecret } = c;
  // 作用域：单个账本（对齐上游 _resolve_ledger；未指定 → 最早创建的未软删账本）
  const led = await resolveLedger(c, opts.ledger_id ?? null);
  if (!led) return { items: [], total: 0 };
  const timeZone = opts.time_zone ?? null;

  const filters: Record<string, unknown> = {
    ledger: led.id,
    user: userId,
    date_from: opts.date_from ?? null,
    date_to: opts.date_to ?? null,
    category: opts.category ?? null,
    account: opts.account ?? null,
    min_amount: opts.min_amount ?? null,
    max_amount: opts.max_amount ?? null,
    q: opts.q ?? null,
    tx_type: opts.tx_type ?? null,
    category_id: opts.category_id ?? null,
    account_id: opts.account_id ?? null,
    tag_id: opts.tag_id ?? null,
    time_zone: timeZone,
  };
  const signature = fingerprint(filters);
  const currentRevision = await calcRevision(db, [led.id], led.user_id);
  const continuation = opts.cursor ? decodeCursor(opts.cursor, jwtSecret) : null;
  if (continuation && (continuation.filter !== signature || Number(continuation.revision) !== currentRevision)) {
    throw new Error('CURSOR_INVALIDATED: filters, permissions or data changed; restart the query');
  }

  let q = 'SELECT * FROM read_tx_projection WHERE ledger_id = ?';
  const p: unknown[] = [led.id];
  // 日期边界按查询时区折算（对齐上游 date_boundary：裸日期含当天、包尾）
  if (opts.date_from) { q += ' AND happened_at >= ?'; p.push(parseDateBoundaryLocal(opts.date_from, timeZone).toISOString()); }
  if (opts.date_to) { q += ' AND happened_at < ?'; p.push(parseDateBoundaryLocal(opts.date_to, timeZone, true).toISOString()); }
  if (opts.tx_type) {
    if (!['income', 'expense', 'transfer'].includes(opts.tx_type)) throw new Error('Invalid tx_type');
    q += ' AND tx_type = ?'; p.push(opts.tx_type);
  }
  if (opts.category_id) { q += ' AND category_sync_id = ?'; p.push(opts.category_id); }
  if (opts.account_id) { q += ' AND (account_sync_id = ? OR from_account_sync_id = ? OR to_account_sync_id = ?)'; p.push(opts.account_id, opts.account_id, opts.account_id); }
  if (opts.tag_id) {
    q += ` AND tag_sync_ids_json LIKE ? ESCAPE '\\'`;
    p.push(`%"${opts.tag_id.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')}"%`);
  }
  if (opts.category) { q += ' AND category_name = ?'; p.push(opts.category); }
  if (opts.account) { q += ' AND (account_name = ? OR from_account_name = ? OR to_account_name = ?)'; p.push(opts.account, opts.account, opts.account); }
  if (opts.min_amount !== undefined && opts.min_amount !== null) { q += ' AND ABS(amount) >= ?'; p.push(opts.min_amount); }
  if (opts.max_amount !== undefined && opts.max_amount !== null) { q += ' AND ABS(amount) <= ?'; p.push(opts.max_amount); }
  if (opts.q && opts.q.trim()) {
    const cond = await searchCondition(c, opts.q.trim());
    q += ' AND ' + cond.sql;
    p.push(...cond.params);
  }
  const total = (await db.prepare(q.replace('SELECT *', 'SELECT COUNT(*) AS cnt')).bind(...p).first<{ cnt: number }>())?.cnt ?? 0;

  // 键集分页（对齐上游：happened_at DESC, sync_id DESC，游标携带 (time, id)）
  if (continuation && typeof continuation.time === 'string' && typeof continuation.id === 'string') {
    q += ' AND (happened_at < ? OR (happened_at = ? AND sync_id < ?))';
    p.push(continuation.time, continuation.time, continuation.id);
  }
  const pageSize = Math.max(1, Math.min(opts.limit ?? 50, 200));
  q += ' ORDER BY happened_at DESC, sync_id DESC LIMIT ?';
  p.push(pageSize + 1);
  const rows = await db.prepare(q).bind(...p).all<TxRow>();
  const more = rows.results.length > pageSize;
  const pageRows = rows.results.slice(0, pageSize);

  // 取数后再次核对修订：并发写入期间不返回看似有效的页（对齐上游）
  if ((await calcRevision(db, [led.id], led.user_id)) !== currentRevision) {
    throw new Error('CURSOR_INVALIDATED: data changed during query; restart');
  }
  const last = pageRows[pageRows.length - 1];
  const categoryNames = await loadCategoryNames(db, userId);
  return {
    ledger: led.name,
    ledger_id: led.external_id,
    currency: led.currency,
    revision: currentRevision,
    total,
    has_more: more,
    next_cursor: more && last
      ? encodeCursor({ filter: signature, revision: currentRevision, time: last.happened_at, id: last.sync_id }, jwtSecret)
      : null,
    items: pageRows.map(r => ({
      ...serializeTx(r, categoryNames.get(r.category_sync_id ?? '') ?? null),
      ledger_id: led.external_id,
      currency_code: r.currency_code ?? led.currency,
    })),
  };
}

async function loadCategoryNames(db: D1Database, userId: string): Promise<Map<string, string>> {
  const rows = await db.prepare('SELECT sync_id, name FROM user_category_projection WHERE user_id = ?').bind(userId).all<{ sync_id: string; name: string }>();
  return new Map(rows.results.map(r => [r.sync_id, r.name]));
}

/** 单笔交易（跨账本定位，revision = source_change_id） */
export async function getTransaction(
  c: McpContext,
  opts: { sync_id: string; ledger_id?: string | null },
): Promise<Record<string, unknown> | null> {
  const { db, userId } = c;
  const ledgers = opts.ledger_id
    ? await listLiveLedgers(db, userId, opts.ledger_id)
    : await listLiveLedgers(db, userId);
  if (ledgers.length === 0) return null;
  const placeholders = ledgers.map(() => '?').join(',');
  const rows = await db.prepare(
    `SELECT * FROM read_tx_projection WHERE ledger_id IN (${placeholders}) AND sync_id = ? LIMIT 3`
  ).bind(...ledgers.map(l => l.id), opts.sync_id).all<TxRow>();
  if (rows.results.length > 1) throw new Error('Ambiguous sync_id; specify ledger_id');
  if (rows.results.length === 0) return null;
  const tx = rows.results[0];
  const ledger = ledgers.find(l => l.id === tx.ledger_id) ?? null;
  const categoryName = await db.prepare(
    'SELECT name FROM user_category_projection WHERE user_id = ? AND sync_id = ?'
  ).bind(userId, tx.category_sync_id ?? '').first<{ name: string }>();
  const out = serializeTx(tx, categoryName?.name ?? null);
  // 对齐上游：ledger 是账本名，另有 ledger_id 与币种回落
  out.ledger = ledger?.name ?? null;
  out.ledger_id = ledger?.external_id ?? null;
  out.currency_code = tx.currency_code ?? ledger?.currency ?? null;
  let attachments: unknown[] = [];
  if (tx.attachments_json) {
    try { attachments = JSON.parse(tx.attachments_json); } catch { attachments = []; }
  }
  out.attachments = attachments;
  return out;
}

/** 分类列表（共享账本按 owner 字典展示） */
export async function listCategories(
  c: McpContext,
  opts: { kind?: string | null; ledger_id?: string | null } = {},
): Promise<Array<Record<string, unknown>>> {
  const { db, userId } = c;
  let ownerId = userId;
  if (opts.ledger_id) {
    const ledgers = await listLiveLedgers(db, userId, opts.ledger_id);
    // 对齐上游 _dictionary_owner：解析不到 → Ledger not found；歧义 → Ambiguous ledger identifier
    if (ledgers.length === 0) throw new Error('Ledger not found');
    if (ledgers.length > 1) throw new Error('Ambiguous ledger identifier');
    ownerId = ledgers[0].user_id;
  }
  let q = 'SELECT * FROM user_category_projection WHERE user_id = ?';
  const p: unknown[] = [ownerId];
  if (opts.kind) { q += ' AND kind = ?'; p.push(opts.kind); }
  const rows = await db.prepare(q).bind(...p).all<Record<string, unknown>>();
  // 对齐上游：同 sync_id 去重 + 按 (kind, sort_order, name.lower()) 排序
  const seen = new Map<string, Record<string, unknown>>();
  for (const r of rows.results) {
    const key = String(r.sync_id ?? '');
    if (!seen.has(key)) seen.set(key, r);
  }
  return [...seen.values()]
    .sort((a, b) => String(a.kind ?? '').localeCompare(String(b.kind ?? ''))
      || Number(a.sort_order ?? 0) - Number(b.sort_order ?? 0)
      || String(a.name ?? '').toLowerCase().localeCompare(String(b.name ?? '').toLowerCase()))
    .map(r => ({
      id: r.sync_id, name: r.name, kind: r.kind, level: r.level ?? null,
      parent_name: r.parent_name ?? null, parent_id: r.parent_sync_id ?? null,
      icon: r.icon ?? null,
    }));
}

/** 账户列表（共享账本按 owner 字典展示） */
export async function listAccounts(
  c: McpContext,
  opts: { account_type?: string | null; ledger_id?: string | null } = {},
): Promise<Array<Record<string, unknown>>> {
  const { db, userId } = c;
  let ownerId = userId;
  if (opts.ledger_id) {
    const ledgers = await listLiveLedgers(db, userId, opts.ledger_id);
    // 对齐上游 _dictionary_owner：解析不到 → Ledger not found；歧义 → Ambiguous ledger identifier
    if (ledgers.length === 0) throw new Error('Ledger not found');
    if (ledgers.length > 1) throw new Error('Ambiguous ledger identifier');
    ownerId = ledgers[0].user_id;
  }
  let q = 'SELECT * FROM user_account_projection WHERE user_id = ?';
  const p: unknown[] = [ownerId];
  if (opts.account_type) { q += ' AND account_type = ?'; p.push(opts.account_type); }
  const rows = await db.prepare(q).bind(...p).all<Record<string, unknown>>();
  // 对齐上游：同 sync_id 去重 + 按 name.lower() 排序 + 完整字段
  const seen = new Map<string, Record<string, unknown>>();
  for (const r of rows.results) {
    const key = String(r.sync_id ?? '');
    if (!seen.has(key)) seen.set(key, r);
  }
  return [...seen.values()]
    .sort((a, b) => String(a.name ?? '').toLowerCase().localeCompare(String(b.name ?? '').toLowerCase()))
    .map(r => ({
      id: r.sync_id, name: r.name, account_type: r.account_type ?? null,
      currency: r.currency ?? null, initial_balance: Number(r.initial_balance ?? 0),
      hidden: Boolean(r.hidden), bank_name: r.bank_name ?? null,
      card_last_four: r.card_last_four ?? null,
      credit_limit: r.credit_limit === null || r.credit_limit === undefined ? null : Number(r.credit_limit),
      billing_day: r.billing_day ?? null, payment_due_day: r.payment_due_day ?? null,
    }));
}

/** 标签列表（共享账本按 owner 字典展示） */
export async function listTags(c: McpContext, opts: { ledger_id?: string | null } = {}): Promise<Array<Record<string, unknown>>> {
  const { db, userId } = c;
  let ownerId = userId;
  if (opts.ledger_id) {
    const ledgers = await listLiveLedgers(db, userId, opts.ledger_id);
    // 对齐上游 _dictionary_owner：解析不到 → Ledger not found；歧义 → Ambiguous ledger identifier
    if (ledgers.length === 0) throw new Error('Ledger not found');
    if (ledgers.length > 1) throw new Error('Ambiguous ledger identifier');
    ownerId = ledgers[0].user_id;
  }
  const rows = await db.prepare('SELECT * FROM user_tag_projection WHERE user_id = ?').bind(ownerId).all<Record<string, unknown>>();
  const seen = new Map<string, Record<string, unknown>>();
  for (const r of rows.results) {
    const key = String(r.sync_id ?? '');
    if (!seen.has(key)) seen.set(key, r);
  }
  return [...seen.values()]
    .sort((a, b) => String(a.name ?? '').toLowerCase().localeCompare(String(b.name ?? '').toLowerCase()))
    .map(r => ({ id: r.sync_id, name: r.name, color: r.color ?? null }));
}

/**
 * 预算列表（对齐上游 list_budgets：走生产用量计算，含父分类展开与排除标记）。
 * 返回 spent / remaining / percent_used / exceeded / currency / id / ledger_id。
 */
export async function listBudgets(
  c: McpContext,
  opts: { ledger_id?: string | null } = {},
): Promise<Array<Record<string, unknown>>> {
  const { db } = c;
  const led = await resolveLedger(c, opts.ledger_id ?? null);
  if (!led) return [];

  // 周期窗口（对齐上游 _current_period_range / 读端 budgets/usage）
  const monthStartDay = Math.min(Math.max(led.month_start_day ?? 1, 1), 28);
  const now = new Date();
  const today = now.getUTCDate();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const periodStart = today >= monthStartDay
    ? new Date(Date.UTC(year, month, monthStartDay))
    : new Date(Date.UTC(year, month - 1, monthStartDay));
  const periodEnd = today >= monthStartDay
    ? new Date(Date.UTC(year, month + 1, monthStartDay))
    : new Date(Date.UTC(year, month, monthStartDay));
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const currentMonth = fmt(periodStart);
  const nextMonth = fmt(periodEnd);

  const rows = await db.prepare(
    'SELECT * FROM read_budget_projection WHERE ledger_id = ? ORDER BY budget_type, category_sync_id'
  ).bind(led.id).all<Record<string, unknown>>();

  // 脏数据去重：(type, category) 维度，sync_id 最大胜出；孤儿分类预算跳过
  const dedup = new Map<string, Record<string, unknown>>();
  for (const b of rows.results) {
    const btype = (b.budget_type as string) || 'total';
    if (btype === 'category' && !b.category_sync_id) continue;
    const key = `${btype}:${b.category_sync_id ?? ''}`;
    const cur = dedup.get(key);
    if (!cur || String(b.sync_id) > String(cur.sync_id)) dedup.set(key, b);
  }

  const catRows = await db.prepare(
    'SELECT sync_id, name, parent_sync_id FROM user_category_projection WHERE user_id = ?'
  ).bind(led.user_id).all<{ sync_id: string; name: string | null; parent_sync_id: string | null }>();
  const catName = new Map(catRows.results.map(r => [r.sync_id, (r.name ?? '').trim()]));
  const childrenOf = new Map<string, string[]>();
  for (const r of catRows.results) {
    if (!r.parent_sync_id) continue;
    const list = childrenOf.get(r.parent_sync_id) ?? [];
    list.push(r.sync_id);
    childrenOf.set(r.parent_sync_id, list);
  }

  const out: Array<Record<string, unknown>> = [];
  for (const b of dedup.values()) {
    const categoryId = (b.category_sync_id as string | null) ?? null;
    let categoryIds: string[] | null = null;
    if (categoryId) categoryIds = [categoryId, ...(childrenOf.get(categoryId) ?? [])];
    const amount = Number(b.amount ?? 0);
    let spent = 0;
    if (categoryIds) {
      const placeholders = categoryIds.map(() => '?').join(',');
      const row = await db.prepare(
        `SELECT COALESCE(SUM(COALESCE(native_amount, amount)), 0) AS total FROM read_tx_projection
         WHERE ledger_id = ? AND category_sync_id IN (${placeholders}) AND tx_type = 'expense'
           AND happened_at >= ? AND happened_at < ?
           AND exclude_from_budget = 0`
      ).bind(led.id, ...categoryIds, currentMonth, nextMonth).first<{ total: number }>();
      spent = Math.abs(Number(row?.total ?? 0));
    } else {
      const row = await db.prepare(
        `SELECT COALESCE(SUM(COALESCE(native_amount, amount)), 0) AS total FROM read_tx_projection
         WHERE ledger_id = ? AND tx_type = 'expense'
           AND happened_at >= ? AND happened_at < ?
           AND exclude_from_budget = 0`
      ).bind(led.id, currentMonth, nextMonth).first<{ total: number }>();
      spent = Math.abs(Number(row?.total ?? 0));
    }
    out.push({
      id: b.sync_id,
      type: (b.budget_type as string) || 'total',
      category_id: categoryId,
      category_name: categoryId ? catName.get(categoryId) ?? null : null,
      amount,
      period: (b.period as string) || 'monthly',
      start_day: (b.start_day as number) ?? 1,
      enabled: Boolean(b.enabled),
      ledger_id: led.external_id,
      currency: led.currency,
      spent,
      remaining: Math.max(0, amount - spent),
      percent_used: amount ? Math.round((spent / amount) * 1000) / 10 : 0,
      exceeded: spent > amount,
    });
  }
  return out;
}

/** 账本统计 */
export async function getLedgerStats(
  c: McpContext,
  opts: { ledger_id?: string | null } = {},
): Promise<Record<string, unknown> | null> {
  const { db } = c;
  // 对齐上游：作用域为单个账本；字典计数按账本 owner（且 DISTINCT sync_id）
  const l = await resolveLedger(c, opts.ledger_id ?? null);
  if (!l) return null;
  const txCnt = (await db.prepare('SELECT COUNT(*) AS c FROM read_tx_projection WHERE ledger_id = ?').bind(l.id).first<{ c: number }>())?.c ?? 0;
  const catCnt = (await db.prepare('SELECT COUNT(DISTINCT sync_id) AS c FROM user_category_projection WHERE user_id = ?').bind(l.user_id).first<{ c: number }>())?.c ?? 0;
  const accCnt = (await db.prepare('SELECT COUNT(DISTINCT sync_id) AS c FROM user_account_projection WHERE user_id = ?').bind(l.user_id).first<{ c: number }>())?.c ?? 0;
  const tagCnt = (await db.prepare('SELECT COUNT(DISTINCT sync_id) AS c FROM user_tag_projection WHERE user_id = ?').bind(l.user_id).first<{ c: number }>())?.c ?? 0;
  const budCnt = (await db.prepare('SELECT COUNT(*) AS c FROM read_budget_projection WHERE ledger_id = ?').bind(l.id).first<{ c: number }>())?.c ?? 0;
  return {
    ledger: l.name,
    transaction_count: txCnt,
    category_count: catCnt,
    account_count: accCnt,
    tag_count: tagCnt,
    budget_count: budCnt,
  };
}

/**
 * 分析汇总（对齐上游 get_analytics_summary：复用生产 workspace_analytics 口径）。
 * - 校验 scope ∈ {month, year, all}、tz_offset_minutes ∈ [-720, 840]
 * - 金额口径 native_amount ?? amount；exclude_from_stats=True 不计入（NULL 视为不计入）
 * - 返回 ledger/ledger_id/currency/scope/period/income/expense/balance/transaction_count
 *   /top_categories(10)/series/anomaly_months/range/calculation
 */
export async function getAnalyticsSummary(
  c: McpContext,
  opts: {
    scope?: string | null;
    period?: string | null;
    ledger_id?: string | null;
    tz_offset_minutes?: number | null;
  } = {},
): Promise<Record<string, unknown>> {
  const { db } = c;
  const scope = opts.scope ?? 'month';
  if (!['month', 'year', 'all'].includes(scope)) throw new Error('scope must be month, year or all');
  const tzOffset = Number(opts.tz_offset_minutes ?? 0);
  if (!Number.isFinite(tzOffset) || tzOffset < -720 || tzOffset > 840) throw new Error('Invalid timezone offset');

  const led = await resolveLedger(c, opts.ledger_id ?? null);
  if (!led) return {};
  const monthStartDay = Math.min(Math.max(led.month_start_day ?? 1, 1), 28);
  const { startAt, endAt, normalizedPeriod } = analyticsRange(scope, opts.period ?? null, tzOffset, monthStartDay);

  let q = `SELECT tx_type, COALESCE(native_amount, amount) AS amount, happened_at, category_name
           FROM read_tx_projection WHERE ledger_id = ? AND exclude_from_stats = 0`;
  const p: unknown[] = [led.id];
  if (startAt) { q += ' AND happened_at >= ?'; p.push(startAt); }
  if (endAt) { q += ' AND happened_at < ?'; p.push(endAt); }
  const rows = await db.prepare(q).bind(...p).all<{ tx_type: string; amount: number; happened_at: string; category_name: string | null }>();

  let transactionCount = 0;
  let income = 0;
  let expense = 0;
  const seriesMap = new Map<string, { expense: number; income: number }>();
  const categoryMap = new Map<string, { income: number; expense: number; count: number }>();
  const categoryByBucket: Record<string, Record<string, number>> = {};
  for (const r of rows.results) {
    if (!r.happened_at) continue;
    const amt = Number(r.amount ?? 0);
    transactionCount += 1;
    const bucket = bucketKey(scope, r.happened_at, tzOffset, monthStartDay);
    const slot = seriesMap.get(bucket) ?? { expense: 0, income: 0 };
    const category = (r.category_name ?? '').trim() || 'Uncategorized';
    const catSlot = categoryMap.get(category) ?? { income: 0, expense: 0, count: 0 };
    if (r.tx_type === 'income') {
      income += amt; slot.income += amt; catSlot.income += amt;
    } else if (r.tx_type === 'expense') {
      expense += amt; slot.expense += amt; catSlot.expense += amt;
      const bucketCat = categoryByBucket[bucket] ?? {};
      bucketCat[category] = (bucketCat[category] ?? 0) + amt;
      categoryByBucket[bucket] = bucketCat;
    } else {
      seriesMap.set(bucket, slot);
      categoryMap.set(category, catSlot);
      continue;
    }
    catSlot.count += 1;
    seriesMap.set(bucket, slot);
    categoryMap.set(category, catSlot);
  }

  const series = [...seriesMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([bucket, slot]) => ({ bucket, expense: slot.expense, income: slot.income, balance: slot.income - slot.expense }));
  const topCategories = [...categoryMap.entries()]
    .filter(([, v]) => v.expense > 0)
    .sort(([an, av], [bn, bv]) => bv.expense - av.expense || an.localeCompare(bn))
    .slice(0, 10)
    .map(([name, v]) => ({ name, total: v.expense }));
  // 异常月份归因仅 scope=year（对齐上游：month 只有 1 个 bucket，all 跨年抖动大）
  const anomalyMonths = scope === 'year' ? computeAnomalyMonths(series, categoryByBucket) : [];

  return {
    ledger: led.name,
    ledger_id: led.external_id,
    currency: led.currency,
    scope,
    period: normalizedPeriod,
    income,
    expense,
    balance: income - expense,
    transaction_count: transactionCount,
    top_categories: topCategories,
    series,
    anomaly_months: anomalyMonths,
    range: {
      scope,
      metric: 'expense',
      period: normalizedPeriod,
      start_at: startAt,
      end_at: endAt ? new Date(new Date(endAt).getTime() - 1000).toISOString() : null,
    },
    calculation: {
      currency: 'ledger base; native_amount falls back to amount',
      exclude_from_stats: true,
      month_start_day: monthStartDay,
      tz_offset_minutes: tzOffset,
      refund_policy: 'income and expense stay separate; no inferred refund pairing',
    },
  };
}

/** 全文搜索（note/分类/账户名模糊匹配） */
export async function search(
  c: McpContext,
  opts: { q: string; limit?: number | null },
): Promise<Array<Record<string, unknown>>> {
  const { db, userId } = c;
  // 对齐上游：空查询直接返回 []（不要退化成"最近 N 笔"）
  if (!opts.q || !opts.q.trim()) return [];
  const limit = Math.max(1, Math.min(opts.limit ?? 20, 100));
  const ledgers = await listLiveLedgers(db, userId);
  if (ledgers.length === 0) return [];
  const placeholders = ledgers.map(() => '?').join(',');
  const cond = await searchCondition(c, opts.q.trim());
  const rows = await db.prepare(
    `SELECT * FROM read_tx_projection
     WHERE ledger_id IN (${placeholders}) AND ${cond.sql}
     ORDER BY happened_at DESC LIMIT ?`
  ).bind(...ledgers.map(l => l.id), ...cond.params, limit).all<TxRow>();
  const categoryNames = await loadCategoryNames(db, userId);
  return rows.results.map(r => serializeTx(r, categoryNames.get(r.category_sync_id ?? '') ?? null));
}


