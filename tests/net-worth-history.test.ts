import { describe, it, expect, beforeAll } from 'vitest';
import { Hono } from 'hono';
import { createRealDb } from './helpers/realsql-db';
import workspaceRouter from '../src/routes/workspace';
import { createAccessToken } from '../src/auth';

// 对齐上游 tests/test_net_worth_history.py（#128 信用卡溢缴款计资产）。
// liabilities 与上游同为负值约定（带符号累加，net_worth = assets + liabilities），
// 前端 NetWorthTrend 直接画原始值无符号假设。
const TABLES = `
  CREATE TABLE users (
    id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
    is_admin INTEGER DEFAULT 0, is_enabled INTEGER DEFAULT 1,
    totp_enabled INTEGER DEFAULT 0, totp_secret_encrypted TEXT, created_at TEXT
  );
  CREATE TABLE ledgers (
    id TEXT PRIMARY KEY, external_id TEXT, user_id TEXT, name TEXT, currency TEXT, created_at TEXT
  );
  CREATE TABLE ledger_members (
    ledger_id TEXT, user_id TEXT, role TEXT, PRIMARY KEY (ledger_id, user_id)
  );
  CREATE TABLE user_account_projection (
    sync_id TEXT NOT NULL, user_id TEXT NOT NULL, name TEXT, account_type TEXT,
    initial_balance REAL DEFAULT 0, currency TEXT, hidden INTEGER DEFAULT 0,
    PRIMARY KEY (sync_id, user_id)
  );
  CREATE TABLE read_tx_projection (
    ledger_id TEXT, sync_id TEXT, user_id TEXT, tx_type TEXT, amount REAL DEFAULT 0,
    happened_at TEXT, note TEXT, category_sync_id TEXT, category_name TEXT,
    account_sync_id TEXT, from_account_sync_id TEXT, to_account_sync_id TEXT,
    native_amount REAL, attachments_json TEXT, PRIMARY KEY (ledger_id, sync_id)
  );
  CREATE TABLE user_profiles (
    user_id TEXT PRIMARY KEY, primary_currency TEXT, display_name TEXT
  );
  CREATE TABLE exchange_rate_cache (
    base_currency TEXT, payload_json TEXT
  );
  CREATE TABLE user_exchange_rate_projection (
    user_id TEXT, sync_id TEXT, base_currency TEXT, quote_currency TEXT, rate TEXT,
    PRIMARY KEY (user_id, sync_id)
  );
  CREATE TABLE sync_changes (
    change_id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, ledger_id TEXT, entity_type TEXT,
    entity_sync_id TEXT, action TEXT, payload_json TEXT, updated_at TEXT,
    updated_by_user_id TEXT, updated_by_device_id TEXT, scope TEXT
  );
`;

const SECRET = 'test-secret';

function buildApp(db: D1Database) {
  const app = new Hono<{ Bindings: { DB: D1Database; JWT_SECRET: string } }>();
  app.use('/read/*', async (c, next) => {
    const auth = c.req.header('Authorization');
    if (!auth?.startsWith('Bearer ')) return c.json({ error: 'Unauthorized' }, 401);
    const token = auth.slice(7);
    try {
      const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
      c.set('userId' as never, payload.sub as string);
    } catch {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    return next();
  });
  app.route('/read/workspace', workspaceRouter);
  return app;
}

async function fetchNetWorth(app: Hono<any>, db: D1Database, token: string) {
  return app.request('/read/workspace/net-worth-history?scope=all', {
    headers: { Authorization: `Bearer ${token}` },
  }, { DB: db, JWT_SECRET: SECRET } as any);
}

describe('net-worth-history 口径（对齐上游 #128）', () => {
  it('信用卡溢缴款计资产、欠款计负债、loan 仍计负债', async () => {
    const { sqlite, db } = createRealDb();
    sqlite.exec(TABLES);
    sqlite.exec(`
      INSERT INTO users (id, email, password_hash, is_admin, is_enabled, created_at)
      VALUES ('u1', 'nwh@x.com', 'x', 0, 1, '2026-01-01T00:00:00Z');
      INSERT INTO ledgers (id, external_id, user_id, name, currency, created_at)
      VALUES ('lg1', 'lg1', 'u1', '个人账本', 'CNY', '2026-01-01T00:00:00Z');
      INSERT INTO user_account_projection (sync_id, user_id, name, account_type, initial_balance, currency)
      VALUES ('acc-bank', 'u1', '银行', 'bank_card', 10000, 'CNY'),
             ('acc-owed', 'u1', '欠款卡', 'credit_card', -1000, 'CNY'),
             ('acc-over', 'u1', '溢缴卡', 'credit_card', 200, 'CNY'),
             ('acc-loan', 'u1', '贷款', 'loan', -500, 'CNY');
      INSERT INTO user_profiles (user_id, primary_currency) VALUES ('u1', 'CNY');
      INSERT INTO read_tx_projection (ledger_id, sync_id, user_id, tx_type, amount, happened_at, account_sync_id)
      VALUES ('lg1', 'tx-1', 'u1', 'income', 0, '2026-03-15T00:00:00Z', 'acc-bank');
    `);
    const token = await createAccessToken('u1', SECRET, ['app_write']);
    const app = buildApp(db);
    const res = await fetchNetWorth(app, db, token);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      series?: Array<{ bucket: string; net_worth: number; assets: number; liabilities: number }>;
      multi_currency?: boolean;
    };
    const last = body.series?.[body.series.length - 1];
    expect(last).toBeDefined();
    // assets = 10000(银行) + 200(溢缴) = 10200；liabilities = -1000(欠款) + -500(loan) = -1500
    expect(last!.assets).toBe(10200);
    expect(last!.liabilities).toBe(-1500);
    expect(last!.net_worth).toBe(10200 - 1500);
  });

  it('空账本返回空序列', async () => {
    const { sqlite, db } = createRealDb();
    sqlite.exec(TABLES);
    sqlite.exec(`
      INSERT INTO users (id, email, password_hash, is_admin, is_enabled, created_at)
      VALUES ('u2', 'nwh-empty@x.com', 'x', 0, 1, '2026-01-01T00:00:00Z');
    `);
    const token = await createAccessToken('u2', SECRET, ['app_write']);
    const app = buildApp(db);
    const res = await fetchNetWorth(app, db, token);
    expect(res.status).toBe(200);
    const body = await res.json() as { series: unknown[] };
    expect(body.series).toEqual([]);
  });
});