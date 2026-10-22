import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { createRealDb } from './helpers/realsql-db';
import writeRouter from '../src/routes/write';
import readRouter from '../src/routes/read';

// 移植上游 tests/test_budget_usage_exclude_flags.py(设计 D2):
// 预算 used 只按 exclude_from_budget 过滤,不看 exclude_from_stats —— 两标记独立。
let sqlite: DatabaseSync;
let db: D1Database;
let app: Hono<{ Bindings: any; Variables: { userId: string } }>;

const TABLES = `
  CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL);
  CREATE TABLE ledgers (id TEXT PRIMARY KEY, external_id TEXT, user_id TEXT, name TEXT, currency TEXT, month_start_day INTEGER DEFAULT 1);
  CREATE TABLE ledger_members (ledger_id TEXT, user_id TEXT, role TEXT, PRIMARY KEY (ledger_id, user_id));
  CREATE TABLE sync_changes (
    change_id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, ledger_id TEXT, entity_type TEXT,
    entity_sync_id TEXT, action TEXT, payload_json TEXT, updated_at TEXT,
    updated_by_user_id TEXT, updated_by_device_id TEXT, scope TEXT
  );
  CREATE TABLE read_budget_projection (
    ledger_id TEXT, sync_id TEXT, user_id TEXT, budget_type TEXT, category_sync_id TEXT,
    amount REAL, period TEXT, start_day INTEGER, enabled INTEGER DEFAULT 1, source_change_id INTEGER DEFAULT 0,
    PRIMARY KEY (ledger_id, sync_id)
  );
  CREATE TABLE read_tx_projection (
    ledger_id TEXT, sync_id TEXT, user_id TEXT, tx_type TEXT, amount REAL DEFAULT 0,
    happened_at TEXT, category_sync_id TEXT, exclude_from_stats BOOLEAN DEFAULT 0,
    exclude_from_budget BOOLEAN DEFAULT 0, native_amount REAL, PRIMARY KEY (ledger_id, sync_id)
  );
  CREATE TABLE audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, ledger_id TEXT, action TEXT, metadata_json TEXT, created_at TEXT);
`;

const USER = 'user-1';

beforeEach(() => {
  const created = createRealDb();
  sqlite = created.sqlite;
  db = created.db;
  sqlite.exec(TABLES);
  sqlite.prepare("INSERT INTO users (id, email, password_hash) VALUES (?, 'excl@x.com', 'x')").run(USER);
  sqlite.prepare("INSERT INTO ledgers (id, external_id, user_id, name, currency) VALUES ('lg1', 'L1', ?, '账本', 'CNY')").run(USER);
  sqlite.prepare("INSERT INTO ledger_members (ledger_id, user_id, role) VALUES ('lg1', ?, 'owner')").run(USER);

  app = new Hono<{ Bindings: any; Variables: { userId: string } }>();
  app.use('/api/v1/*', async (c, next) => {
    c.set('userId', USER);
    await next();
  });
  app.route('/api/v1/write', writeRouter);
  app.route('/api/v1/read', readRouter);
});

afterEach(() => sqlite.close());

function currentPeriod(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`;
}

describe('预算用量 exclude_from_budget 过滤(移植上游 test_budget_usage_exclude_flags.py)', () => {
  it('exclude_from_budget=True 不计入;exclude_from_stats=True 仍计入 → used=130', async () => {
    // (a) 普通支出 100 —— 计入
    sqlite.prepare(
      `INSERT INTO read_tx_projection (ledger_id, sync_id, user_id, tx_type, amount, happened_at, exclude_from_stats, exclude_from_budget, native_amount)
       VALUES ('lg1', 'tx-normal', ?, 'expense', 100, ?, 0, 0, 100)`
    ).run(USER, `${currentPeriod()}T12:00:00`);
    // (b) exclude_from_budget=True 支出 500 —— 不计入
    sqlite.prepare(
      `INSERT INTO read_tx_projection (ledger_id, sync_id, user_id, tx_type, amount, happened_at, exclude_from_stats, exclude_from_budget, native_amount)
       VALUES ('lg1', 'tx-excl-budget', ?, 'expense', 500, ?, 0, 1, 500)`
    ).run(USER, `${currentPeriod()}T12:00:00`);
    // (c) exclude_from_stats=True 但 exclude_from_budget=False 支出 30 —— 仍计入
    sqlite.prepare(
      `INSERT INTO read_tx_projection (ledger_id, sync_id, user_id, tx_type, amount, happened_at, exclude_from_stats, exclude_from_budget, native_amount)
       VALUES ('lg1', 'tx-excl-stats', ?, 'expense', 30, ?, 1, 0, 30)`
    ).run(USER, `${currentPeriod()}T12:00:00`);

    const create = await app.request('/api/v1/write/ledgers/L1/budgets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base_change_id: 0, type: 'total', amount: 5000, start_day: 1 }),
    }, { DB: db, JWT_SECRET: 'test-secret' } as any);
    expect(create.status).toBe(200);

    const res = await app.request('/api/v1/read/ledgers/L1/budgets/usage', {}, { DB: db, JWT_SECRET: 'test-secret' } as any);
    expect(res.status).toBe(200);
    const body = await res.json() as { items: Array<{ budget_id: string; used: number }> };
    expect(body.items).toHaveLength(1);
    // D2:(b) 排除,(c) 仍计入 → 100 + 30 = 130
    expect(body.items[0].used).toBe(130);
  });
});