import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { createRealDb } from './helpers/realsql-db';
import writeRouter from '../src/routes/write';
import readRouter from '../src/routes/read';

// 移植上游 tests/test_budget_crud.py:
// web 创建/更新预算经 projection 落库 + SyncChange payload 带 ledgerSyncId;
// 分类预算持久化 category_id;父分类预算 usage 覆盖子分类交易(#15);
// 总预算 used = 当周期内全部 expense;重复 total 预算 400 拦截(对齐上游)。
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
  CREATE TABLE user_category_projection (
    sync_id TEXT PRIMARY KEY, user_id TEXT, name TEXT, kind TEXT, parent_sync_id TEXT
  );
  CREATE TABLE read_tx_projection (
    ledger_id TEXT, sync_id TEXT, user_id TEXT, tx_type TEXT, amount REAL DEFAULT 0,
    happened_at TEXT, category_sync_id TEXT, category_name TEXT,
    exclude_from_stats BOOLEAN DEFAULT 0, exclude_from_budget BOOLEAN DEFAULT 0,
    native_amount REAL, PRIMARY KEY (ledger_id, sync_id)
  );
  CREATE TABLE audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, ledger_id TEXT, action TEXT, metadata_json TEXT, created_at TEXT);
`;

const USER = 'user-1';
const EXTERNAL = 'L1';

function seedLedger() {
  sqlite.prepare("INSERT INTO users (id, email, password_hash) VALUES (?, 'bud@x.com', 'x')").run(USER);
  sqlite.prepare("INSERT INTO ledgers (id, external_id, user_id, name, currency) VALUES ('lg1', ?, ?, '账本', 'CNY')").run(EXTERNAL, USER);
  sqlite.prepare("INSERT INTO ledger_members (ledger_id, user_id, role) VALUES ('lg1', ?, 'owner')").run(USER);
}

function insertCategory(syncId: string, name: string, parentSyncId: string | null = null) {
  sqlite.prepare('INSERT INTO user_category_projection (sync_id, user_id, name, kind, parent_sync_id) VALUES (?, ?, ?, ?, ?)')
    .run(syncId, USER, name, 'expense', parentSyncId);
}

function currentPeriod() {
  // 本地实现用本地时区计算当月周期(start_day=1 → 本月 1 日到下月 1 日),测试按同口径造数
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`;
}

function insertTx(syncId: string, amount: number, categorySyncId: string | null, opts: { excludeBudget?: boolean; excludeStats?: boolean } = {}) {
  sqlite.prepare(
    `INSERT INTO read_tx_projection (ledger_id, sync_id, user_id, tx_type, amount, happened_at, category_sync_id,
       exclude_from_stats, exclude_from_budget, native_amount)
     VALUES ('lg1', ?, ?, 'expense', ?, ?, ?, ?, ?, ?)`
  ).run(syncId, USER, amount, `${currentPeriod()}T12:00:00`, categorySyncId,
    opts.excludeStats ? 1 : 0, opts.excludeBudget ? 1 : 0, amount);
}

function latestChangeId(): number {
  const row = sqlite.prepare('SELECT MAX(change_id) AS m FROM sync_changes').get() as { m: number | null };
  return row.m ?? 0;
}

async function createBudget(body: Record<string, unknown>) {
  return app.request('/api/v1/write/ledgers/L1/budgets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ base_change_id: latestChangeId(), ...body }),
  }, { DB: db, JWT_SECRET: 'test-secret' } as any);
}

async function listBudgets() {
  const res = await app.request('/api/v1/read/ledgers/L1/budgets', {}, { DB: db, JWT_SECRET: 'test-secret' } as any);
  expect(res.status).toBe(200);
  return res.json() as Promise<any[]>;
}

async function usage() {
  const res = await app.request('/api/v1/read/ledgers/L1/budgets/usage', {}, { DB: db, JWT_SECRET: 'test-secret' } as any);
  expect(res.status).toBe(200);
  return res.json() as Promise<{ items: Array<{ budget_id: string; used: number }> }>;
}

beforeEach(() => {
  const created = createRealDb();
  sqlite = created.sqlite;
  db = created.db;
  sqlite.exec(TABLES);
  seedLedger();

  app = new Hono<{ Bindings: any; Variables: { userId: string } }>();
  app.use('/api/v1/*', async (c, next) => {
    c.set('userId', USER);
    await next();
  });
  app.route('/api/v1/write', writeRouter);
  app.route('/api/v1/read', readRouter);
});

afterEach(() => sqlite.close());

describe('web 预算 CRUD(移植上游 test_budget_crud.py)', () => {
  it('创建总预算→列表 3000→更新 5000→列表 5000,payload 带 ledgerSyncId', async () => {
    const create = await createBudget({ type: 'total', amount: 3000, period: 'monthly', start_day: 1 });
    expect(create.status).toBe(200);

    let budgets = await listBudgets();
    expect(budgets).toHaveLength(1);
    expect(budgets[0].type).toBe('total');
    expect(budgets[0].amount).toBe(3000);
    const budgetId = budgets[0].id;

    const patch = await app.request(`/api/v1/write/ledgers/L1/budgets/${budgetId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base_change_id: latestChangeId(), amount: 5000 }),
    }, { DB: db, JWT_SECRET: 'test-secret' } as any);
    expect(patch.status).toBe(200);

    budgets = await listBudgets();
    expect(budgets).toHaveLength(1);
    expect(budgets[0].amount).toBe(5000);

    // SyncChange payload 必须带 ledgerSyncId(mobile pull 靠它解析本地账本)
    const changes = sqlite.prepare("SELECT payload_json FROM sync_changes WHERE entity_type = 'budget' ORDER BY change_id").all() as { payload_json: string }[];
    expect(changes.length).toBe(2);
    for (const ch of changes) {
      const payload = JSON.parse(ch.payload_json) as Record<string, unknown>;
      expect(payload.ledgerSyncId).toBe('L1');
    }
  });

  it('分类预算持久化 category_id 与分类名', async () => {
    insertCategory('cat-dining', '餐饮');
    const res = await createBudget({ type: 'category', category_id: 'cat-dining', amount: 800 });
    expect(res.status).toBe(200);

    const budgets = await listBudgets();
    expect(budgets.some(b => b.type === 'category' && b.category_id === 'cat-dining' && b.category_name === '餐饮')).toBe(true);
  });

  it('父分类预算 usage 聚合子分类交易(#15)', async () => {
    insertCategory('cat-parent', '吃喝');
    insertCategory('cat-child-1', '吃', 'cat-parent');
    insertCategory('cat-child-2', '喝', 'cat-parent');

    const res = await createBudget({ type: 'category', category_id: 'cat-parent', amount: 1000, start_day: 1 });
    expect(res.status).toBe(200);

    insertTx('tx-1', 50, 'cat-child-1');
    insertTx('tx-2', 60, 'cat-child-2');
    insertTx('tx-3', 20, 'cat-parent');

    const { items } = await usage();
    const catBudget = await listBudgets();
    const parentBudget = catBudget.find(b => b.type === 'category')!;
    const used = items.find(i => i.budget_id === parentBudget.id)?.used;
    expect(used).toBe(130);
  });

  it('总预算 used = 当周期内全部 expense 之和', async () => {
    const res = await createBudget({ type: 'total', amount: 5000, start_day: 1 });
    expect(res.status).toBe(200);
    insertTx('tx-a', 100, 'cat-x');
    insertTx('tx-b', 200, 'cat-y');

    const { items } = await usage();
    expect(items).toHaveLength(1);
    expect(items[0].used).toBe(300);
  });

  it('重复创建 total 预算 → 400(对齐上游)', async () => {
    const r1 = await createBudget({ type: 'total', amount: 1000 });
    expect(r1.status).toBe(200);

    const r2 = await createBudget({ type: 'total', amount: 2000 });
    expect(r2.status).toBe(400);
    const body = await r2.json() as any;
    expect(String(body.error)).toContain('Total budget');

    const budgets = await listBudgets();
    expect(budgets).toHaveLength(1);
    expect(budgets[0].amount).toBe(1000);
  });
});