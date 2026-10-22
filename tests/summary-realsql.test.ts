import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { createRealDb } from './helpers/realsql-db';
import summaryRouter from '../src/routes/summary';
import { createAccessToken } from '../src/auth';

// summary GET / 对齐上游 summary.py + _projection_totals 后新增:
// member 可见性;tx_count/latest 含标记笔;income/expense 排除 exclude_from_stats;
// balance 用全部收支差(native_amount 回退 amount)。
const TABLES = `
  CREATE TABLE users (
    id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
    is_enabled INTEGER DEFAULT 1
  );
  CREATE TABLE ledgers (
    id TEXT PRIMARY KEY, external_id TEXT, user_id TEXT, name TEXT, currency TEXT
  );
  CREATE TABLE ledger_members (
    ledger_id TEXT, user_id TEXT, role TEXT, PRIMARY KEY (ledger_id, user_id)
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
  app.route('/read/summary', summaryRouter);
  return app;
}

async function fetchSummary(app: Hono<any>, db: D1Database, token: string, ledgerExtId: string) {
  const res = await app.request(`/read/summary?ledger_id=${ledgerExtId}`, {
    headers: { Authorization: `Bearer ${token}` },
  }, { DB: db, JWT_SECRET: SECRET } as any);
  return res;
}

describe('read/summary(对齐上游 _projection_totals)', () => {
  it('tx_count 含标记笔、收支排除标记笔、balance 含标记笔;共享账本成员可见', async () => {
    const { sqlite, db } = createRealDb();
    sqlite.exec(TABLES);
    sqlite.exec(`
      INSERT INTO users (id, email, password_hash, is_enabled) VALUES
        ('u1', 'owner@x.com', 'x', 1), ('u2', 'member@x.com', 'x', 1);
      INSERT INTO ledgers (id, external_id, user_id, name, currency)
      VALUES ('lg1', 'lg1', 'u1', '共享账本', 'CNY');
      INSERT INTO ledger_members (ledger_id, user_id, role) VALUES ('lg1', 'u2', 'editor');
      INSERT INTO read_tx_projection (ledger_id, sync_id, user_id, tx_type, amount, happened_at, exclude_from_stats, native_amount)
      VALUES
        ('lg1', 't1', 'u1', 'income',  100, '2026-01-01T00:00:00Z', 0, 700),
        ('lg1', 't2', 'u1', 'expense', 30,  '2026-01-02T00:00:00Z', 0, 210),
        ('lg1', 't3', 'u1', 'expense', 20,  '2026-01-03T00:00:00Z', 1, 140);
    `);
    const app = buildApp(db);
    const ownerToken = await createAccessToken('u1', SECRET, ['app_write']);
    const memberToken = await createAccessToken('u2', SECRET, ['app_write']);

    // owner 可见
    const ownerRes = await fetchSummary(app, db, ownerToken, 'lg1');
    expect(ownerRes.status).toBe(200);
    const owner = await ownerRes.json() as any;
    expect(owner.transaction_count).toBe(3);          // 含标记笔
    expect(owner.income_total).toBe(700);             // native 口径
    expect(owner.expense_total).toBe(210);            // 排除标记笔 t3
    expect(owner.balance).toBe(700 - 210 - 140);      // balance 含标记笔 t3

    // 共享账本成员可见(对齐上游 _require_ledger)
    const memberRes = await fetchSummary(app, db, memberToken, 'lg1');
    expect(memberRes.status).toBe(200);

    // 无访问权用户 404
    const outsider = await createAccessToken('u3', SECRET, ['app_write']);
    const denied = await fetchSummary(app, db, outsider, 'lg1');
    expect(denied.status).toBe(404);
  });
});