import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { Hono } from 'hono';
import syncRouter from '../../src/routes/sync';

// 真实 SQLite 验证 full snapshot items 契约（对齐上游 snapshot_builder.py）：
// items 必须是 camelCase 同步实体格式（syncId/type/amount/...），且像上游
// 07c4093 一样恒带 excludeFromStats/excludeFromBudget——否则 App 全量同步后
// 交易统计/预算标记丢失（apply 缺省重置为 false）。
let sqlite: DatabaseSync;
let db: D1Database;
let app: Hono<{ Bindings: { DB: D1Database }; Variables: { userId: string } }>;

beforeEach(async () => {
  sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL);
    CREATE TABLE ledgers (id TEXT PRIMARY KEY, user_id TEXT, external_id TEXT, name TEXT, currency TEXT, month_start_day INTEGER DEFAULT 1);
    CREATE TABLE ledger_members (ledger_id TEXT, user_id TEXT, role TEXT, joined_at TEXT);
    CREATE TABLE devices (id TEXT PRIMARY KEY, user_id TEXT, name TEXT, platform TEXT, last_seen_at TEXT, last_ip TEXT, revoked_at TEXT, created_at TEXT);
    CREATE TABLE sync_changes (
      change_id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, ledger_id TEXT, entity_type TEXT,
      entity_sync_id TEXT, action TEXT, payload_json TEXT, updated_at TEXT,
      updated_by_user_id TEXT, updated_by_device_id TEXT, scope TEXT
    );
    CREATE TABLE read_tx_projection (
      ledger_id TEXT NOT NULL, sync_id TEXT NOT NULL, user_id TEXT NOT NULL, tx_type TEXT NOT NULL, amount REAL DEFAULT 0,
      happened_at TEXT NOT NULL, note TEXT,
      category_sync_id TEXT, category_name TEXT, category_kind TEXT,
      account_sync_id TEXT, account_name TEXT,
      from_account_sync_id TEXT, from_account_name TEXT,
      to_account_sync_id TEXT, to_account_name TEXT,
      tags_csv TEXT, tag_sync_ids_json TEXT, attachments_json TEXT, tx_index INTEGER DEFAULT 0,
      created_by_user_id TEXT, last_edited_by_user_id TEXT, source_change_id INTEGER DEFAULT 0,
      exclude_from_stats BOOLEAN DEFAULT 0, exclude_from_budget BOOLEAN DEFAULT 0,
      currency_code TEXT, native_amount REAL,
      PRIMARY KEY (ledger_id, sync_id)
    );
    CREATE TABLE user_account_projection (sync_id TEXT PRIMARY KEY, user_id TEXT, name TEXT, account_type TEXT, currency TEXT);
    CREATE TABLE user_category_projection (sync_id TEXT PRIMARY KEY, user_id TEXT, name TEXT, kind TEXT, level INTEGER);
    CREATE TABLE user_tag_projection (sync_id TEXT PRIMARY KEY, user_id TEXT, name TEXT, color TEXT, source_change_id INTEGER);
    CREATE TABLE read_budget_projection (ledger_id TEXT, sync_id TEXT, user_id TEXT, budget_type TEXT, amount REAL, period TEXT, start_day INTEGER, enabled INTEGER DEFAULT 1);
    CREATE TABLE audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, ledger_id TEXT, action TEXT, metadata_json TEXT, created_at TEXT);
  `);

  db = {
    prepare(sql: string) {
      const statement = sqlite.prepare(sql);
      let params: SQLInputValue[] = [];
      return {
        bind(...values: SQLInputValue[]) { params = values; return this; },
        async run() {
          const r = statement.run(...params);
          return { meta: { last_row_id: Number(r.lastInsertRowid), changes: r.changes } };
        },
        async first<T = unknown>() {
          const row = statement.get(...params) as T | undefined;
          return row ?? null;
        },
        async all<T = unknown>() {
          return { results: statement.all(...params) as T[] };
        },
      };
    },
    async batch(stmts: { run(): Promise<unknown> }[]) {
      sqlite.exec('BEGIN');
      try {
        const out = [];
        for (const s of stmts) out.push(await s.run());
        sqlite.exec('COMMIT');
        return out;
      } catch (e) {
        sqlite.exec('ROLLBACK');
        throw e;
      }
    },
  } as unknown as D1Database;

  await db.prepare('INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)')
    .bind('user-1', 'full@example.com', 'x').run();
  await db.prepare('INSERT INTO ledgers (id, user_id, external_id, name, currency, month_start_day) VALUES (?, ?, ?, ?, ?, ?)')
    .bind('ledger-1', 'user-1', 'ledger-1', 'Full Ledger', 'CNY', 1).run();
  await db.prepare('INSERT INTO ledger_members (ledger_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)')
    .bind('ledger-1', 'user-1', 'owner', new Date().toISOString()).run();
  await db.prepare('INSERT INTO user_account_projection (sync_id, user_id, name, account_type, currency) VALUES (?, ?, ?, ?, ?)')
    .bind('acc-1', 'user-1', '现金', 'cash', 'CNY').run();
  await db.prepare('INSERT INTO user_category_projection (sync_id, user_id, name, kind, level) VALUES (?, ?, ?, ?, ?)')
    .bind('cat-1', 'user-1', '餐饮', 'expense', 1).run();
  await db.prepare('INSERT INTO user_tag_projection (sync_id, user_id, name) VALUES (?, ?, ?)')
    .bind('tag-1', 'user-1', '旅行').run();

  app = new Hono<{ Bindings: { DB: D1Database }; Variables: { userId: string } }>();
  app.use('*', async (c, next) => {
    c.set('userId', 'user-1');
    await next();
  });
  app.route('/api/v1/sync', syncRouter);
});

afterEach(() => sqlite.close());

async function seedTx(row: Record<string, unknown>) {
  const cols = Object.keys(row);
  await db.prepare(
    `INSERT INTO read_tx_projection (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
  ).bind(...cols.map((k) => row[k] as SQLInputValue)).run();
}

describe('full snapshot items 契约（真实 SQLite，对齐上游 07c4093）', () => {
  it('items 输出 camelCase 同步实体字段并恒带 exclude 标记', async () => {
    await seedTx({
      ledger_id: 'ledger-1', sync_id: 'tx-a', user_id: 'user-1', tx_type: 'expense',
      amount: 88.5, happened_at: '2025-01-15T10:00:00.000Z', note: '午餐',
      category_sync_id: 'cat-1', category_name: '餐饮', category_kind: 'expense',
      account_sync_id: 'acc-1', account_name: '现金',
      tags_csv: '旅行', tag_sync_ids_json: '["tag-1"]', tx_index: 1,
      created_by_user_id: 'user-1', exclude_from_stats: 1, exclude_from_budget: 0,
      currency_code: 'CNY', native_amount: 88.5,
    });
    await seedTx({
      ledger_id: 'ledger-1', sync_id: 'tx-b', user_id: 'user-1', tx_type: 'income',
      amount: 200, happened_at: '2025-01-16T09:00:00.000Z',
      exclude_from_stats: 0, exclude_from_budget: 1, currency_code: 'USD', native_amount: 1440,
    });

    const res = await app.request('/api/v1/sync/full?ledger_id=ledger-1', {}, { DB: db });
    expect(res.status).toBe(200);
    const body = await res.json() as { snapshot: { payload: { content: string } } };
    const content = JSON.parse(body.snapshot.payload.content) as {
      count: number;
      items: Array<Record<string, unknown>>;
    };

    expect(content.count).toBe(2);
    const [a, b] = content.items;

    // camelCase 同步实体契约（App 端读取的键名）
    expect(a.syncId).toBe('tx-a');
    expect(a).toMatchObject({
      type: 'expense', amount: 88.5, note: '午餐',
      categoryId: 'cat-1', categoryName: '餐饮', categoryKind: 'expense',
      accountId: 'acc-1', accountName: '现金',
      tags: '旅行', tagIds: ['tag-1'], txIndex: 1, createdByUserId: 'user-1',
      currencyCode: 'CNY', nativeAmount: 88.5,
      excludeFromStats: true, excludeFromBudget: false,
    });
    // 不含 snake_case 投影键（契约纯净）
    expect(a).not.toHaveProperty('sync_id');
    expect(a).not.toHaveProperty('exclude_from_stats');

    // 07c4093 语义：标记随全量快照保留，两行各自独立
    expect(b.excludeFromStats).toBe(false);
    expect(b.excludeFromBudget).toBe(true);
    expect(b.currencyCode).toBe('USD');
  });
});