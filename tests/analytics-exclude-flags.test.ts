import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import workspaceRouter from '../src/routes/workspace';

// 移植上游 tests/test_analytics_exclude_flags.py:
// exclude_from_stats=True 的交易不计入 income/expense 汇总(summary + 分类排行)。
let sqlite: DatabaseSync;
let db: D1Database;
let app: Hono<{ Bindings: { DB: D1Database }; Variables: { userId: string } }>;

function setup() {
  sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL);
    CREATE TABLE ledgers (id TEXT PRIMARY KEY, user_id TEXT, external_id TEXT, name TEXT, currency TEXT, month_start_day INTEGER DEFAULT 1, created_at TEXT);
    CREATE TABLE ledger_members (ledger_id TEXT, user_id TEXT, role TEXT, joined_at TEXT);
    CREATE TABLE sync_changes (
      change_id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, ledger_id TEXT, entity_type TEXT,
      entity_sync_id TEXT, action TEXT, payload_json TEXT, updated_at TEXT,
      updated_by_user_id TEXT, updated_by_device_id TEXT, scope TEXT DEFAULT 'ledger'
    );
    CREATE TABLE read_tx_projection (
      ledger_id TEXT, sync_id TEXT, user_id TEXT, tx_type TEXT, amount REAL, happened_at TEXT, note TEXT,
      category_sync_id TEXT, category_name TEXT, category_kind TEXT,
      account_sync_id TEXT, account_name TEXT,
      from_account_sync_id TEXT, from_account_name TEXT,
      to_account_sync_id TEXT, to_account_name TEXT,
      tags_csv TEXT, tag_sync_ids_json TEXT, attachments_json TEXT, tx_index INTEGER,
      created_by_user_id TEXT, last_edited_by_user_id TEXT, source_change_id INTEGER,
      currency_code TEXT, native_amount REAL,
      exclude_from_stats INTEGER DEFAULT 0, exclude_from_budget INTEGER DEFAULT 0,
      PRIMARY KEY (ledger_id, sync_id)
    );
    CREATE TABLE read_budget_projection (ledger_id TEXT, sync_id TEXT, user_id TEXT, budget_type TEXT, category_sync_id TEXT, amount REAL, period TEXT, start_day INTEGER, enabled INTEGER DEFAULT 1);
    CREATE TABLE user_account_projection (sync_id TEXT PRIMARY KEY, user_id TEXT, name TEXT, account_type TEXT, currency TEXT, initial_balance REAL DEFAULT 0, hidden INTEGER DEFAULT 0);
    CREATE TABLE user_category_projection (sync_id TEXT PRIMARY KEY, user_id TEXT, name TEXT, kind TEXT, level INTEGER);
    CREATE TABLE user_tag_projection (sync_id TEXT PRIMARY KEY, user_id TEXT, name TEXT, color TEXT, source_change_id INTEGER);
  `);
  db = {
    prepare(sql: string) {
      const statement = sqlite.prepare(sql);
      let params: unknown[] = [];
      return {
        bind(...values: unknown[]) { params = values; return this; },
        async run() {
          const r = statement.run(...params as never[]);
          return { meta: { last_row_id: Number(r.lastInsertRowid), changes: r.changes } };
        },
        async first<T = unknown>() {
          const row = statement.get(...params as never[]) as T | undefined;
          return row ?? null;
        },
        async all<T = unknown>() {
          return { results: statement.all(...params as never[]) as T[] };
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

  app = new Hono<{ Bindings: { DB: D1Database }; Variables: { userId: string } }>();
  app.use('*', async (c, next) => {
    c.set('userId', 'user-1');
    await next();
  });
  app.route('/api/v1/read/workspace', workspaceRouter);
}

describe('workspace/analytics 过滤 exclude_from_stats(移植上游 test_analytics_exclude_flags.py)', () => {
  it('标记笔排除汇总:expense_total=100、income_total=0、balance=-100;分类排行同口径', async () => {
    setup();
    sqlite.prepare("INSERT INTO users (id, email, password_hash) VALUES ('user-1', 'a@x.com', 'x')").run();
    sqlite.prepare("INSERT INTO ledgers (id, user_id, external_id, name, currency, created_at) VALUES ('lg1', 'user-1', 'lg1', '个人账本', 'CNY', '2025-01-01T00:00:00Z')").run();
    sqlite.prepare("INSERT INTO ledger_members (ledger_id, user_id, role, joined_at) VALUES ('lg1', 'user-1', 'owner', '2025-01-01T00:00:00Z')").run();

    sqlite.prepare(
      `INSERT INTO read_tx_projection (ledger_id, sync_id, user_id, tx_type, amount, happened_at, category_name, exclude_from_stats)
       VALUES ('lg1', 'tx-normal', 'user-1', 'expense', 100, '2026-06-15T00:00:00+00:00', '餐饮', 0)`
    ).run();
    sqlite.prepare(
      `INSERT INTO read_tx_projection (ledger_id, sync_id, user_id, tx_type, amount, happened_at, category_name, exclude_from_stats)
       VALUES ('lg1', 'tx-excluded', 'user-1', 'expense', 500, '2026-06-16T00:00:00+00:00', '餐饮', 1)`
    ).run();
    sqlite.prepare(
      `INSERT INTO read_tx_projection (ledger_id, sync_id, user_id, tx_type, amount, happened_at, category_name, exclude_from_stats)
       VALUES ('lg1', 'tx-inc-excluded', 'user-1', 'income', 300, '2026-06-17T00:00:00+00:00', '工资', 1)`
    ).run();

    const res = await app.request('/api/v1/read/workspace/analytics?scope=all&metric=expense', {}, { DB: db });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    const summary = body.summary;
    expect(summary.expense_total).toBe(100);
    expect(summary.income_total).toBe(0);
    expect(summary.balance).toBe(-100);

    const ranks = Object.fromEntries((body.category_ranks as any[]).map((r: any) => [r.category_name, r.total]));
    expect(ranks['餐饮']).toBe(100);
  });
});