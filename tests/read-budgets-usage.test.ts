import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { createRealDb } from './helpers/realsql-db';
import readRouter from '../src/routes/read';
import { createAccessToken } from '../src/auth';

// read.ts list_budgets_usage 对齐原版 ledgers.py 后的回归测试:
// (budget_type, category_sync_id) 维度去重(sync_id 字典序最大胜出)、category 预算缺分类跳过、
// 负数用量 abs(原版 used=abs(used))。
const TABLES = `
  CREATE TABLE users (
    id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
    is_enabled INTEGER DEFAULT 1, is_admin INTEGER DEFAULT 0
  );
  CREATE TABLE ledgers (
    id TEXT PRIMARY KEY, external_id TEXT, user_id TEXT, name TEXT, currency TEXT,
    month_start_day INTEGER DEFAULT 1
  );
  CREATE TABLE ledger_members (
    ledger_id TEXT, user_id TEXT, role TEXT, PRIMARY KEY (ledger_id, user_id)
  );
  CREATE TABLE user_category_projection (
    sync_id TEXT NOT NULL, user_id TEXT NOT NULL, name TEXT, kind TEXT,
    parent_sync_id TEXT, PRIMARY KEY (user_id, sync_id)
  );
  CREATE TABLE read_budget_projection (
    ledger_id TEXT NOT NULL, sync_id TEXT NOT NULL, user_id TEXT NOT NULL,
    budget_type TEXT, category_sync_id TEXT, amount REAL, period TEXT,
    enabled BOOLEAN DEFAULT 1, PRIMARY KEY (ledger_id, sync_id)
  );
  CREATE TABLE read_tx_projection (
    ledger_id TEXT, sync_id TEXT, user_id TEXT, tx_type TEXT, amount REAL DEFAULT 0,
    happened_at TEXT, note TEXT, category_sync_id TEXT, category_name TEXT,
    account_sync_id TEXT, from_account_sync_id TEXT, to_account_sync_id TEXT,
    exclude_from_stats BOOLEAN DEFAULT 0, exclude_from_budget BOOLEAN DEFAULT 0,
    native_amount REAL, PRIMARY KEY (ledger_id, sync_id)
  );
`;

const SECRET = 'test-secret';

function buildApp(db: D1Database) {
  const app = new Hono<{ Bindings: { DB: D1Database; JWT_SECRET: string } }>();
  app.use('/read/*', async (c, next) => {
    const auth = c.req.header('Authorization');
    if (!auth?.startsWith('Bearer ')) return c.json({ error: 'Unauthorized' }, 401);
    try {
      const payload = JSON.parse(Buffer.from(auth.slice(7).split('.')[1], 'base64url').toString());
      c.set('userId' as never, payload.sub as string);
    } catch {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    return next();
  });
  app.route('/read', readRouter);
  return app;
}

async function fetchUsage(app: Hono<any>, db: D1Database, token: string, ledgerExtId = 'lg1') {
  const res = await app.request(`/read/ledgers/${ledgerExtId}/budgets/usage`, {
    headers: { Authorization: `Bearer ${token}` },
  }, { DB: db, JWT_SECRET: SECRET } as any);
  return res.json() as Promise<{ items: Array<{ budget_id: string; used: number }> }>;
}

describe('read/ledgers/:id/budgets/usage(对齐原版 dedup + abs)', () => {
  it('同 (budget_type, category_sync_id) 预算去重,sync_id 字典序最大胜出;缺分类的 category 预算跳过', async () => {
    const { sqlite, db } = createRealDb();
    sqlite.exec(TABLES);
    sqlite.exec(`
      INSERT INTO users (id, email, password_hash, is_enabled) VALUES ('u1', 'bud@x.com', 'x', 1);
      INSERT INTO ledgers (id, external_id, user_id, name) VALUES ('lg1', 'lg1', 'u1', '账本');
      INSERT INTO read_budget_projection (ledger_id, sync_id, user_id, budget_type, category_sync_id, amount)
      VALUES
        ('lg1', 'bud-1', 'u1', 'category', 'cat-a', 100),  -- sync 小,被 bud-2 顶掉
        ('lg1', 'bud-2', 'u1', 'category', 'cat-a', 200),  -- 胜出
        ('lg1', 'bud-3', 'u1', 'total',    NULL,   500),
        ('lg1', 'bud-4', 'u1', 'category', NULL,   300);   -- category 预算缺分类 → 跳过
    `);
    const app = buildApp(db);
    const token = await createAccessToken('u1', SECRET, ['app_write']);
    const { items } = await fetchUsage(app, db, token);

    const ids = items.map((i) => i.budget_id).sort();
    expect(ids).toEqual(['bud-2', 'bud-3']);
  });

  it('负数用量取 abs(原版 used=abs(used));total 预算汇总全部 expense', async () => {
    const { sqlite, db } = createRealDb();
    sqlite.exec(TABLES);
    sqlite.exec(`
      INSERT INTO users (id, email, password_hash, is_enabled) VALUES ('u1', 'abs@x.com', 'x', 1);
      INSERT INTO ledgers (id, external_id, user_id, name) VALUES ('lg1', 'lg1', 'u1', '账本');
      INSERT INTO read_budget_projection (ledger_id, sync_id, user_id, budget_type, category_sync_id, amount)
      VALUES ('lg1', 'bud-1', 'u1', 'total', NULL, 500);
      -- 当月(2026-10)内 expense:一笔正 40、一笔负 -10 → SUM=30
      INSERT INTO read_tx_projection (ledger_id, sync_id, user_id, tx_type, amount, happened_at, category_sync_id)
      VALUES
        ('lg1', 't1', 'u1', 'expense', 40, '2026-10-05T00:00:00Z', 'cat-a'),
        ('lg1', 't2', 'u1', 'expense', -10, '2026-10-06T00:00:00Z', 'cat-b'),
        ('lg1', 't3', 'u1', 'expense', 99, '2026-09-30T00:00:00Z', 'cat-a');
    `);
    const app = buildApp(db);
    const token = await createAccessToken('u1', SECRET, ['app_write']);
    const { items } = await fetchUsage(app, db, token);

    expect(items).toHaveLength(1);
    expect(items[0].budget_id).toBe('bud-1');
    expect(items[0].used).toBe(30); // 40 + (-10),abs 后仍正;9 月那笔不在当月周期内
  });
});