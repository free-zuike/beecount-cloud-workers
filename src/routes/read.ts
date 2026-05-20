/**
 * 读路由模块 - 实现 BeeCount Cloud 只读查询接口
 */

import { Hono } from 'hono';
import { z } from 'zod';

function toUtcDate(dt: string | Date): Date {
  const d = typeof dt === 'string' ? new Date(dt) : dt;
  return new Date(d.toISOString());
}

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

function parseTagsCsv(csv: string | null): string[] {
  if (!csv) return [];
  return csv.split(',').filter((t) => t.trim().length > 0);
}

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

interface ReadLedgerDetailOut extends ReadLedgerOut {
  source_change_id: number;
}

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

type Bindings = {
  DB: D1Database;
  JWT_SECRET: string;
};

type Variables = {
  userId: string;
};

const readRouter = new Hono<{ Bindings: Bindings; Variables: Variables }>();

readRouter.use('*', async (c, next) => {
  try {
    await next();
  } catch (error) {
    console.error('[READ] Error:', error);
    
    if (error instanceof Error && error.message.includes('no such table')) {
      return c.json([]);
    }
    
    return c.json({ error: 'Internal server error' }, 500);
  }
});

readRouter.get('/ledgers', async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const now = nowUtc();

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

  const result: ReadLedgerOut[] = [];

  for (const ledger of ledgers.results) {
    let tombstone = null;
    try {
      tombstone = await db
        .prepare(
          `SELECT action FROM sync_changes
           WHERE ledger_id = ? AND entity_type = 'ledger_snapshot' AND action = 'delete'
           ORDER BY change_id DESC LIMIT 1`
        )
        .bind(ledger.id)
        .first<{ action: string }>();
    } catch {}

    if (tombstone?.action === 'delete') {
      continue;
    }

    let totals = null;
    try {
      totals = await db
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
    } catch {}

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

  return c.json(result);
});

readRouter.get('/ledgers/:ledgerExternalId', async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const ledgerExternalId = c.req.param('ledgerExternalId');
  const now = nowUtc();

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

  let tombstone = null;
  try {
    tombstone = await db
      .prepare(
        `SELECT action FROM sync_changes
         WHERE ledger_id = ? AND entity_type = 'ledger_snapshot' AND action = 'delete'
         ORDER BY change_id DESC LIMIT 1`
      )
      .bind(ledger.id)
      .first<{ action: string }>();
  } catch {}

  if (tombstone?.action === 'delete') {
    return c.json({ error: 'Ledger not found' }, 404);
  }

  let latestChangeId = null;
  try {
    latestChangeId = await db
      .prepare('SELECT MAX(change_id) as max_id FROM sync_changes WHERE ledger_id = ?')
      .bind(ledger.id)
      .first<{ max_id: number | null }>();
  } catch {}

  let totals = null;
  try {
    totals = await db
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
  } catch {}

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

readRouter.get('/ledgers/:ledgerExternalId/stats', async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const ledgerExternalId = c.req.param('ledgerExternalId');

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

  const response: LedgerStats = {
    transaction_count: 0,
    transaction_total: 0,
    attachment_count: 0,
    attachment_total: 0,
    category_attachment_total: 0,
    budget_count: 0,
    budget_total: 0,
    account_count: 0,
    account_total: 0,
    category_count: 0,
    category_total: 0,
    tag_count: 0,
    tag_total: 0,
  };

  return c.json(response);
});

readRouter.get('/ledgers/:ledgerExternalId/transactions', async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const ledgerExternalId = c.req.param('ledgerExternalId');

  const txType = c.req.query('tx_type') ?? null;
  const q = c.req.query('q') ?? null;
  const startAt = c.req.query('start_at') ?? null;
  const endAt = c.req.query('end_at') ?? null;
  const limit = Math.min(parseInt(c.req.query('limit') ?? '20', 10), 2000);
  const offset = parseInt(c.req.query('offset') ?? '0', 10);

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

  const rows = await db
    .prepare(
      `SELECT * FROM read_tx_projection
       WHERE ledger_id = ?
       ORDER BY happened_at DESC, tx_index DESC
       LIMIT ? OFFSET ?`
    )
    .bind(ledger.id, limit, offset)
    .all<Record<string, unknown>>();

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
  } catch {}

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

  return c.json(result);
});

readRouter.get('/ledgers/:ledgerExternalId/accounts', async (c) => {
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

  let latestChangeId = null;
  try {
    latestChangeId = await db
      .prepare('SELECT MAX(change_id) as max_id FROM sync_changes WHERE ledger_id = ?')
      .bind(ledger.id)
      .first<{ max_id: number | null }>();
  } catch {}

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

  let latestChangeId = null;
  try {
    latestChangeId = await db
      .prepare('SELECT MAX(change_id) as max_id FROM sync_changes WHERE ledger_id = ?')
      .bind(ledger.id)
      .first<{ max_id: number | null }>();
  } catch {}

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

  let latestChangeId = null;
  try {
    latestChangeId = await db
      .prepare('SELECT MAX(change_id) as max_id FROM sync_changes WHERE ledger_id = ?')
      .bind(ledger.id)
      .first<{ max_id: number | null }>();
  } catch {}

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

  let latestChangeId = null;
  try {
    latestChangeId = await db
      .prepare('SELECT MAX(change_id) as max_id FROM sync_changes WHERE ledger_id = ?')
      .bind(ledger.id)
      .first<{ max_id: number | null }>();
  } catch {}

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

  const rows = await db
    .prepare(
      `SELECT * FROM read_budget_projection
       WHERE ledger_id = ?
       ORDER BY budget_type, category_sync_id`
    )
    .bind(ledger.id)
    .all<Record<string, unknown>>();

  const dedup: Record<string, Record<string, unknown>> = {};
  for (const b of rows.results) {
    const btype = (b.budget_type as string) || 'total';
    if (btype === 'category' && !b.category_sync_id) {
      continue;
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

readRouter.get('/debug/ledgers', async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;

  const ledgers = await db
    .prepare('SELECT * FROM ledgers WHERE user_id = ?')
    .bind(userId)
    .all();

  const results = [];
  for (const ledger of ledgers.results) {
    let tombstone = null;
    try {
      tombstone = await db
        .prepare(
          `SELECT action FROM sync_changes
           WHERE ledger_id = ? AND entity_type = 'ledger_snapshot' AND action = 'delete'
           ORDER BY change_id DESC LIMIT 1`
        )
        .bind(ledger.id)
        .first<{ action: string }>();
    } catch {}

    results.push({
      ...ledger,
      is_soft_deleted: !!tombstone?.action
    });
  }

  return c.json({ ledgers: results });
});

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
