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
import { CSV_HEADERS, TX_TYPE_LABELS, normalizeLang, tagsList, attachmentNames, csvField, sanitizeFilename } from './csv';

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

const ANOMALY_MIN_MONTHS = 3;
const ANOMALY_DEVIATION_MULT = 1.2;
const ANOMALY_DEVIATION_ABS = 200;
const ANOMALY_TOP_ATTRIBUTIONS = 2;

/**
 * 分析周期范围的 month_start_day 契约(移植上游 read/_shared.py _analytics_range)。
 * 周期按起始月命名:"2026-06"(msd=10) = 本地 2026-06-10 ~ 2026-07-10。
 * 年 = [当年1月周期起点, 次年1月周期起点)。默认 month_start_day=1 行为不变。
 */
export function analyticsRange(
  scope: string,
  period: string | null,
  tzOffsetMinutes: number,
  monthStartDay: number,
  now: Date = new Date(),
): { startAt: string | null; endAt: string | null; normalizedPeriod: string | null } {
  if (scope === 'all') return { startAt: null, endAt: null, normalizedPeriod: null };

  let normalized = period;
  if (scope === 'month') {
    if (!normalized) {
      const localNow = new Date(now.getTime() + tzOffsetMinutes * 60000);
      let targetYear = localNow.getUTCFullYear();
      let targetMonth = localNow.getUTCMonth() + 1;
      if (localNow.getUTCDate() < monthStartDay) {
        if (targetMonth === 1) { targetYear--; targetMonth = 12; }
        else targetMonth--;
      }
      normalized = `${targetYear}-${String(targetMonth).padStart(2, '0')}`;
    }
    const [yearStr, monthStr] = normalized.split('-');
    const year = parseInt(yearStr, 10);
    const month = parseInt(monthStr, 10);
    if (year && month) {
      const startAt = new Date(Date.UTC(year, month - 1, monthStartDay, 0, 0, 0) - tzOffsetMinutes * 60000).toISOString();
      const endAt = new Date(Date.UTC(year, month, monthStartDay, 0, 0, 0) - tzOffsetMinutes * 60000).toISOString();
      return { startAt, endAt, normalizedPeriod: normalized };
    }
    return { startAt: null, endAt: null, normalizedPeriod: normalized };
  }

  // scope === 'year'
  if (!normalized) {
    const localNow = new Date(now.getTime() + tzOffsetMinutes * 60000);
    let targetYear = localNow.getUTCFullYear();
    if (localNow.getUTCMonth() === 0 && localNow.getUTCDate() < monthStartDay) targetYear--;
    normalized = String(targetYear);
  }
  const year = parseInt(normalized, 10);
  if (year) {
    const startAt = new Date(Date.UTC(year, 0, monthStartDay, 0, 0, 0) - tzOffsetMinutes * 60000).toISOString();
    const endAt = new Date(Date.UTC(year + 1, 0, monthStartDay, 0, 0, 0) - tzOffsetMinutes * 60000).toISOString();
    return { startAt, endAt, normalizedPeriod: normalized };
  }
  return { startAt: null, endAt: null, normalizedPeriod: normalized };
}

/**
 * 分析分桶键(移植上游 read/_shared.py _bucket_key):
 * month scope 按日分桶(YYYY-MM-DD,与起始日无关);year/all 按月分桶且按
 * month_start_day 切桶。tz_offset 先应用到本地再切。
 */
export function bucketKey(
  scope: string,
  iso: string,
  tzOffsetMinutes: number,
  monthStartDay: number,
): string {
  const localDate = new Date(new Date(iso).getTime() + tzOffsetMinutes * 60000);
  if (scope === 'month') {
    return `${localDate.getUTCFullYear()}-${String(localDate.getUTCMonth() + 1).padStart(2, '0')}-${String(localDate.getUTCDate()).padStart(2, '0')}`;
  }
  if (localDate.getUTCDate() < monthStartDay) {
    const prevMonth = localDate.getUTCMonth() === 0 ? 11 : localDate.getUTCMonth() - 1;
    const prevYear = localDate.getUTCMonth() === 0 ? localDate.getUTCFullYear() - 1 : localDate.getUTCFullYear();
    return `${prevYear}-${String(prevMonth + 1).padStart(2, '0')}`;
  }
  return `${localDate.getUTCFullYear()}-${String(localDate.getUTCMonth() + 1).padStart(2, '0')}`;
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export function computeAnomalyMonths(
  series: Array<{ bucket: string; expense: number; income: number; balance: number }>,
  categoryByBucket: Record<string, Record<string, number>>
): Array<{
  bucket: string;
  expense: number;
  baseline: number;
  deviation_pct: number;
  top_attributions: Array<{ category_name: string; amount: number; median_others: number; multiplier: number | null }>;
}> {
  const occurred = series.filter(s => s.expense > 0);
  if (occurred.length < ANOMALY_MIN_MONTHS) return [];

  const baseline = median(occurred.map(s => s.expense));
  const out: Array<any> = [];
  const otherBucketsCache: Record<string, string[]> = {};

  const othersFor = (bucket: string): string[] => {
    if (otherBucketsCache[bucket]) return otherBucketsCache[bucket];
    const result = occurred.filter(o => o.bucket !== bucket).map(o => o.bucket);
    otherBucketsCache[bucket] = result;
    return result;
  };

  for (const s of occurred) {
    if (s.expense <= baseline * ANOMALY_DEVIATION_MULT) continue;
    if (s.expense - baseline <= ANOMALY_DEVIATION_ABS) continue;

    const thisMonthCats = categoryByBucket[s.bucket] || {};
    const otherBuckets = othersFor(s.bucket);
    const attributions: Array<[number, any]> = [];

    for (const [catName, catAmount] of Object.entries(thisMonthCats)) {
      const others = otherBuckets.map(b => (categoryByBucket[b] || {})[catName] || 0);
      const medianOthers = median(others);
      const diff = catAmount - medianOthers;
      if (diff <= 0) continue;
      const multiplier = medianOthers > 0 ? catAmount / medianOthers : null;
      attributions.push([diff, { category_name: catName, amount: catAmount, median_others: medianOthers, multiplier }]);
    }

    attributions.sort(([a], [b]) => b - a);
    const topAttributions = attributions.slice(0, ANOMALY_TOP_ATTRIBUTIONS).map(([, a]) => a);

    out.push({
      bucket: s.bucket,
      expense: s.expense,
      baseline,
      deviation_pct: baseline > 0 ? (s.expense - baseline) / baseline : 0,
      top_attributions: topAttributions,
    });
  }

  out.sort((a, b) => (b.expense - b.baseline) - (a.expense - a.baseline));
  return out;
}

const INVITE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateInviteCode(): string {
  const rand = crypto.getRandomValues(new Uint8Array(6));
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += INVITE_CHARS[rand[i] % INVITE_CHARS.length];
  }
  return code;
}

function formatInviteCode(code: string): string {
  if (code.length === 6) return `${code.slice(0, 3)} ${code.slice(3)}`;
  return code;
}

type Bindings = {
  DB: D1Database;
  JWT_SECRET: string;
  BEECOUNT_DO: DurableObjectNamespace;
  INVITE_SHARE_ORIGIN?: string;
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
): Promise<{ id: string; user_id: string; external_id: string; name: string | null; currency: string; month_start_day: number } | null> {
  const ledger = await db
    .prepare('SELECT id, user_id, external_id, name, currency, month_start_day FROM ledgers WHERE external_id = ?')
    .bind(ledgerExternalId)
    .first<{ id: string; user_id: string; external_id: string; name: string | null; currency: string; month_start_day: number }>();

  if (!ledger) return null;

  if (ledger.user_id === userId) return ledger;

  const member = await db
    .prepare('SELECT user_id FROM ledger_members WHERE ledger_id = ? AND user_id = ?')
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
  const langKey = normalizeLang(c.req.query('lang') ?? null);
  const headers = CSV_HEADERS[langKey];
  const typeLabels = TX_TYPE_LABELS[langKey];

  // 账本可见性:owner / member,排除软删(对齐上游 _visible_workspace_ledgers)
  const softDeleteCond = `NOT EXISTS (
    SELECT 1 FROM sync_changes sc
    WHERE sc.ledger_id = l.id AND sc.entity_type = 'ledger_snapshot'
      AND sc.action = 'delete'
      AND sc.change_id = (SELECT MAX(sc2.change_id) FROM sync_changes sc2
                          WHERE sc2.ledger_id = l.id AND sc2.entity_type = 'ledger_snapshot')
  )`;
  let ledger = await db
    .prepare(`SELECT l.id, l.external_id, l.name, l.currency FROM ledgers l
      WHERE l.user_id = ? AND l.external_id = ? AND ${softDeleteCond}`)
    .bind(userId, ledgerId)
    .first<{ id: string; external_id: string; name: string | null; currency: string | null }>();
  if (!ledger) {
    ledger = await db
      .prepare(`SELECT l.id, l.external_id, l.name, l.currency FROM ledgers l
        JOIN ledger_members lm ON l.id = lm.ledger_id
        WHERE lm.user_id = ? AND l.external_id = ? AND ${softDeleteCond}`)
      .bind(userId, ledgerId)
      .first<{ id: string; external_id: string; name: string | null; currency: string | null }>();
  }
  if (!ledger) {
    return c.json({ error: 'Ledger not found or access denied' }, 404);
  }

  const tzOffset = parseInt(c.req.query('tz_offset_minutes') ?? '0', 10) || 0;
  const dateFrom = c.req.query('date_from');
  const dateTo = c.req.query('date_to');

  // 查询(单账本;子分类 JOIN 提供二级分类,对齐上游 CSV 12 列)
  let txQuery = `SELECT tx.*, cp.level AS cat_level, cp.parent_name AS cat_parent_name
    FROM read_tx_projection tx
    LEFT JOIN user_category_projection cp ON cp.user_id = tx.user_id AND cp.sync_id = tx.category_sync_id
    WHERE tx.ledger_id = ?`;
  const params: (string | number)[] = [ledger.id];

  const txType = c.req.query('tx_type');
  if (txType) { txQuery += ' AND tx.tx_type = ?'; params.push(txType); }
  const accountName = c.req.query('account_name');
  if (accountName) {
    txQuery += ' AND (tx.account_name LIKE ? OR tx.from_account_name LIKE ? OR tx.to_account_name LIKE ?)';
    params.push(`%${accountName}%`, `%${accountName}%`, `%${accountName}%`);
  }
  const q = c.req.query('q');
  const txIds = c.req.queries('tx_ids');
  // tx_ids 优先:按 sync_id 精确过滤并忽略其它过滤器(对齐上游 workspace.py export_workspace_transactions_csv)
  if (txIds && txIds.length > 0) {
    const placeholders = txIds.map(() => '?').join(',');
    txQuery += ` AND tx.sync_id IN (${placeholders})`;
    params.push(...txIds);
  } else {
    if (q) {
      txQuery += ' AND (tx.note LIKE ? OR tx.category_name LIKE ? OR tx.account_name LIKE ? OR tx.from_account_name LIKE ? OR tx.to_account_name LIKE ? OR tx.tags_csv LIKE ?)';
      params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
    }
    const tagSyncId = c.req.query('tag_sync_id');
    if (tagSyncId) { txQuery += ' AND tx.tag_sync_ids_json LIKE ?'; params.push(`%"${tagSyncId}"%`); }
    const categorySyncId = c.req.query('category_sync_id');
    if (categorySyncId) { txQuery += ' AND tx.category_sync_id = ?'; params.push(categorySyncId); }
    const accountSyncId = c.req.query('account_sync_id');
    if (accountSyncId) {
      txQuery += ' AND (tx.account_sync_id = ? OR tx.from_account_sync_id = ? OR tx.to_account_sync_id = ?)';
      params.push(accountSyncId, accountSyncId, accountSyncId);
    }
    const txSyncId = c.req.query('tx_sync_id');
    if (txSyncId) { txQuery += ' AND tx.sync_id = ?'; params.push(txSyncId); }
    const amountMin = c.req.query('amount_min');
    if (amountMin !== undefined && amountMin !== null && amountMin !== '') {
      const v = Number(amountMin);
      if (Number.isFinite(v)) { txQuery += ' AND tx.amount >= ?'; params.push(v); }
    }
    const amountMax = c.req.query('amount_max');
    if (amountMax !== undefined && amountMax !== null && amountMax !== '') {
      const v = Number(amountMax);
      if (Number.isFinite(v)) { txQuery += ' AND tx.amount <= ?'; params.push(v); }
    }
    if (dateFrom) { txQuery += ' AND tx.happened_at >= ?'; params.push(dateFrom); }
    if (dateTo) { txQuery += ' AND tx.happened_at < ?'; params.push(dateTo); }
  }

  txQuery += ' ORDER BY tx.happened_at DESC, tx.tx_index DESC';
  const txRows = await db.prepare(txQuery).bind(...params).all<Record<string, unknown>>();

  // 生成 12 列行(对齐原版 workspace.py export_workspace_transactions_csv)
  const rows: string[] = [];
  for (const tx of txRows.results) {
    const isTransfer = tx.tx_type === 'transfer';
    const catLevel = tx.cat_level as number | null;
    const catParentName = tx.cat_parent_name as string | null;
    let categoryCol = '';
    let subCategoryCol = '';
    if (!isTransfer) {
      if (catLevel === 2 && catParentName) {
        categoryCol = catParentName;
        subCategoryCol = String(tx.category_name ?? '');
      } else {
        categoryCol = String(tx.category_name ?? '');
      }
    }
    const typeLabel = typeLabels[String(tx.tx_type ?? '')] ?? String(tx.tx_type ?? '');
    const amount = tx.amount != null ? Number(tx.amount).toFixed(2) : '';
    const currency = String((tx.currency_code as string | null) ?? ledger.currency ?? 'CNY').toUpperCase();
    const happenedAt = tx.happened_at as string | null;
    let timeStr = '';
    if (happenedAt) {
      const d = new Date(happenedAt);
      if (!isNaN(d.getTime())) {
        const local = new Date(d.getTime() + tzOffset * 60000);
        const pad = (n: number) => String(n).padStart(2, '0');
        // 纯算术偏移后取 UTC 字段(对齐上游 datetime+timedelta 语义,避免依赖运行时区)
        timeStr = `  ${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())} ${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}  `;
      }
    }
    const row = [
      csvField(typeLabel),
      csvField(categoryCol),
      csvField(subCategoryCol),
      amount,
      csvField(currency),
      csvField(isTransfer ? '' : (tx.account_name as string)),
      csvField(isTransfer ? (tx.from_account_name as string) : ''),
      csvField(isTransfer ? (tx.to_account_name as string) : ''),
      csvField(tx.note as string),
      csvField(timeStr),
      csvField(tagsList(tx.tags_csv as string | null).join(',')),
      csvField(attachmentNames(tx.attachments_json as string | null).join(',')),
    ].join(',');
    rows.push(row);
  }

  const csvContent = '\uFEFF' + headers.join(',') + '\r\n' + rows.join('\r\n');
  const now = new Date();
  const periodFrom = dateFrom ? dateFrom.slice(0, 10) : 'all';
  const periodTo = dateTo ? dateTo.slice(0, 10) : 'all';
  const periodSegment = !dateFrom && !dateTo
    ? `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`
    : `${periodFrom}_${periodTo}`;
  const filename = `beecount-${sanitizeFilename(ledger.name)}-${periodSegment}.csv`;
  const asciiFilename = filename.replace(/[^\x20-\x7e]/g, '_');
  const encodedFilename = encodeURIComponent(filename);

  return new Response(csvContent, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${asciiFilename}"; filename*=UTF-8''${encodedFilename}`,
      'Cache-Control': 'no-store',
    },
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
    WHERE (l.user_id = ? OR lm.user_id = ?)
      AND NOT EXISTS (
        SELECT 1 FROM sync_changes sc
        WHERE sc.ledger_id = l.id AND sc.entity_type = 'ledger_snapshot'
          AND sc.action = 'delete'
          AND sc.change_id = (SELECT MAX(sc2.change_id) FROM sync_changes sc2
                              WHERE sc2.ledger_id = l.id AND sc2.entity_type = 'ledger_snapshot')
      )`;
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

  let acctQuery = `SELECT * FROM user_account_projection WHERE 1=1`;
  const acctParams: string[] = [];

  // 默认按当前用户过滤，防止看到其他用户的数据
  if (filterUserId) {
    acctQuery += ' AND user_id = ?';
    acctParams.push(filterUserId);
  } else {
    acctQuery += ' AND user_id = ?';
    acctParams.push(userId);
  }

  if (q) {
    acctQuery += ' AND name LIKE ?';
    acctParams.push(`%${q}%`);
  }

  acctQuery += ' ORDER BY LOWER(name) ASC LIMIT ? OFFSET ?';
  acctParams.push(String(limit), String(offset));

  const acctRows = await db.prepare(acctQuery).bind(...acctParams).all<Record<string, unknown>>();

  // 获取当前用户信息（用于 created_by_user_id/created_by_email）
  const currentUser = await db.prepare('SELECT id, email FROM users WHERE id = ?').bind(userId).first<{ id: string; email: string }>();

  // 用户级 account 变更 max change_id(前端缓存失效 key,对齐原版 workspace.py:633-640)
  const targetUserId = filterUserId ?? userId;
  const accountLastChange = await db.prepare(
    "SELECT COALESCE(MAX(change_id), 0) as last FROM sync_changes WHERE user_id = ? AND scope = 'user' AND entity_type = 'account'"
  ).bind(targetUserId).first<{ last: number }>();
  const accountLastChangeId = accountLastChange?.last ?? 0;

  // 跨账本聚合(对齐原版 workspace.py 的 main_stats/transfer_from/transfer_to 三条 GROUP BY,
  // 取代旧实现"逐账户一条全账本 SUM"的 N+1;账户维度读 amount 原币,与原版一致)
  const plh = ledgerInternalIds.map(() => '?').join(',');

  const mainStats = await db.prepare(`
    SELECT account_sync_id,
           COUNT(*) as cnt,
           COALESCE(SUM(CASE WHEN tx_type = 'income' THEN amount ELSE 0 END), 0) as income,
           COALESCE(SUM(CASE WHEN tx_type = 'expense' THEN amount ELSE 0 END), 0) as expense
    FROM read_tx_projection
    WHERE ledger_id IN (${plh}) AND account_sync_id IS NOT NULL
      AND tx_type IN ('income','expense')
    GROUP BY account_sync_id
  `).bind(...ledgerInternalIds).all<{ account_sync_id: string; cnt: number; income: number; expense: number }>();

  const transferFrom = await db.prepare(`
    SELECT from_account_sync_id as account_sync_id, COUNT(*) as cnt, COALESCE(SUM(amount), 0) as amt
    FROM read_tx_projection
    WHERE ledger_id IN (${plh}) AND tx_type = 'transfer' AND from_account_sync_id IS NOT NULL
    GROUP BY from_account_sync_id
  `).bind(...ledgerInternalIds).all<{ account_sync_id: string; cnt: number; amt: number }>();

  const transferTo = await db.prepare(`
    SELECT to_account_sync_id as account_sync_id, COUNT(*) as cnt, COALESCE(SUM(amount), 0) as amt
    FROM read_tx_projection
    WHERE ledger_id IN (${plh}) AND tx_type = 'transfer' AND to_account_sync_id IS NOT NULL
    GROUP BY to_account_sync_id
  `).bind(...ledgerInternalIds).all<{ account_sync_id: string; cnt: number; amt: number }>();

  // 合并 per-account 统计：income/expense 类型计入收支,转账影响计入 movement(与原版 stats dict 同逻辑)
  const stats: Record<string, { count: number; income: number; expense: number; movement: number }> = {};
  for (const r of mainStats.results) {
    stats[r.account_sync_id] = { count: Number(r.cnt), income: Number(r.income), expense: Number(r.expense), movement: Number(r.income) - Number(r.expense) };
  }
  for (const r of transferFrom.results) {
    const b = stats[r.account_sync_id] ??= { count: 0, income: 0, expense: 0, movement: 0 };
    b.count += Number(r.cnt);
    b.movement -= Number(r.amt);
  }
  for (const r of transferTo.results) {
    const b = stats[r.account_sync_id] ??= { count: 0, income: 0, expense: 0, movement: 0 };
    b.count += Number(r.cnt);
    b.movement += Number(r.amt);
  }

  const items = [];
  for (const row of acctRows.results) {
    // 对齐原版 workspace.py:650-652:trim 空白并跳过空名账户
    const name = String(row.name ?? '').trim();
    if (!name) continue;

    const ledExtId = ''; // user-global 不挂账本
    const accountSyncId = row.sync_id as string;
    const initialBalance = (row.initial_balance as number) ?? 0;
    const bucket = stats[accountSyncId];
    // income_total/expense_total 仅统计 income/expense 类型交易(对齐原版);转账收支影响进 balance
    const incomeTotal = bucket?.income ?? 0;
    const expenseTotal = bucket?.expense ?? 0;
    const balance = initialBalance + (bucket?.movement ?? 0);

    items.push({
      id: accountSyncId,
      name,
      account_type: row.account_type,
      currency: row.currency,
      initial_balance: initialBalance,
      last_change_id: accountLastChangeId, // 用户级 max change_id(原版缓存失效 key)
      ledger_id: ledExtId,
      ledger_name: null,
      created_by_user_id: currentUser?.id ?? null,
      created_by_email: currentUser?.email ?? null,
      note: row.note,
      credit_limit: row.credit_limit,
      billing_day: row.billing_day,
      payment_due_day: row.payment_due_day,
      bank_name: row.bank_name,
      card_last_four: row.card_last_four,
      hidden: Boolean(row.hidden),
      tx_count: bucket?.count ?? 0,
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
    WHERE (l.user_id = ? OR lm.user_id = ?)
      AND NOT EXISTS (
        SELECT 1 FROM sync_changes sc
        WHERE sc.ledger_id = l.id AND sc.entity_type = 'ledger_snapshot'
          AND sc.action = 'delete'
          AND sc.change_id = (SELECT MAX(sc2.change_id) FROM sync_changes sc2
                              WHERE sc2.ledger_id = l.id AND sc2.entity_type = 'ledger_snapshot')
      )`;
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

  let catQuery = `SELECT * FROM user_category_projection WHERE 1=1`;
  const catParams: string[] = [];

  if (filterUserId) {
    catQuery += ' AND user_id = ?';
    catParams.push(filterUserId);
  } else {
    catQuery += ' AND user_id = ?';
    catParams.push(userId);
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

  const currentUser = await db.prepare('SELECT id, email FROM users WHERE id = ?').bind(userId).first<{ id: string; email: string }>();

  // 用户级 category 变更 max change_id(前端缓存失效 key,对齐上游)
  const catLastChange = await db.prepare(
    "SELECT COALESCE(MAX(change_id), 0) as last FROM sync_changes WHERE user_id = ? AND scope = 'user' AND entity_type = 'category'"
  ).bind(filterUserId ?? userId).first<{ last: number }>();
  const catLastChangeId = catLastChange?.last ?? 0;

  const items = catRows.results.map((row) => {
    const ledExtId = ''; // user-global 不挂账本
    const name = String(row.name ?? '').trim();
    if (!name) return null; // 对齐上游:跳过空名分类

    return {
      id: row.sync_id,
      name,
      kind: (row.kind as string) || 'expense',
      level: (row.level as number) ?? 1,
      sort_order: (row.sort_order as number) ?? 0,
      icon: row.icon,
      icon_type: row.icon_type,
      custom_icon_path: row.custom_icon_path,
      icon_cloud_file_id: row.icon_cloud_file_id,
      icon_cloud_sha256: row.icon_cloud_sha256,
      parent_name: row.parent_name,
      last_change_id: catLastChangeId,
      ledger_id: ledExtId,
      ledger_name: null,
      created_by_user_id: currentUser?.id ?? null,
      created_by_email: currentUser?.email ?? null,
      tx_count: txCountMap[row.sync_id as string] ?? 0,
    };
  }).filter((x): x is NonNullable<typeof x> => x !== null);

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
    WHERE (l.user_id = ? OR lm.user_id = ?)
      AND NOT EXISTS (
        SELECT 1 FROM sync_changes sc
        WHERE sc.ledger_id = l.id AND sc.entity_type = 'ledger_snapshot'
          AND sc.action = 'delete'
          AND sc.change_id = (SELECT MAX(sc2.change_id) FROM sync_changes sc2
                              WHERE sc2.ledger_id = l.id AND sc2.entity_type = 'ledger_snapshot')
      )`;
  const ledgerParams: string[] = [userId, userId, userId];

  if (ledgerId) {
    ledgerQuery += ' AND l.external_id = ?';
    ledgerParams.push(ledgerId);
  }

  const ledgers = await db.prepare(ledgerQuery).bind(...ledgerParams).all<{ id: string; external_id: string; name: string | null }>();

  // 无账本时标签仍返回(上游允许 user-global 标签独立存在,stats 为空集)
  const ledgerInternalIds = ledgers.results.map((l) => l.id);
  const ledgerMeta: Record<string, { external_id: string; name: string | null }> = {};
  ledgers.results.forEach((l) => {
    ledgerMeta[l.id] = { external_id: l.external_id, name: l.name };
  });

  let tagQuery = `SELECT * FROM user_tag_projection WHERE 1=1`;
  const tagParams: string[] = [];

  if (filterUserId) {
    tagQuery += ' AND user_id = ?';
    tagParams.push(filterUserId);
  } else {
    tagQuery += ' AND user_id = ?';
    tagParams.push(userId);
  }

  if (q) {
    tagQuery += ' AND name LIKE ?';
    tagParams.push(`%${q}%`);
  }

  tagQuery += ' ORDER BY LOWER(name) ASC LIMIT ? OFFSET ?';
  tagParams.push(String(limit), String(offset));

  const tagRows = await db.prepare(tagQuery).bind(...tagParams).all<Record<string, unknown>>();

  // 预聚合每个 tag 的 tx 统计 — 单次查询代替 N+1（与原版对齐）
  const tagStats: Record<string, { tx_count: number; expense_total: number; income_total: number }> = {};
  const tagRowsForStats = await db.prepare(`SELECT sync_id, name FROM user_tag_projection WHERE user_id = ?`).bind(userId).all<{ sync_id: string; name: string }>();
  const tagSyncIds = tagRowsForStats.results.map(r => r.sync_id);

  if (ledgerInternalIds.length > 0 && tagSyncIds.length > 0) {
    // 单次扫描所有交易(与原版对齐;exclude_from_stats = false 排除 NULL 行)
    const allTxRows = await db.prepare(
      `SELECT sync_id, tx_type, COALESCE(native_amount, amount) as effective_amount, tag_sync_ids_json, tags_csv 
       FROM read_tx_projection 
       WHERE ledger_id IN (${ledgerInternalIds.map(() => '?').join(',')}) 
       AND exclude_from_stats = false`
    ).bind(...ledgerInternalIds).all<{ sync_id: string; tx_type: string; effective_amount: number; tag_sync_ids_json: string | null; tags_csv: string | null }>();

    // 初始化所有 tag 统计
    for (const tagId of tagSyncIds) {
      tagStats[tagId] = { tx_count: 0, expense_total: 0, income_total: 0 };
    }

    // 遍历交易匹配 tag(主匹配:tag_sync_ids_json,回退:tags_csv 名称不区分大小写)
    for (const tx of allTxRows.results) {
      for (const tagRow of tagRowsForStats.results) {
        let matched = false;
        // 主匹配:tag_sync_ids_json 包含该 tag sync_id
        if (tx.tag_sync_ids_json && tx.tag_sync_ids_json.includes(`"${tagRow.sync_id}"`)) {
          matched = true;
        }
        // 回退匹配:tags_csv 包含该 tag name(对齐上游 lower)
        if (!matched && tx.tags_csv && tagRow.name) {
          const tagNames = tx.tags_csv.split(',').map((s: string) => s.trim().toLowerCase());
          if (tagNames.includes(tagRow.name.toLowerCase())) {
            matched = true;
          }
        }
        if (matched) {
          tagStats[tagRow.sync_id].tx_count++;
          if (tx.tx_type === 'expense') tagStats[tagRow.sync_id].expense_total += tx.effective_amount;
          else if (tx.tx_type === 'income') tagStats[tagRow.sync_id].income_total += tx.effective_amount;
        }
      }
    }
  }

  const currentUser = await db.prepare('SELECT id, email FROM users WHERE id = ?').bind(userId).first<{ id: string; email: string }>();

  // 用户级 tag 变更 max change_id(前端缓存失效 key,对齐上游)
  const tagLastChange = await db.prepare(
    "SELECT COALESCE(MAX(change_id), 0) as last FROM sync_changes WHERE user_id = ? AND scope = 'user' AND entity_type = 'tag'"
  ).bind(filterUserId ?? userId).first<{ last: number }>();
  const tagLastChangeId = tagLastChange?.last ?? 0;

  const items = tagRows.results.map((row) => {
    const ledExtId = ''; // user-global 不挂账本
    const name = String(row.name ?? '').trim();
    if (!name) return null; // 对齐上游:跳过空名 tag
    const stats = tagStats[row.sync_id as string] ?? { tx_count: 0, expense_total: 0, income_total: 0 };

    return {
      id: row.sync_id,
      name,
      color: row.color,
      last_change_id: tagLastChangeId,
      ledger_id: ledExtId,
      ledger_name: null,
      created_by_user_id: currentUser?.id ?? null,
      created_by_email: currentUser?.email ?? null,
      tx_count: stats.tx_count,
      expense_total: stats.expense_total,
      income_total: stats.income_total,
    };
  }).filter((x): x is NonNullable<typeof x> => x !== null);

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
    WHERE (l.user_id = ? OR lm.user_id = ?)
      AND NOT EXISTS (
        SELECT 1 FROM sync_changes sc
        WHERE sc.ledger_id = l.id AND sc.entity_type = 'ledger_snapshot'
          AND sc.action = 'delete'
          AND sc.change_id = (SELECT MAX(sc2.change_id) FROM sync_changes sc2
                              WHERE sc2.ledger_id = l.id AND sc2.entity_type = 'ledger_snapshot')
      )`;
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

  const currentUser = await db.prepare('SELECT id, email FROM users WHERE id = ?').bind(userId).first<{ id: string; email: string }>();

  // 与 per-ledger list_budgets 同款去重:(budget_type, category_sync_id) 维度,sync_id 字典序最大胜出;
  // category 预算缺 category_sync_id 视为脏数据跳过
  const dedup = new Map<string, Record<string, unknown>>();
  for (const b of budgetRows.results) {
    const btype = (b.budget_type as string) || 'total';
    if (btype === 'category' && !b.category_sync_id) continue;
    const key = `${btype}:${(b.category_sync_id as string) || ''}`;
    const cur = dedup.get(key);
    if (!cur || (cur.sync_id as string) < (b.sync_id as string)) dedup.set(key, b);
  }
  const deduped = [...dedup.values()];

  // 一次收集分类名 + 子分类映射(避免每预算各查一次)
  const catIds = [...new Set(deduped.map((b) => b.category_sync_id as string).filter(Boolean))];
  const catNameMap: Record<string, string> = {};
  const childMap: Record<string, string[]> = {};
  if (catIds.length > 0) {
    const ph = catIds.map(() => '?').join(',');
    const catRows = await db
      .prepare(`SELECT sync_id, name, parent_sync_id FROM user_category_projection WHERE user_id = ? AND sync_id IN (${ph})`)
      .bind(userId, ...catIds)
      .all<{ sync_id: string; name: string | null; parent_sync_id: string | null }>();
    for (const r of catRows.results) {
      if (r.name) catNameMap[r.sync_id] = r.name.trim();
      if (r.parent_sync_id) (childMap[r.parent_sync_id] ??= []).push(r.sync_id);
    }
  }

  const items = await Promise.all(deduped.map(async (row) => {
    const ledExtId = ledgerMeta[row.ledger_id as string]?.external_id ?? '';
    const budgetPeriod = row.period as string;
    const budgetStartDay = (row.start_day as number) || 1;
    const ledgerId = row.ledger_id as string;
    const budgetType = (row.budget_type as string) || 'total';
    const categorySyncId = (row.category_sync_id as string) || null;

    // 计算预算已用金额(对齐原版:按周期汇总支出;多币种折本位币 native_amount 回退 amount)
    let spent = 0;
    try {
      const now = new Date();
      let periodStart: string;
      let periodEnd: string;

      if (budgetPeriod === 'monthly') {
        const startMonth = now.getUTCMonth();
        const startYear = now.getUTCFullYear();
        const startDate = new Date(Date.UTC(startYear, startMonth, budgetStartDay));
        const endDate = new Date(Date.UTC(startYear, startMonth + 1, budgetStartDay));
        periodStart = startDate.toISOString();
        periodEnd = endDate.toISOString();
      } else if (budgetPeriod === 'yearly') {
        const startYear = now.getUTCFullYear();
        periodStart = new Date(Date.UTC(startYear, 0, budgetStartDay)).toISOString();
        periodEnd = new Date(Date.UTC(startYear + 1, 0, budgetStartDay)).toISOString();
      } else {
        periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 7)).toISOString();
        periodEnd = now.toISOString();
      }

      let spentQuery = `SELECT COALESCE(SUM(COALESCE(native_amount, amount)), 0) as total FROM read_tx_projection
         WHERE ledger_id = ? AND tx_type = 'expense'
         AND (exclude_from_budget IS NULL OR exclude_from_budget = 0)
         AND happened_at >= ? AND happened_at < ?`;
      const spentParams: (string | number)[] = [ledgerId, periodStart, periodEnd];

      if (budgetType === 'category' && categorySyncId) {
        // 父分类预算自动覆盖子分类支出(与 per-ledger budgets/usage 同口径)
        const ids = [categorySyncId, ...(childMap[categorySyncId] ?? [])];
        const ph = ids.map(() => '?').join(',');
        spentQuery += ` AND category_sync_id IN (${ph})`;
        spentParams.push(...ids);
      }

      const spentRow = await db.prepare(spentQuery).bind(...spentParams).first<{ total: number }>();
      spent = Math.abs(spentRow?.total ?? 0);
    } catch {
      // 计算失败不影响预算列表
    }

    return {
      id: row.sync_id,
      type: budgetType,
      category_id: categorySyncId,
      category_name: categorySyncId ? (catNameMap[categorySyncId] ?? null) : null,
      amount: row.amount,
      period: row.period,
      start_day: row.start_day,
      enabled: !!row.enabled,
      spent: spent,
      last_change_id: row.source_change_id,
      ledger_id: ledExtId,
      ledger_name: null,
      created_by_user_id: currentUser?.id ?? null,
      created_by_email: currentUser?.email ?? null,
    };
  }));

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
    WHERE (l.user_id = ? OR lm.user_id = ?)
      AND NOT EXISTS (
        SELECT 1 FROM sync_changes sc
        WHERE sc.ledger_id = l.id AND sc.entity_type = 'ledger_snapshot'
          AND sc.action = 'delete'
          AND sc.change_id = (SELECT MAX(sc2.change_id) FROM sync_changes sc2
                              WHERE sc2.ledger_id = l.id AND sc2.entity_type = 'ledger_snapshot')
      )`;
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

  // 计算实际的 distinct_days（与原版对齐）
  const distinctDaysRows = await db
    .prepare(`SELECT DISTINCT substr(happened_at, 1, 10) as day FROM read_tx_projection WHERE ledger_id IN (${ledgerInternalIds.map(() => '?').join(',')})`)
    .bind(...ledgerInternalIds)
    .all<{ day: string }>();
  const distinctDays = distinctDaysRows.results.length;

  let daysSinceFirstTx = 0;
  if (firstAt) {
    // 对齐上游 workspace.py:956-959:按 UTC 日历日差(非 24h 整除)
    const firstDate = new Date(firstAt);
    const now = new Date();
    const firstDayUtc = Date.UTC(firstDate.getUTCFullYear(), firstDate.getUTCMonth(), firstDate.getUTCDate());
    const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    daysSinceFirstTx = Math.floor((todayUtc - firstDayUtc) / (1000 * 60 * 60 * 24)) + 1;
  }

  return c.json({
    tx_count: txCount,
    days_since_first_tx: daysSinceFirstTx,
    distinct_days: distinctDays,
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
  const naturalMonth = c.req.query('natural_month') === 'true';

  // 含共享账本
  let ledgerQuery = `SELECT DISTINCT l.id FROM ledgers l
    LEFT JOIN ledger_members lm ON l.id = lm.ledger_id AND lm.user_id = ?
    WHERE (l.user_id = ? OR lm.user_id = ?)
      AND NOT EXISTS (
        SELECT 1 FROM sync_changes sc
        WHERE sc.ledger_id = l.id AND sc.entity_type = 'ledger_snapshot'
          AND sc.action = 'delete'
          AND sc.change_id = (SELECT MAX(sc2.change_id) FROM sync_changes sc2
                              WHERE sc2.ledger_id = l.id AND sc2.entity_type = 'ledger_snapshot')
      )`;
  const ledgerParams: string[] = [userId, userId, userId];

  if (ledgerId) {
    ledgerQuery += ' AND (external_id = ? OR l.id = ?)';
    ledgerParams.push(ledgerId, ledgerId);
  }

  const ledgers = await db.prepare(ledgerQuery).bind(...ledgerParams).all<{ id: string }>();

  if (ledgers.results.length === 0) {
    return c.json({
      summary: { transaction_count: 0, income_total: 0, expense_total: 0, balance: 0, distinct_days: 0, first_tx_at: null, last_tx_at: null },
      series: [],
      category_ranks: [],
      anomaly_months: [],
      range: { scope, metric, period: null, start_at: null, end_at: null },
    });
  }

  const ledgerInternalIds = ledgers.results.map((l) => l.id);

  // 获取 month_start_day（单账本时使用该账本的设置，多账本默认 1）
  let monthStartDay = 1;
  if (!naturalMonth && ledgerInternalIds.length === 1) {
    const msdRow = await db.prepare('SELECT month_start_day FROM ledgers WHERE id = ?').bind(ledgerInternalIds[0]).first<{ month_start_day: number }>();
    if (msdRow?.month_start_day) monthStartDay = Math.min(Math.max(msdRow.month_start_day, 1), 28);
  }

  // exclude_from_stats=true 的交易不计入收支统计（与原版对齐）
  let txQuery = `SELECT tx_type, COALESCE(native_amount, amount) as effective_amount, happened_at, category_name FROM read_tx_projection WHERE ledger_id IN (${ledgerInternalIds.map(() => '?').join(',')}) AND (exclude_from_stats IS NULL OR exclude_from_stats = 0 OR exclude_from_stats = false)`;
  const txParams: (string | number)[] = [...ledgerInternalIds];

  // 计算日期范围（移植原版 _analytics_range + month_start_day 契约）
  const { startAt, endAt, normalizedPeriod } = analyticsRange(scope, period, tzOffsetMinutes, monthStartDay);
  if (startAt && endAt) {
    txQuery += ' AND happened_at >= ? AND happened_at < ?';
    txParams.push(startAt, endAt);
  }

  const txRows = await db
    .prepare(txQuery)
    .bind(...txParams)
    .all<{ tx_type: string; effective_amount: number; amount: number; happened_at: string; category_name: string | null }>();

  let incomeTotal = 0;
  let expenseTotal = 0;
  const seriesMap: Record<string, { expense: number; income: number }> = {};
  const categoryMap: Record<string, { expense: number; income: number; count: number }> = {};
  const categoryByBucket: Record<string, Record<string, number>> = {};
  const distinctDays = new Set<string>();
  let firstTxAt: string | null = null;
  let lastTxAt: string | null = null;

  for (const tx of txRows.results) {
    const amt = Number(tx.effective_amount ?? tx.amount ?? 0);
    if (tx.tx_type === 'income') {
      incomeTotal += amt;
    } else if (tx.tx_type === 'expense') {
      expenseTotal += amt;
    }

    const localDate = new Date(new Date(tx.happened_at).getTime() + tzOffsetMinutes * 60000);
    // 分桶（移植原版 _bucket_key：month 日粒度/year+all 月粒度按 msd 切桶）
    const bucket = bucketKey(scope, tx.happened_at, tzOffsetMinutes, monthStartDay);

    // distinct_days 用时区调整后的日期
    distinctDays.add(localDate.toISOString().slice(0, 10));

    // 记录首尾交易时间
    if (!firstTxAt || tx.happened_at < firstTxAt) firstTxAt = tx.happened_at;
    if (!lastTxAt || tx.happened_at > lastTxAt) lastTxAt = tx.happened_at;

    if (!seriesMap[bucket]) {
      seriesMap[bucket] = { expense: 0, income: 0 };
    }
    if (!categoryByBucket[bucket]) {
      categoryByBucket[bucket] = {};
    }
    if (!categoryMap[tx.category_name ?? 'Uncategorized']) {
      categoryMap[tx.category_name ?? 'Uncategorized'] = { expense: 0, income: 0, count: 0 };
    }

    if (tx.tx_type === 'income') {
      seriesMap[bucket].income += amt;
      categoryMap[tx.category_name ?? 'Uncategorized'].income += amt;
    } else if (tx.tx_type === 'expense') {
      seriesMap[bucket].expense += amt;
      categoryMap[tx.category_name ?? 'Uncategorized'].expense += amt;
      categoryByBucket[bucket][tx.category_name ?? 'Uncategorized'] = (categoryByBucket[bucket][tx.category_name ?? 'Uncategorized'] ?? 0) + amt;
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

  // 异常月份检测（与原版 _compute_anomaly_months 对齐）
  const anomalyMonths = computeAnomalyMonths(series, categoryByBucket);

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
    anomaly_months: anomalyMonths,
    range: {
      scope, metric, period,
      // 对齐原版 WorkspaceAnalyticsRangeOut:end_at 取上一秒(含首尾 -1s)
      start_at: startAt,
      end_at: endAt ? new Date(new Date(endAt).getTime() - 1000).toISOString() : null,
    },
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

workspaceRouter.post('/ledgers/:id/invites', zValidator('json', InviteSchema), async (c) => {
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
    return c.json({ error: 'Only the owner can generate invite codes' }, 403);
  }

  const memberCount = await db
    .prepare('SELECT COUNT(*) as cnt FROM ledger_members WHERE ledger_id = ?')
    .bind(ledger.id)
    .first<{ cnt: number }>();

  if ((memberCount?.cnt ?? 0) >= 5) {
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
      .prepare('SELECT code FROM ledger_invites WHERE code = ?')
      .bind(inviteCode)
      .first();
    if (!existing) break;
    inviteCode = generateInviteCode();
    attempts++;
  }

  const expiresAt = new Date(Date.now() + req.expires_in_hours * 3600 * 1000).toISOString();

  await db
    .prepare(
      `INSERT INTO ledger_invites (code, ledger_id, target_role, invited_by, expires_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .bind(inviteCode, ledger.id, req.target_role, userId, expiresAt)
    .run();

  await insertAuditLog({
    db, userId, ledgerId: ledger.id, action: 'invite', entityType: 'ledger_invites', entityId: inviteCode,
    details: { expires_at: expiresAt, target_role: req.target_role },
  });

  const shareOrigin = (c.env as any).INVITE_SHARE_ORIGIN || c.req.header('Origin') || `https://${c.req.header('Host')}` || 'https://beecount.qzz.io';
  const shareUrl = `${shareOrigin.replace(/\/+$/, '')}/invite/${inviteCode}`;

  return c.json({
    code: inviteCode,
    formatted_code: formatInviteCode(inviteCode),
    expires_at: expiresAt,
    created_at: nowUtc(),
    target_role: req.target_role,
    share_url: shareUrl,
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
      `SELECT code, target_role, invited_by, expires_at, used_at, used_by, created_at
       FROM ledger_invites
       WHERE ledger_id = ? AND used_at IS NULL AND expires_at > ?
       ORDER BY created_at DESC`
    )
    .bind(ledger.id, nowUtc())
    .all<{
      code: string;
      target_role: string;
      invited_by: string;
      expires_at: string;
      used_at: string | null;
      used_by: string | null;
      created_at: string;
    }>();

  const shareOrigin = (c.env as any).INVITE_SHARE_ORIGIN || c.req.header('Origin') || `https://${c.req.header('Host')}` || 'https://beecount.qzz.io';
  const result = invites.results.map((inv) => ({
      id: inv.code, // v3 后 ledger_invites 主键是 code（原 id 列已删），响应保持 id 字段兼容
      code: inv.code,
      formatted_code: formatInviteCode(inv.code),
      target_role: inv.target_role,
      invited_by_user_id: inv.invited_by,
      expires_at: inv.expires_at,
      created_at: inv.created_at,
      share_url: `${shareOrigin.replace(/\/+$/, '')}/invite/${inv.code}`,
    }));

  return c.json(result);
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
      `SELECT li.code, li.target_role, li.expires_at, li.used_at, li.invited_by,
              l.external_id, l.name as ledger_name, l.currency,
              u.email as owner_email,
              p.display_name as owner_display_name
       FROM ledger_invites li
       JOIN ledgers l ON li.ledger_id = l.id
       JOIN users u ON l.user_id = u.id
       LEFT JOIN user_profiles p ON p.user_id = l.user_id
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
      owner_display_name: string | null;
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
    invited_by_display_name: invite.owner_display_name ?? invite.owner_email,
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
      `SELECT li.ledger_id, li.code, li.target_role, li.expires_at, li.used_at, li.invited_by,
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
    .prepare('SELECT user_id FROM ledger_members WHERE ledger_id = ? AND user_id = ?')
    .bind(invite.ledger_id, userId)
    .first();

  if (existingMember) {
    return c.json({ message: 'Already a member', ledger_id: invite.external_id, ledger_name: invite.ledger_name });
  }

  const memberCount = await db
    .prepare('SELECT COUNT(*) as cnt FROM ledger_members WHERE ledger_id = ?')
    .bind(invite.ledger_id)
    .first<{ cnt: number }>();

  if ((memberCount?.cnt ?? 0) >= 5) {
    return c.json({ error: 'Ledger has reached the maximum member limit' }, 400);
  }

  // 并发保护：用 try-catch 捕获 UNIQUE 约束冲突（与原版 SELECT FOR UPDATE 对齐）
  try {
    await db
      .prepare('INSERT INTO ledger_members (ledger_id, user_id, role, invited_by, joined_at) VALUES (?, ?, ?, ?, ?)')
      .bind(invite.ledger_id, userId, invite.target_role, invite.invited_by, new Date().toISOString())
      .run();
  } catch (err) {
    if ((err as Error).message?.includes('UNIQUE')) {
      // 已是成员（并发请求竞争），返回成功
      const cnt = await db.prepare('SELECT COUNT(*) as cnt FROM ledger_members WHERE ledger_id = ?').bind(invite.ledger_id).first<{ cnt: number }>();
      const li = await db.prepare('SELECT currency FROM ledgers WHERE id = ?').bind(invite.ledger_id).first<{ currency: string }>();
      return c.json({ ledger_id: invite.external_id, ledger_name: invite.ledger_name, ledger_currency: li?.currency ?? 'CNY', role: invite.target_role, member_count: (cnt?.cnt ?? 0) });
    }
    throw err;
  }

  await db
    .prepare('UPDATE ledger_invites SET used_at = ?, used_by = ? WHERE code = ?')
    .bind(nowUtc(), userId, invite.code)
    .run();

  // 查询 member_count 和 currency（与原版对齐）
  const updatedCount = await db
    .prepare('SELECT COUNT(*) as cnt FROM ledger_members WHERE ledger_id = ?')
    .bind(invite.ledger_id)
    .first<{ cnt: number }>();
  const ledgerInfo = await db
    .prepare('SELECT currency FROM ledgers WHERE id = ?')
    .bind(invite.ledger_id)
    .first<{ currency: string }>();

  // WS 广播 member_change（与原版 broadcast_to_ledger 对齐）
  try {
    const members = await db.prepare('SELECT user_id FROM ledger_members WHERE ledger_id = ?').bind(invite.ledger_id).all<{ user_id: string }>();
    const { getWsManager } = await import('../lib/ws-manager');
    for (const m of members.results) {
      await getWsManager().broadcastToUser(m.user_id, { type: 'member_change', ledgerId: invite.external_id, changeType: 'added', userId });
    }
  } catch {}
  try {
    const doId = c.env.BEECOUNT_DO.idFromName(`ws-${userId}`);
    const doStub = c.env.BEECOUNT_DO.get(doId);
    await doStub.fetch(new Request('https://dummy/broadcast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: JSON.stringify({ type: 'member_change', ledgerId: invite.external_id, changeType: 'added', userId }) }),
    }));
  } catch {}

  await insertAuditLog({
    db, userId, ledgerId: invite.ledger_id, action: 'join', entityType: 'ledger', entityId: invite.external_id,
    details: { invite_code: invite.code, target_role: invite.target_role },
  });

  return c.json({
    ledger_id: invite.external_id,
    ledger_name: invite.ledger_name,
    ledger_currency: ledgerInfo?.currency ?? 'CNY',
    role: invite.target_role,
    member_count: (updatedCount?.cnt ?? 0),
  });
});

// ===========================================================================
// POST /workspace/invites/:code/accept - 前端加入共享账本（别名）
// ===========================================================================

workspaceRouter.post('/invites/:code/accept', async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const inviteCode = c.req.param('code');

  const invite = await db
    .prepare(
      `SELECT li.ledger_id, li.code, li.target_role, li.expires_at, li.used_at, li.invited_by,
              l.external_id, l.name as ledger_name, l.user_id as owner_user_id
       FROM ledger_invites li
       JOIN ledgers l ON li.ledger_id = l.id
       WHERE li.code = ?`
    )
    .bind(inviteCode)
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
    .prepare('SELECT user_id FROM ledger_members WHERE ledger_id = ? AND user_id = ?')
    .bind(invite.ledger_id, userId)
    .first();

  if (existingMember) {
    const cnt = await db.prepare('SELECT COUNT(*) as cnt FROM ledger_members WHERE ledger_id = ?').bind(invite.ledger_id).first<{ cnt: number }>();
    const li = await db.prepare('SELECT currency FROM ledgers WHERE id = ?').bind(invite.ledger_id).first<{ currency: string }>();
    return c.json({ ledger_id: invite.external_id, ledger_name: invite.ledger_name, ledger_currency: li?.currency ?? 'CNY', role: invite.target_role, member_count: (cnt?.cnt ?? 0) });
  }

  // 并发保护：try-catch 捕获 UNIQUE 约束冲突
  try {
    await db
      .prepare('INSERT INTO ledger_members (ledger_id, user_id, role, invited_by, joined_at) VALUES (?, ?, ?, ?, ?)')
      .bind(invite.ledger_id, userId, invite.target_role, invite.invited_by, nowUtc())
      .run();
  } catch (err) {
    if ((err as Error).message?.includes('UNIQUE')) {
      const cnt = await db.prepare('SELECT COUNT(*) as cnt FROM ledger_members WHERE ledger_id = ?').bind(invite.ledger_id).first<{ cnt: number }>();
      const li = await db.prepare('SELECT currency FROM ledgers WHERE id = ?').bind(invite.ledger_id).first<{ currency: string }>();
      return c.json({ ledger_id: invite.external_id, ledger_name: invite.ledger_name, ledger_currency: li?.currency ?? 'CNY', role: invite.target_role, member_count: (cnt?.cnt ?? 0) });
    }
    throw err;
  }

  await db.prepare('UPDATE ledger_invites SET used_at = ?, used_by = ? WHERE code = ?')
    .bind(nowUtc(), userId, invite.code)
    .run();

  const updatedCount = await db.prepare('SELECT COUNT(*) as cnt FROM ledger_members WHERE ledger_id = ?').bind(invite.ledger_id).first<{ cnt: number }>();
  const ledgerInfo = await db.prepare('SELECT currency FROM ledgers WHERE id = ?').bind(invite.ledger_id).first<{ currency: string }>();

  // WS 广播 member_change
  try {
    const members = await db.prepare('SELECT user_id FROM ledger_members WHERE ledger_id = ?').bind(invite.ledger_id).all<{ user_id: string }>();
    const { getWsManager } = await import('../lib/ws-manager');
    for (const m of members.results) {
      await getWsManager().broadcastToUser(m.user_id, { type: 'member_change', ledgerId: invite.external_id, changeType: 'added', userId });
    }
  } catch {}

  return c.json({
    ledger_id: invite.external_id,
    ledger_name: invite.ledger_name,
    ledger_currency: ledgerInfo?.currency ?? 'CNY',
    role: invite.target_role,
    member_count: (updatedCount?.cnt ?? 0),
  });
});

// ===========================================================================
// GET /workspace/ledgers/:id/members - 列出成员
// ===========================================================================

workspaceRouter.get('/ledgers/:id/members', async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const ledgerExternalId = c.req.param('id');

  // is_shared 由成员表派生：owner 或任一成员可访问（修复双来源不一致）
  const ledger = await db
    .prepare(
      `SELECT l.id, l.user_id FROM ledgers l
       WHERE l.external_id = ?
         AND (l.user_id = ? OR EXISTS (SELECT 1 FROM ledger_members lm WHERE lm.ledger_id = l.id AND lm.user_id = ?))`
    )
    .bind(ledgerExternalId, userId, userId)
    .first<{ id: string; user_id: string }>();

  if (!ledger) {
    return c.json({ error: 'Ledger not found or access denied' }, 404);
  }

  const members = await db
    .prepare(`
      SELECT lm.user_id, lm.role, lm.joined_at, lm.invited_by, u.email,
             p.display_name, p.avatar_file_id, p.avatar_version
      FROM ledger_members lm
      JOIN users u ON lm.user_id = u.id
      LEFT JOIN user_profiles p ON p.user_id = u.id
      WHERE lm.ledger_id = ?
      ORDER BY lm.joined_at ASC
    `)
    .bind(ledger.id)
    .all<{ user_id: string; role: string; joined_at: string; invited_by: string | null; email: string; display_name: string | null; avatar_file_id: string | null; avatar_version: number | null }>();

  // 对齐上游 MemberOut:补齐 display_name/invited_by_user_id/is_self/avatar_*
  return c.json(members.results.map((m) => ({
    user_id: m.user_id,
    email: m.email,
    display_name: m.display_name,
    role: m.role,
    joined_at: m.joined_at,
    invited_by_user_id: m.invited_by,
    is_self: m.user_id === userId,
    avatar_url: m.avatar_file_id ? `/api/v1/profile/avatar/${m.user_id}?v=${m.avatar_version ?? 0}` : null,
    avatar_version: m.avatar_version ?? 0,
  })));
});

// ===========================================================================
// PATCH /workspace/ledgers/:id/members/:memberUserId - 修改成员角色（仅 Owner）
// 对齐原版 Phase 1：只允许 editor → editor（no-op 写回），owner 切换走 transfer，
// 不允许把成员改成 owner。变更后 WS 广播 member_change。
// ===========================================================================

const MemberRoleUpdateSchema = z.object({
  role: z.literal('editor'),
});

workspaceRouter.patch('/ledgers/:id/members/:memberUserId', zValidator('json', MemberRoleUpdateSchema), async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const ledgerExternalId = c.req.param('id');
  const memberUserId = c.req.param('memberUserId');
  const req = c.req.valid('json');

  const ledger = await db
    .prepare('SELECT id, user_id FROM ledgers WHERE user_id = ? AND external_id = ?')
    .bind(userId, ledgerExternalId)
    .first<{ id: string; user_id: string }>();

  if (!ledger || ledger.user_id !== userId) {
    return c.json({ error: 'Ledger not found or not owned by you' }, 404);
  }

  if (memberUserId === userId) {
    return c.json({ error: 'Owner cannot change own role; use transfer endpoint' }, 409);
  }

  const target = await db
    .prepare('SELECT user_id, role FROM ledger_members WHERE ledger_id = ? AND user_id = ?')
    .bind(ledger.id, memberUserId)
    .first<{ user_id: string; role: string }>();
  if (!target) {
    return c.json({ error: 'Member not found' }, 404);
  }

  // Phase 1 仅允许 editor → editor（no-op 写回），未来扩展角色体系
  if (req.role !== 'editor') {
    return c.json({ error: `Unsupported role: ${req.role}` }, 400);
  }
  await db.prepare('UPDATE ledger_members SET role = ? WHERE ledger_id = ? AND user_id = ?')
    .bind('editor', ledger.id, memberUserId).run();

  await insertAuditLog({
    db, userId, ledgerId: ledger.id, action: 'update_meta', entityType: 'ledger', entityId: ledgerExternalId,
    details: { member_role_update: memberUserId, role: req.role },
  });

  // WS 广播 member_change（角色变更）给账本所有成员
  try {
    const members = await db.prepare('SELECT user_id FROM ledger_members WHERE ledger_id = ?').bind(ledger.id).all<{ user_id: string }>();
    const allUserIds = new Set([userId, ...members.results.map(m => m.user_id)]);
    const payload = { type: 'member_change', ledgerId: ledgerExternalId, changeType: 'role_changed', userId: memberUserId, newRole: req.role };
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

  return c.json({
    user_id: memberUserId,
    ledger_id: ledgerExternalId,
    role: req.role,
  });
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

  // 对齐原版：踢成员成功返回 204 No Content（前端 removeLedgerMember 只看 res.ok）
  return new Response(null, { status: 204 });
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

  // 计算日期范围（与原版 _analytics_range 对齐）
  const monthStartDay = Math.min(Math.max(ledger.month_start_day ?? 1, 1), 28);
  let startAt: string | null = null;
  let endAt: string | null = null;
  let normalizedPeriod: string | null = null;
  let dateFilter = '';
  const dateParams: string[] = [];

  if (scope === 'all') {
    // scope=all 不设日期范围
  } else if (scope === 'month') {
    const now = new Date();
    const tzMs = tz_offset_minutes * 60 * 1000;
    const localNow = new Date(now.getTime() + tzMs);
    let targetYear = localNow.getUTCFullYear();
    let targetMonth = localNow.getUTCMonth() + 1;
    if (period) {
      const parts = period.split('-');
      targetYear = parseInt(parts[0], 10);
      targetMonth = parseInt(parts[1], 10);
    } else {
      // 默认当前周期（与原版对齐）
      if (localNow.getUTCDate() < monthStartDay) {
        if (targetMonth === 1) { targetYear--; targetMonth = 12; }
        else { targetMonth--; }
      }
    }
    normalizedPeriod = `${targetYear}-${String(targetMonth).padStart(2, '0')}`;
    const startLocal = new Date(Date.UTC(targetYear, targetMonth - 1, monthStartDay, 0, 0, 0) - tzMs);
    const endLocal = new Date(Date.UTC(targetYear, targetMonth, monthStartDay, 0, 0, 0) - tzMs);
    startAt = startLocal.toISOString();
    endAt = endLocal.toISOString();
    dateFilter = 'AND happened_at >= ? AND happened_at < ?';
    dateParams.push(startAt, endAt);
  } else if (scope === 'year') {
    const now = new Date();
    const tzMs = tz_offset_minutes * 60 * 1000;
    const localNow = new Date(now.getTime() + tzMs);
    let targetYear = localNow.getUTCFullYear();
    if (period) {
      targetYear = parseInt(period, 10);
    } else {
      // 1月里还没到起始日时归上一年度周期
      if (localNow.getUTCMonth() === 0 && localNow.getUTCDate() < monthStartDay) {
        targetYear--;
      }
    }
    normalizedPeriod = String(targetYear);
    const startLocal = new Date(Date.UTC(targetYear, 0, monthStartDay, 0, 0, 0) - tzMs);
    const endLocal = new Date(Date.UTC(targetYear + 1, 0, monthStartDay, 0, 0, 0) - tzMs);
    startAt = startLocal.toISOString();
    endAt = endLocal.toISOString();
    dateFilter = 'AND happened_at >= ? AND happened_at < ?';
    dateParams.push(startAt, endAt);
  }

  // 获取所有成员（含所有者）
  const owner = await db
    .prepare('SELECT id, email FROM users WHERE id = ?')
    .bind(ledger.user_id)
    .first<{ id: string; email: string }>();

  const memberRows = await db
    .prepare('SELECT user_id, role FROM ledger_members WHERE ledger_id = ?')
    .bind(ledger.id)
    .all<{ user_id: string; role: string }>();

  const roleByUid: Record<string, string> = {};
  const allUserIds = new Set<string>();
  if (owner) {
    allUserIds.add(owner.id);
    roleByUid[owner.id] = 'owner';
  }
  for (const m of memberRows.results) {
    allUserIds.add(m.user_id);
    roleByUid[m.user_id] = m.role;
  }

  // 已退成员:账本内出现过的 created_by_user_id 即使不在 ledger_members 也纳入,
  // 角色标 'removed'(对齐上游 member_stats)
  const txCreatorRows = await db
    .prepare('SELECT DISTINCT created_by_user_id FROM read_tx_projection WHERE ledger_id = ? AND created_by_user_id IS NOT NULL')
    .bind(ledger.id)
    .all<{ created_by_user_id: string }>();
  for (const r of txCreatorRows.results) {
    allUserIds.add(r.created_by_user_id);
  }

  // 查询用户信息
  const uidList = [...allUserIds];
  const userInfo: Record<string, { email: string | null; display_name: string | null; avatar_file_id: string | null; avatar_version: number }> = {};
  if (uidList.length > 0) {
    const placeholders = uidList.map(() => '?').join(',');
    const users = await db
      .prepare(`SELECT u.id, u.email, p.display_name, p.avatar_file_id, p.avatar_version
                FROM users u LEFT JOIN user_profiles p ON p.user_id = u.id
                WHERE u.id IN (${placeholders})`)
      .bind(...uidList)
      .all<{ id: string; email: string | null; display_name: string | null; avatar_file_id: string | null; avatar_version: number }>();
    for (const u of users.results) {
      userInfo[u.id] = { email: u.email, display_name: u.display_name, avatar_file_id: u.avatar_file_id, avatar_version: u.avatar_version || 0 };
    }
  }

  // 查询交易统计
  const stats: Record<string, { income: number; expense: number; tx_count: number }> = {};
  for (const uid of uidList) {
    stats[uid] = { income: 0, expense: 0, tx_count: 0 };
  }

  if (uidList.length > 0) {
    const placeholders = uidList.map(() => '?').join(',');
    const txRows = await db
      .prepare(
        `SELECT created_by_user_id, tx_type, COALESCE(native_amount, amount) as effective_amount
         FROM read_tx_projection
         WHERE ledger_id = ? AND created_by_user_id IN (${placeholders})
           AND tx_type != 'transfer'
           AND (exclude_from_stats IS NULL OR exclude_from_stats = 0 OR exclude_from_stats = false)
           ${dateFilter}`
      )
      .bind(ledger.id, ...uidList, ...dateParams)
      .all<{ created_by_user_id: string | null; tx_type: string; effective_amount: number }>();

    for (const tx of txRows.results) {
      if (!tx.created_by_user_id) continue;
      if (!stats[tx.created_by_user_id]) continue;
      stats[tx.created_by_user_id].tx_count += 1;
      if (tx.tx_type === 'income') {
        stats[tx.created_by_user_id].income += tx.effective_amount;
      } else if (tx.tx_type === 'expense') {
        stats[tx.created_by_user_id].expense += tx.effective_amount;
      }
    }
  }

  // 构建响应（与原版对齐）
  const items = uidList.map((uid) => {
    const info = userInfo[uid] || { email: null, display_name: null, avatar_file_id: null, avatar_version: 0 };
    return {
      user_id: uid,
      email: info.email,
      display_name: info.display_name,
      avatar_url: info.avatar_file_id ? `/api/v1/profile/avatar/${uid}?v=${info.avatar_version}` : null,
      avatar_version: info.avatar_version,
      role: roleByUid[uid] || 'removed',
      income_total: stats[uid].income,
      expense_total: stats[uid].expense,
      tx_count: stats[uid].tx_count,
    };
  });

  // 排序：支出降序、收入降序、笔数降序、user_id 兜底
  items.sort((a, b) => b.expense_total - a.expense_total || b.income_total - a.income_total || b.tx_count - a.tx_count || a.user_id.localeCompare(b.user_id));

  return c.json({
    ledger_id: ledgerExternalId,
    ledger_currency: ledger.currency || 'CNY',
    scope,
    period: normalizedPeriod,
    start_at: startAt,
    end_at: endAt,
    items,
  });
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
    // 对齐上游:非成员 404(不泄露账本存在性)
    return c.json({ error: 'Ledger not found' }, 404);
  }

  const ownerId = ledger.user_id;

  const ownerCategories = await db
    .prepare(
      `SELECT DISTINCT sync_id, name, kind, level, sort_order, icon, icon_type,
              icon_cloud_file_id, icon_cloud_sha256, parent_name, parent_sync_id
       FROM user_category_projection
       WHERE user_id = ? AND sync_id IS NOT NULL AND sync_id != ''
       ORDER BY kind, sort_order IS NULL, sort_order, LOWER(name) ASC`
    )
    .bind(ownerId)
    .all<{ sync_id: string; name: string | null; kind: string | null; level: number | null; sort_order: number | null; icon: string | null; icon_type: string | null; icon_cloud_file_id: string | null; icon_cloud_sha256: string | null; parent_name: string | null; parent_sync_id: string | null }>();

  const ownerAccounts = await db
    .prepare(
      `SELECT DISTINCT sync_id, name, account_type, currency, initial_balance, note,
              credit_limit, billing_day, payment_due_day, bank_name, card_last_four
       FROM user_account_projection
       WHERE user_id = ? AND sync_id IS NOT NULL AND sync_id != ''
       ORDER BY LOWER(name) ASC`
    )
    .bind(ownerId)
    .all<{ sync_id: string; name: string | null; account_type: string | null; currency: string | null; initial_balance: number | null; note: string | null; credit_limit: number | null; billing_day: number | null; payment_due_day: number | null; bank_name: string | null; card_last_four: string | null }>();

  const ownerTags = await db
    .prepare(
      `SELECT DISTINCT sync_id, name, color
       FROM user_tag_projection
       WHERE user_id = ? AND sync_id IS NOT NULL AND sync_id != ''
       ORDER BY LOWER(name) ASC`
    )
    .bind(ownerId)
    .all<{ sync_id: string; name: string | null; color: string | null }>();

  return c.json({
    owner_user_id: ownerId,
    categories: ownerCategories.results.map((cat) => ({
      sync_id: cat.sync_id,
      name: cat.name,
      kind: cat.kind,
      level: cat.level,
      sort_order: cat.sort_order,
      icon: cat.icon,
      icon_type: cat.icon_type,
      icon_cloud_file_id: cat.icon_cloud_file_id,
      icon_cloud_sha256: cat.icon_cloud_sha256,
      parent_name: cat.parent_name,
      parent_sync_id: cat.parent_sync_id,
    })),
    accounts: ownerAccounts.results.map((acct) => ({
      sync_id: acct.sync_id,
      name: acct.name,
      account_type: acct.account_type,
      currency: acct.currency,
      initial_balance: acct.initial_balance ?? 0,
      note: acct.note,
      credit_limit: acct.credit_limit,
      billing_day: acct.billing_day,
      payment_due_day: acct.payment_due_day,
      bank_name: acct.bank_name,
      card_last_four: acct.card_last_four,
    })),
    tags: ownerTags.results.map((tag) => ({
      sync_id: tag.sync_id,
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
    .prepare('SELECT user_id, role FROM ledger_members WHERE ledger_id = ? AND user_id = ?')
    .bind(ledger.id, req.target_user_id)
    .first<{ user_id: string; role: string }>();

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
    .prepare('SELECT user_id FROM ledger_members WHERE ledger_id = ? AND user_id = ?')
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
  const ledgerId = c.req.query('ledger_id') ?? null;
  const filterUserId = c.req.query('user_id') ?? null;
  const tzOffsetMinutes = parseInt(c.req.query('tz_offset_minutes') ?? '0', 10);

  // 含共享账本
  const ledgers = await db
    .prepare(`SELECT DISTINCT l.id, l.external_id, l.currency FROM ledgers l
      LEFT JOIN ledger_members lm ON l.id = lm.ledger_id AND lm.user_id = ?
      WHERE (l.user_id = ? OR lm.user_id = ?)
        AND NOT EXISTS (
          SELECT 1 FROM sync_changes sc
          WHERE sc.ledger_id = l.id AND sc.entity_type = 'ledger_snapshot'
            AND sc.action = 'delete'
            AND sc.change_id = (SELECT MAX(sc2.change_id) FROM sync_changes sc2
                                WHERE sc2.ledger_id = l.id AND sc2.entity_type = 'ledger_snapshot')
        )${ledgerId ? ' AND (l.external_id = ? OR l.id = ?)' : ''}`)
    .bind(userId, userId, userId, ...(ledgerId ? [ledgerId, ledgerId] : []))
    .all<{ id: string; external_id: string; currency: string }>();

  if (ledgers.results.length === 0) {
    return c.json({ series: [], multi_currency: false });
  }

  const ledgerInternalIds = ledgers.results.map(l => l.id);
  const placeholders = ledgerInternalIds.map(() => '?').join(',');

  // 获取所有账户（含 hidden 和 account_type）
  const targetUserId = filterUserId || userId;
  const accounts = await db
    .prepare(`SELECT sync_id, initial_balance, currency, account_type, hidden FROM user_account_projection WHERE user_id = ?`)
    .bind(targetUserId)
    .all<{ sync_id: string; initial_balance: number; currency: string | null; account_type: string | null; hidden: number | null }>();

  // 获取所有交易（按 happened_at 排序，与原版对齐）
  const txs = await db
    .prepare(`SELECT happened_at, tx_type, amount, COALESCE(native_amount, amount) as effective_amount, account_sync_id, from_account_sync_id, to_account_sync_id FROM read_tx_projection WHERE ledger_id IN (${placeholders}) ORDER BY happened_at ASC`)
    .bind(...ledgerInternalIds)
    .all<{ happened_at: string; tx_type: string; amount: number; effective_amount: number; account_sync_id: string | null; from_account_sync_id: string | null; to_account_sync_id: string | null }>();

  // 获取 primary_currency
  const profile = await db.prepare('SELECT primary_currency FROM user_profiles WHERE user_id = ?').bind(userId).first<{ primary_currency: string | null }>();
  let baseCurrency = (profile?.primary_currency || '').toUpperCase();

  // 检查是否多币种
  const currencies = new Set(accounts.results.map(a => (a.currency || 'CNY').toUpperCase()).filter(Boolean));
  const multiCurrency = currencies.size > 1;

  if (!baseCurrency && currencies.size === 1) {
    baseCurrency = [...currencies][0];
  }

  // 构建汇率折算表（与原版一致：base 自身 1.0；自动缓存取倒数；手动 override 覆盖自动）
  const ratesToBase: Record<string, number> = {};
  if (baseCurrency) {
    ratesToBase[baseCurrency] = 1.0;
    // 自动汇率缓存（1 base = x quote，取倒数得 1 quote = x base）
    const cache = await db.prepare('SELECT payload_json FROM exchange_rate_cache WHERE base_currency = ?').bind(baseCurrency).first<{ payload_json: string }>();
    if (cache) {
      try {
        const payload = JSON.parse(cache.payload_json) as Record<string, string>;
        for (const [q, x] of Object.entries(payload)) {
          const xf = parseFloat(x);
          if (xf > 0) ratesToBase[q.toUpperCase()] = 1.0 / xf;
        }
      } catch {}
    }
    // 手动汇率覆盖
    const overrides = await db.prepare('SELECT quote_currency, rate FROM user_exchange_rate_projection WHERE user_id = ? AND base_currency = ?').bind(userId, baseCurrency).all<{ quote_currency: string; rate: string }>();
    for (const ov of overrides.results) {
      const r = parseFloat(ov.rate);
      if (r > 0) ratesToBase[(ov.quote_currency || '').toUpperCase()] = r;
    }
  }

  // 区分负债账户（credit_card, loan）— 与原版对齐
  const LIABILITY_TYPES = new Set(['credit_card', 'loan', 'liability']);
  const accountBalances: Record<string, number> = {};
  const accountCurrency: Record<string, string> = {};
  let totalAssets = 0;
  let totalLiabilities = 0;

  for (const acc of accounts.results) {
    const cur = (acc.currency || 'CNY').toUpperCase();
    const rate = ratesToBase[cur];
    // 缺汇率的币种整条剔除（与原版一致）
    if (baseCurrency && !rate) continue;
    accountCurrency[acc.sync_id] = cur;
    const bal = (acc.initial_balance ?? 0) * (rate ?? 1);
    accountBalances[acc.sync_id] = bal;
    if (LIABILITY_TYPES.has(acc.account_type || '')) {
      // 信用卡余额为正（溢缴款）→ 计资产而非负债（对齐上游 #128）
      if (acc.account_type === 'credit_card' && bal > 0) {
        totalAssets += bal;
      } else {
        // 带符号累加（负债余额为负）——与上游 liabilities 负值口径一致
        totalLiabilities += bal;
      }
    } else {
      totalAssets += bal;
    }
  }

  // 按时间顺序逐笔处理交易，追踪账户余额变化
  const monthlyChanges: Record<string, { assets: number; liabilities: number }> = {};

  for (const tx of txs.results) {
    const month = tx.happened_at.slice(0, 7); // YYYY-MM
    const amt = tx.amount; // 使用 amount（与原版对齐）

    if (tx.tx_type === 'income' && tx.account_sync_id) {
      const acc = accountCurrency[tx.account_sync_id] ? accounts.results.find(a => a.sync_id === tx.account_sync_id) : null;
      if (acc && !LIABILITY_TYPES.has(acc.account_type || '')) {
        const rate = ratesToBase[accountCurrency[tx.account_sync_id]] ?? 1;
        const convertedAmt = amt * rate;
        if (!monthlyChanges[month]) monthlyChanges[month] = { assets: 0, liabilities: 0 };
        monthlyChanges[month].assets += convertedAmt;
        accountBalances[tx.account_sync_id] = (accountBalances[tx.account_sync_id] ?? 0) + convertedAmt;
      }
    } else if (tx.tx_type === 'expense' && tx.account_sync_id) {
      const acc = accountCurrency[tx.account_sync_id] ? accounts.results.find(a => a.sync_id === tx.account_sync_id) : null;
      if (acc && !LIABILITY_TYPES.has(acc.account_type || '')) {
        const rate = ratesToBase[accountCurrency[tx.account_sync_id]] ?? 1;
        const convertedAmt = amt * rate;
        if (!monthlyChanges[month]) monthlyChanges[month] = { assets: 0, liabilities: 0 };
        monthlyChanges[month].assets -= convertedAmt;
        accountBalances[tx.account_sync_id] = (accountBalances[tx.account_sync_id] ?? 0) - convertedAmt;
      }
    } else if (tx.tx_type === 'transfer') {
      // 转账：from_account 减少，to_account 增加 — 总净值不变但影响账户余额
      // 不影响 assets/liabilities 聚合（与原版一致）
    }
  }

  // 稀疏到稠密填充（缺失月份用上月值）
  const allMonths: string[] = [];
  if (txs.results.length > 0) {
    const firstMonth = txs.results[0].happened_at.slice(0, 7);
    const lastMonth = txs.results[txs.results.length - 1].happened_at.slice(0, 7);
    let [y, m] = firstMonth.split('-').map(Number);
    const [endY, endM] = lastMonth.split('-').map(Number);
    while (y < endY || (y === endY && m <= endM)) {
      allMonths.push(`${y}-${String(m).padStart(2, '0')}`);
      m++;
      if (m > 12) { m = 1; y++; }
    }
  }

  // 构建 series
  let runningAssets = totalAssets;
  let runningLiabilities = totalLiabilities;
  const series = allMonths.map(month => {
    const change = monthlyChanges[month] ?? { assets: 0, liabilities: 0 };
    runningAssets += change.assets;
    runningLiabilities += change.liabilities;
    return {
      bucket: month,
      net_worth: runningAssets + runningLiabilities,
      assets: runningAssets,
      liabilities: runningLiabilities,
    };
  });

  return c.json({ series, multi_currency: multiCurrency });
});

export default workspaceRouter;
