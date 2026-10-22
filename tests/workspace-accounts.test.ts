import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { createRealDb } from './helpers/realsql-db';
import workspaceRouter from '../src/routes/workspace';
import { createAccessToken } from '../src/auth';

// workspace/accounts 重写为原版 3 条 GROUP BY(workspace.py main_stats/transfer_from/transfer_to)
// 后新增的口径回归测试:income_total/expense_total 仅统计 income/expense 类型(转账不计入收支),
// 转账影响计入 balance 与 tx_count;无交易账户三值归零、余额=初始余额。
const TABLES = `
  CREATE TABLE users (
    id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
    is_enabled INTEGER DEFAULT 1, is_admin INTEGER DEFAULT 0
  );
  CREATE TABLE ledgers (
    id TEXT PRIMARY KEY, external_id TEXT, user_id TEXT, name TEXT, currency TEXT
  );
  CREATE TABLE ledger_members (
    ledger_id TEXT, user_id TEXT, role TEXT, PRIMARY KEY (ledger_id, user_id)
  );
  CREATE TABLE user_account_projection (
    sync_id TEXT NOT NULL, user_id TEXT NOT NULL, name TEXT, account_type TEXT,
    currency TEXT, initial_balance REAL DEFAULT 0, note TEXT, credit_limit REAL,
    billing_day INTEGER, payment_due_day INTEGER, bank_name TEXT, card_last_four TEXT,
    hidden INTEGER DEFAULT 0, source_change_id INTEGER DEFAULT 0,
    PRIMARY KEY (user_id, sync_id)
  );
  CREATE TABLE read_tx_projection (
    ledger_id TEXT, sync_id TEXT, user_id TEXT, tx_type TEXT, amount REAL DEFAULT 0,
    happened_at TEXT, note TEXT, category_sync_id TEXT, category_name TEXT,
    account_sync_id TEXT, from_account_sync_id TEXT, to_account_sync_id TEXT,
    exclude_from_stats BOOLEAN DEFAULT 0, native_amount REAL,
    PRIMARY KEY (ledger_id, sync_id)
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
    try {
      const payload = JSON.parse(Buffer.from(auth.slice(7).split('.')[1], 'base64url').toString());
      c.set('userId' as never, payload.sub as string);
    } catch {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    return next();
  });
  app.route('/read/workspace', workspaceRouter);
  return app;
}

interface AccItem {
  id: string;
  name: string;
  income_total: number;
  expense_total: number;
  tx_count: number;
  balance: number;
  initial_balance: number;
  last_change_id: number;
}

async function fetchAccounts(app: Hono<any>, db: D1Database, token: string, qs = ''): Promise<AccItem[]> {
  const res = await app.request(`/read/workspace/accounts${qs}`, {
    headers: { Authorization: `Bearer ${token}` },
  }, { DB: db, JWT_SECRET: SECRET } as any);
  return res.json() as Promise<AccItem[]>;
}

function byId(items: AccItem[]): Record<string, AccItem> {
  return Object.fromEntries(items.map((i) => [i.id, i]));
}

describe('workspace/accounts 聚合(对齐原版 3 条 GROUP BY)', () => {
  it('收支不含转账、余额含转账影响、tx_count 含转账行、无交易账户归零', async () => {
    const { sqlite, db } = createRealDb();
    sqlite.exec(TABLES);
    sqlite.exec(`
      INSERT INTO users (id, email, password_hash, is_enabled) VALUES ('u1', 'acc@x.com', 'x', 1);
      INSERT INTO ledgers (id, external_id, user_id, name) VALUES ('lg1', 'lg1', 'u1', '账本');
      INSERT INTO user_account_projection (sync_id, user_id, name, account_type, initial_balance)
      VALUES ('acc-a', 'u1', '支付宝', 'bank_card', 100),
             ('acc-b', 'u1', '银行卡', 'bank_card', 200),
             ('acc-c', 'u1', '无交易卡', 'bank_card', 50);
      INSERT INTO read_tx_projection (ledger_id, sync_id, user_id, tx_type, amount, happened_at, account_sync_id, from_account_sync_id, to_account_sync_id)
      VALUES
        ('lg1', 't1', 'u1', 'income',     50, '2026-01-01T00:00:00Z', 'acc-a', NULL, NULL),
        ('lg1', 't2', 'u1', 'expense',    20, '2026-01-02T00:00:00Z', 'acc-a', NULL, NULL),
        ('lg1', 't3', 'u1', 'transfer',   30, '2026-01-03T00:00:00Z', NULL, 'acc-a', 'acc-b'),
        ('lg1', 't4', 'u1', 'income',     10, '2026-01-04T00:00:00Z', 'acc-b', NULL, NULL);
      INSERT INTO sync_changes (user_id, ledger_id, entity_type, entity_sync_id, action, scope)
      VALUES ('u1', 'lg1', 'account', 'acc-a', 'update', 'user');
    `);
    const app = buildApp(db);
    const token = await createAccessToken('u1', SECRET, ['app_write']);
    const items = await fetchAccounts(app, db, token);

    expect(items).toHaveLength(3);
    const m = byId(items);

    // acc-a: income 50 + expense 20 + 转出 30
    expect(m['acc-a'].income_total).toBe(50);    // 不含转出
    expect(m['acc-a'].expense_total).toBe(20);   // 不含转出
    expect(m['acc-a'].tx_count).toBe(3);         // income + expense + transfer
    expect(m['acc-a'].balance).toBe(100);        // 100 + 50 - 20 - 30

    // acc-b: income 10 + 转入 30 —— income_total 不含转入(旧实现会算成 40)
    expect(m['acc-b'].income_total).toBe(10);
    expect(m['acc-b'].expense_total).toBe(0);
    expect(m['acc-b'].tx_count).toBe(2);         // income + transfer-in
    expect(m['acc-b'].balance).toBe(240);        // 200 + 10 + 30

    // acc-c: 无交易 → 归零 + 余额=初始
    expect(m['acc-c'].income_total).toBe(0);
    expect(m['acc-c'].expense_total).toBe(0);
    expect(m['acc-c'].tx_count).toBe(0);
    expect(m['acc-c'].balance).toBe(50);

    // last_change_id = 用户级 account 变更 max change_id(对齐原版),所有账户统一
    expect(m['acc-a'].last_change_id).toBe(1);
    expect(m['acc-b'].last_change_id).toBe(1);
    expect(m['acc-c'].last_change_id).toBe(1);
  });

  it('name 去空白、跳过空名账户', async () => {
    const { sqlite, db } = createRealDb();
    sqlite.exec(TABLES);
    sqlite.exec(`
      INSERT INTO users (id, email, password_hash, is_enabled) VALUES ('u1', 'trim@x.com', 'x', 1);
      INSERT INTO ledgers (id, external_id, user_id, name) VALUES ('lg1', 'lg1', 'u1', '账本');
      INSERT INTO user_account_projection (sync_id, user_id, name, account_type, initial_balance)
      VALUES ('acc-a', 'u1', '  钱包  ', 'bank_card', 100), ('acc-b', 'u1', '', 'bank_card', 200), ('acc-c', 'u1', '  ', 'bank_card', 300);
    `);
    const app = buildApp(db);
    const token = await createAccessToken('u1', SECRET, ['app_write']);
    const items = await fetchAccounts(app, db, token);

    // acc-b/acc-c 空名被跳过;acc-a 名字去空白
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe('acc-a');
    expect(items[0].name).toBe('钱包');
  });

  it('排除软删账本:最新 ledger_snapshot 动作为 delete 的账本交易不计入聚合', async () => {
    const { sqlite, db } = createRealDb();
    sqlite.exec(TABLES);
    sqlite.exec(`
      INSERT INTO users (id, email, password_hash, is_enabled) VALUES ('u1', 'softdel@x.com', 'x', 1);
      INSERT INTO ledgers (id, external_id, user_id, name) VALUES
        ('lg1', 'lg1', 'u1', '活跃账本'), ('lg2', 'lg2', 'u1', '已软删账本');
      INSERT INTO user_account_projection (sync_id, user_id, name, account_type, initial_balance)
      VALUES ('acc-a', 'u1', '共用账户', 'bank_card', 100);
      INSERT INTO read_tx_projection (ledger_id, sync_id, user_id, tx_type, amount, happened_at, account_sync_id)
      VALUES
        ('lg1', 't1', 'u1', 'income', 50, '2026-01-01T00:00:00Z', 'acc-a'),
        ('lg2', 't2', 'u1', 'income', 80, '2026-01-02T00:00:00Z', 'acc-a');
      -- lg1 最新动作为 upsert(活跃);lg2 最新动作为 delete(软删)
      INSERT INTO sync_changes (user_id, ledger_id, entity_type, entity_sync_id, action, scope) VALUES
        ('u1', 'lg1', 'ledger_snapshot', 'lg1', 'upsert', 'ledger'),
        ('u1', 'lg2', 'ledger_snapshot', 'lg2', 'upsert', 'ledger'),
        ('u1', 'lg2', 'ledger_snapshot', 'lg2', 'delete', 'ledger');
    `);
    const app = buildApp(db);
    const token = await createAccessToken('u1', SECRET, ['app_write']);
    const items = await fetchAccounts(app, db, token);

    expect(items).toHaveLength(1);
    expect(items[0].id).toBe('acc-a');
    expect(items[0].income_total).toBe(50);  // 仅活跃账本 lg1;软删账本 lg2 的 80 不计入
    expect(items[0].balance).toBe(150);
  });

  it('跨账本聚合;传 ledger_id 只算该账本', async () => {
    const { sqlite, db } = createRealDb();
    sqlite.exec(TABLES);
    sqlite.exec(`
      INSERT INTO users (id, email, password_hash, is_enabled) VALUES ('u1', 'acc2@x.com', 'x', 1);
      INSERT INTO ledgers (id, external_id, user_id, name) VALUES
        ('lg1', 'lg1', 'u1', '账本一'), ('lg2', 'lg2', 'u1', '账本二');
      INSERT INTO user_account_projection (sync_id, user_id, name, account_type, initial_balance)
      VALUES ('acc-a', 'u1', '共用账户', 'bank_card', 100),
             ('acc-b', 'u1', '只在一账本', 'bank_card', 200);
      INSERT INTO read_tx_projection (ledger_id, sync_id, user_id, tx_type, amount, happened_at, account_sync_id)
      VALUES
        ('lg1', 't1', 'u1', 'income',  50, '2026-01-01T00:00:00Z', 'acc-a'),
        ('lg2', 't2', 'u1', 'expense', 20, '2026-01-02T00:00:00Z', 'acc-a'),
        ('lg2', 't3', 'u1', 'expense', 15, '2026-01-03T00:00:00Z', 'acc-b');
    `);
    const app = buildApp(db);
    const token = await createAccessToken('u1', SECRET, ['app_write']);

    // 不传 ledger_id:跨账本聚合
    const all = byId(await fetchAccounts(app, db, token));
    expect(all['acc-a'].income_total).toBe(50);
    expect(all['acc-a'].expense_total).toBe(20);
    expect(all['acc-a'].balance).toBe(130);
    expect(all['acc-b'].expense_total).toBe(15);

    // 传 ledger_id=lg1:只算账本一
    const one = byId(await fetchAccounts(app, db, token, '?ledger_id=lg1'));
    expect(one['acc-a'].income_total).toBe(50);
    expect(one['acc-a'].expense_total).toBe(0);
    expect(one['acc-a'].balance).toBe(150);
    expect(one['acc-b'].expense_total).toBe(0);
    expect(one['acc-b'].balance).toBe(200);
  });
});