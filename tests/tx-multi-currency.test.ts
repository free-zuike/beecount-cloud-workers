// 移植上游 tests/test_tx_multi_currency.py(27 例的关键路径):
// - 投影两列:currency_code/native_amount 落值、legacy payload 保持 NULL;
// - merge 契约:partial push 保留折算、旧 App 改金额按隐含汇率联动缩放
//   (同币种跟随 / 外币等比);
// - 统计端点:账本级 totals、analytics、budget usage 按 COALESCE(native_amount, amount);
//   账户维度保持原币 amount;
// - Web 写:create 带两字段落投影、改账本主币种重算投影(汇率 stub);
// - CSV 导出含币种列;snapshot/full pull 带两字段;read 端点吐两字段;
// - ledger totals 排除 exclude_from_stats 标记笔(余额含)。
// 注:本地无独立 snapshot_mutator/import parser,对应用例改走真实端点断言。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import syncRouter from '../src/routes/sync';
import readRouter from '../src/routes/read';
import workspaceRouter from '../src/routes/workspace';
import writeRouter from '../src/routes/write';
import csvRouter from '../src/routes/csv';

let sqlite: DatabaseSync;
let db: D1Database;
let app: Hono<{ Bindings: { DB: D1Database }; Variables: { userId: string } }>;

const USER = 'user-1';

function iso(): string { return new Date().toISOString(); }
function isoAt(msOffset: number): string { return new Date(Date.now() + msOffset).toISOString(); }

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, is_admin INTEGER DEFAULT 0);
    CREATE TABLE ledgers (id TEXT PRIMARY KEY, user_id TEXT, external_id TEXT, name TEXT, currency TEXT, month_start_day INTEGER DEFAULT 1, created_at TEXT);
    CREATE TABLE ledger_members (ledger_id TEXT, user_id TEXT, role TEXT, joined_at TEXT);
    CREATE TABLE devices (id TEXT PRIMARY KEY, user_id TEXT, name TEXT, platform TEXT, last_seen_at TEXT, last_ip TEXT, revoked_at TEXT, created_at TEXT);
    CREATE TABLE sync_changes (
      change_id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, ledger_id TEXT, entity_type TEXT,
      entity_sync_id TEXT, action TEXT, payload_json TEXT, updated_at TEXT,
      updated_by_user_id TEXT, updated_by_device_id TEXT, scope TEXT
    );
    CREATE TABLE read_tx_projection (
      ledger_id TEXT, sync_id TEXT, user_id TEXT, tx_type TEXT, amount REAL DEFAULT 0, happened_at TEXT, note TEXT,
      category_sync_id TEXT, category_name TEXT, category_kind TEXT,
      account_sync_id TEXT, account_name TEXT,
      from_account_sync_id TEXT, from_account_name TEXT,
      to_account_sync_id TEXT, to_account_name TEXT,
      tags_csv TEXT, tag_sync_ids_json TEXT, attachments_json TEXT, tx_index INTEGER DEFAULT 0,
      created_by_user_id TEXT, last_edited_by_user_id TEXT, source_change_id INTEGER DEFAULT 0,
      currency_code TEXT, native_amount REAL,
      exclude_from_stats INTEGER DEFAULT 0, exclude_from_budget INTEGER DEFAULT 0,
      PRIMARY KEY (ledger_id, sync_id)
    );
    CREATE TABLE read_budget_projection (ledger_id TEXT, sync_id TEXT, user_id TEXT, budget_type TEXT, category_sync_id TEXT, amount REAL, period TEXT, start_day INTEGER, enabled INTEGER DEFAULT 1, source_change_id INTEGER DEFAULT 0, PRIMARY KEY (ledger_id, sync_id));
    CREATE TABLE user_account_projection (
      sync_id TEXT PRIMARY KEY, user_id TEXT, name TEXT, account_type TEXT, currency TEXT,
      initial_balance REAL DEFAULT 0, note TEXT, credit_limit REAL, billing_day INTEGER, payment_due_day INTEGER,
      bank_name TEXT, card_last_four TEXT, hidden INTEGER DEFAULT 0, source_change_id INTEGER DEFAULT 0
    );
    CREATE TABLE user_category_projection (sync_id TEXT PRIMARY KEY, user_id TEXT, name TEXT, kind TEXT, level INTEGER, sort_order INTEGER, icon TEXT, icon_type TEXT, custom_icon_path TEXT, icon_cloud_file_id TEXT, icon_cloud_sha256 TEXT, parent_name TEXT, parent_sync_id TEXT, source_change_id INTEGER DEFAULT 0);
    CREATE TABLE user_tag_projection (sync_id TEXT PRIMARY KEY, user_id TEXT, name TEXT, color TEXT, source_change_id INTEGER);
    CREATE TABLE audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, ledger_id TEXT, action TEXT, metadata_json TEXT, created_at TEXT);
    CREATE TABLE sync_push_idempotency (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, device_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL, response_json TEXT NOT NULL,
      created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
      UNIQUE(user_id, device_id, idempotency_key)
    );
    CREATE TABLE sync_cursors (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, device_id TEXT NOT NULL,
      ledger_external_id TEXT NOT NULL, last_cursor INTEGER DEFAULT 0 NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(user_id, device_id, ledger_external_id)
    );
    CREATE TABLE user_exchange_rate_projection (sync_id TEXT PRIMARY KEY, user_id TEXT, base_currency TEXT, quote_currency TEXT, rate TEXT, updated_at TEXT, source_change_id INTEGER DEFAULT 0);
  `);

  db = {
    prepare(sql: string) {
      const statement = sqlite.prepare(sql);
      let params: unknown[] = [];
      return {
        bind(...values: unknown[]) { params = values; return this; },
        async run() {
          const r = statement.run(...(params as never[]));
          return { meta: { last_row_id: Number(r.lastInsertRowid), changes: r.changes } };
        },
        async first<T = unknown>() {
          const row = statement.get(...(params as never[])) as T | undefined;
          return row ?? null;
        },
        async all<T = unknown>() {
          return { results: statement.all(...(params as never[])) as T[] };
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

  sqlite.prepare("INSERT INTO users (id, email, password_hash) VALUES (?, 'mc@x.com', 'x')").run(USER);
  sqlite.prepare("INSERT INTO devices (id, user_id, name, platform, created_at) VALUES ('d1', ?, 'd1', 'test', '2025-01-01T00:00:00Z')").run(USER);
  sqlite.prepare("INSERT INTO ledgers (id, user_id, external_id, name, currency, created_at) VALUES ('lg1', ?, 'L1', 'L1', 'CNY', '2025-01-01T00:00:00Z')").run(USER);
  sqlite.prepare("INSERT INTO ledger_members (ledger_id, user_id, role, joined_at) VALUES ('lg1', ?, 'owner', '2025-01-01T00:00:00Z')").run(USER);

  app = new Hono<{ Bindings: { DB: D1Database }; Variables: { userId: string } }>();
  app.use('*', async (c, next) => { c.set('userId', USER); await next(); });
  app.route('/api/v1/sync', syncRouter);
  app.route('/api/v1/read', readRouter);
  app.route('/api/v1/read/workspace', workspaceRouter);
  app.route('/api/v1/write', writeRouter);
  app.route('/api/v1/export', csvRouter);
});

afterEach(() => sqlite.close());

async function push(changes: Array<Record<string, unknown>>, deviceId = 'd1', ledgerExt = 'L1') {
  const res = await app.request('/api/v1/sync/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Device-ID': deviceId, 'CF-Connecting-IP': '127.0.0.1' },
    body: JSON.stringify({ device_id: deviceId, changes }),
  }, { DB: db } as any);
  expect(res.status).toBe(200);
  return res;
}

function pushTx(syncId: string, payload: Record<string, unknown>, updatedAt?: string) {
  return push([{
    ledger_id: 'L1', entity_type: 'transaction', entity_sync_id: syncId, action: 'upsert',
    updated_at: updatedAt ?? iso(), payload,
  }]);
}

function txRow(syncId: string): Record<string, unknown> {
  const row = sqlite.prepare('SELECT * FROM read_tx_projection WHERE ledger_id = ? AND sync_id = ?').get('lg1', syncId) as Record<string, unknown> | undefined;
  expect(row).toBeDefined();
  return row!;
}

async function seedMixedCurrency() {
  await push([
    { ledger_id: 'L1', entity_type: 'ledger', entity_sync_id: 'L1', action: 'upsert', updated_at: iso(),
      payload: { syncId: 'L1', ledgerName: '多币账本', currency: 'CNY' } },
    { ledger_id: 'L1', entity_type: 'account', entity_sync_id: 'acc-usd', action: 'upsert', updated_at: iso(),
      payload: { syncId: 'acc-usd', name: 'Chase', type: 'bank', currency: 'USD' } },
    { ledger_id: 'L1', entity_type: 'transaction', entity_sync_id: 'tx-usd', action: 'upsert', updated_at: iso(),
      payload: { syncId: 'tx-usd', type: 'expense', amount: 12.0, currencyCode: 'USD', nativeAmount: 86.4,
                 accountId: 'acc-usd', accountName: 'Chase', categoryName: '餐饮', happenedAt: iso() } },
    { ledger_id: 'L1', entity_type: 'transaction', entity_sync_id: 'tx-cny', action: 'upsert', updated_at: iso(),
      payload: { syncId: 'tx-cny', type: 'expense', amount: 100.0, currencyCode: 'CNY', nativeAmount: 100.0,
                 categoryName: '餐饮', happenedAt: iso() } },
  ]);
}

describe('投影两列 + upsert/merge 契约(移植上游 test_tx_multi_currency.py)', () => {
  it('新 App push 带 currencyCode/nativeAmount → 投影两列落值', async () => {
    await pushTx('tx1', { syncId: 'tx1', type: 'expense', amount: 12.0, currencyCode: 'USD', nativeAmount: 86.4, happenedAt: iso() });
    const tx = txRow('tx1');
    expect(tx.currency_code).toBe('USD');
    expect(tx.native_amount).toBe(86.4);
    expect(tx.amount).toBe(12.0);
  });

  it('旧 App payload 无两字段 → 保持 NULL(统计 COALESCE 兜底)', async () => {
    await pushTx('tx2', { syncId: 'tx2', type: 'expense', amount: 5.0, happenedAt: iso() });
    const tx = txRow('tx2');
    expect(tx.currency_code).toBeNull();
    expect(tx.native_amount).toBeNull();
    expect(tx.amount).toBe(5.0);
  });

  it('partial push 只改 note → 保留已有折算快照', async () => {
    await pushTx('tx3', { syncId: 'tx3', type: 'expense', amount: 12.0, currencyCode: 'USD', nativeAmount: 86.4, happenedAt: iso() }, isoAt(0));
    await pushTx('tx3', { syncId: 'tx3', amount: 12.0, note: '改个备注' }, isoAt(60_000));
    const tx = txRow('tx3');
    expect(tx.note).toBe('改个备注');
    expect(tx.currency_code).toBe('USD');
    expect(tx.native_amount).toBe(86.4);
  });

  it('旧 App 改金额(外币)→ 按隐含汇率等比缩放 native(12→24,86.4→172.8)', async () => {
    await pushTx('tx4', { syncId: 'tx4', type: 'expense', amount: 12.0, currencyCode: 'USD', nativeAmount: 86.4, happenedAt: iso() }, isoAt(0));
    await pushTx('tx4', { syncId: 'tx4', amount: 24.0 }, isoAt(60_000));
    const tx = txRow('tx4');
    expect(tx.amount).toBe(24.0);
    expect(Number(tx.native_amount)).toBeCloseTo(172.8, 9);
    expect(tx.currency_code).toBe('USD');
  });

  it('旧 App 改金额(同币种,native==amount)→ native 跟随新值', async () => {
    await pushTx('tx5', { syncId: 'tx5', type: 'expense', amount: 10.0, currencyCode: 'CNY', nativeAmount: 10.0, happenedAt: iso() }, isoAt(0));
    await pushTx('tx5', { syncId: 'tx5', amount: 25.0 }, isoAt(60_000));
    const tx = txRow('tx5');
    expect(tx.amount).toBe(25.0);
    expect(Number(tx.native_amount)).toBeCloseTo(25.0, 9);
  });

  it('amount 未变(只改备注)→ 折算快照不动', async () => {
    await pushTx('tx6', { syncId: 'tx6', type: 'expense', amount: 12.0, currencyCode: 'USD', nativeAmount: 86.4, happenedAt: iso() }, isoAt(0));
    await pushTx('tx6', { syncId: 'tx6', note: '备注' }, isoAt(60_000));
    const tx = txRow('tx6');
    expect(tx.note).toBe('备注');
    expect(tx.native_amount).toBe(86.4);
  });
});

describe('账本维度统计折 native_amount(移植上游 test_tx_multi_currency.py)', () => {
  it('账本级收支按 COALESCE(native_amount, amount):86.4+100=186.4', async () => {
    await seedMixedCurrency();
    const res = await app.request('/api/v1/read/ledgers', {}, { DB: db } as any);
    expect(res.status).toBe(200);
    const body = await res.json() as Array<Record<string, unknown>>;
    const row = body.find(x => x.ledger_id === 'L1');
    expect(row).toBeDefined();
    expect(Number(row!.expense_total)).toBeCloseTo(186.4, 6);
  });

  it('纯本位币账本 totals 与旧口径一致(回归锁)', async () => {
    await pushTx('t1', { syncId: 't1', type: 'expense', amount: 30.0, currencyCode: 'CNY', nativeAmount: 30.0, happenedAt: iso() });
    await pushTx('t2', { syncId: 't2', type: 'income', amount: 50.0, currencyCode: 'CNY', nativeAmount: 50.0, happenedAt: iso() });
    const res = await app.request('/api/v1/read/ledgers', {}, { DB: db } as any);
    const body = await res.json() as Array<Record<string, unknown>>;
    const row = body.find(x => x.ledger_id === 'L1');
    expect(Number(row!.expense_total)).toBeCloseTo(30.0, 9);
    expect(Number(row!.income_total)).toBeCloseTo(50.0, 9);
  });

  it('native_amount NULL 的行统计回退 amount', async () => {
    await pushTx('t1', { syncId: 't1', type: 'expense', amount: 42.0, happenedAt: iso() });
    const res = await app.request('/api/v1/read/ledgers', {}, { DB: db } as any);
    const body = await res.json() as Array<Record<string, unknown>>;
    const row = body.find(x => x.ledger_id === 'L1');
    expect(Number(row!.expense_total)).toBeCloseTo(42.0, 9);
  });

  it('analytics 支出汇总 + 分类排行同口径 186.4', async () => {
    await seedMixedCurrency();
    const res = await app.request('/api/v1/read/workspace/analytics?scope=all&metric=expense', {}, { DB: db } as any);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(Number(body.summary.expense_total)).toBeCloseTo(186.4, 6);
    const ranks = new Map((body.category_ranks as Array<{ category_name: string; total: number }>).map(r => [r.category_name, r.total]));
    expect(Number(ranks.get('餐饮'))).toBeCloseTo(186.4, 6);
  });

  it('budget usage 按 native 折算:186.4', async () => {
    await seedMixedCurrency();
    await push([
      { ledger_id: 'L1', entity_type: 'budget', entity_sync_id: 'bud1', action: 'upsert', updated_at: iso(),
        payload: { syncId: 'bud1', type: 'total', amount: 1000.0, period: 'monthly', startDay: 1, enabled: true } },
    ]);
    const res = await app.request('/api/v1/read/ledgers/L1/budgets/usage', {}, { DB: db } as any);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    const items = new Map((body.items as Array<{ budget_id: string; used: number }>).map(x => [x.budget_id, x.used]));
    expect(Number(items.get('bud1'))).toBeCloseTo(186.4, 6);
  });

  it('账户维度保持原币 amount:Chase = $12', async () => {
    await seedMixedCurrency();
    const res = await app.request('/api/v1/read/workspace/accounts', {}, { DB: db } as any);
    expect(res.status).toBe(200);
    const body = await res.json() as Array<{ name: string; expense_total: number }>;
    const acc = body.find(x => x.name === 'Chase');
    expect(acc).toBeDefined();
    expect(Number(acc!.expense_total)).toBeCloseTo(12.0, 9);
  });

  it('账本 totals 排除 exclude_from_stats 标记笔,余额含标记笔', async () => {
    await pushTx('t1', { syncId: 't1', type: 'expense', amount: 100.0, happenedAt: iso() });
    await pushTx('t2', { syncId: 't2', type: 'income', amount: 1.0, excludeFromStats: true, happenedAt: iso() });
    const res = await app.request('/api/v1/read/ledgers', {}, { DB: db } as any);
    const body = await res.json() as Array<Record<string, unknown>>;
    const row = body.find(x => x.ledger_id === 'L1');
    expect(Number(row!.expense_total)).toBeCloseTo(100.0, 9);
    expect(Number(row!.income_total)).toBeCloseTo(0.0, 9);
    expect(Number(row!.transaction_count)).toBe(2);
    expect(Number(row!.balance)).toBeCloseTo(-99.0, 9);
  });
});

describe('Web 写路径 + 读端点(移植上游 test_tx_multi_currency.py)', () => {
  async function webCreateTx(body: Record<string, unknown>) {
    return app.request('/api/v1/write/ledgers/L1/transactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Device-ID': 'web' },
      body: JSON.stringify({ base_change_id: 0, happened_at: iso(), ...body }),
    }, { DB: db } as any);
  }

  it('Web create tx 带 currency_code/native_amount → 投影两列落值', async () => {
    const res = await webCreateTx({ tx_type: 'expense', amount: 12.0, currency_code: 'USD', native_amount: 86.4 });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    const tx = txRow(body.entity_id as string);
    expect(tx.currency_code).toBe('USD');
    expect(Number(tx.native_amount)).toBeCloseTo(86.4, 9);
  });

  it('Web PATCH 改 amount 外币 → native 等比缩放(隐含汇率保持)', async () => {
    const created = await webCreateTx({ tx_type: 'expense', amount: 12.0, currency_code: 'USD', native_amount: 86.4 });
    const createBody = await created.json() as any;
    const txId = createBody.entity_id as string;
    const res = await app.request(`/api/v1/write/ledgers/L1/transactions/${txId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'X-Device-ID': 'web' },
      body: JSON.stringify({ base_change_id: createBody.new_change_id, amount: 24.0 }),
    }, { DB: db } as any);
    expect(res.status).toBe(200);
    const tx = txRow(txId);
    expect(Number(tx.amount)).toBeCloseTo(24.0, 9);
    expect(Number(tx.native_amount)).toBeCloseTo(172.8, 9);
  });

  it('read 端点吐两字段:/read/ledgers/L1/transactions', async () => {
    await seedMixedCurrency();
    const res = await app.request('/api/v1/read/ledgers/L1/transactions', {}, { DB: db } as any);
    expect(res.status).toBe(200);
    const body = await res.json() as Array<Record<string, unknown>>;
    const byId = new Map(body.map(x => [x.id, x]));
    expect(byId.get('tx-usd')!.currency_code).toBe('USD');
    expect(Number(byId.get('tx-usd')!.native_amount)).toBeCloseTo(86.4, 9);
    expect(byId.get('tx-cny')!.currency_code).toBe('CNY');
  });

  it('CSV 导出含币种列:外币导出 USD,legacy NULL 按本位币兜底', async () => {
    await seedMixedCurrency();
    await pushTx('tx-legacy', { syncId: 'tx-legacy', type: 'expense', amount: 5.0, happenedAt: iso() });
    const res = await app.request('/api/v1/export/workspace/transactions.csv?lang=zh-CN', {}, { DB: db } as any);
    expect(res.status).toBe(200);
    const text = await res.text();
    const lines = text.replace(/^\uFEFF/, '').split('\n');
    const header = lines[0].split(',');
    expect(header[4]).toBe('币种');
    expect(text).toContain('USD');
    expect(text).toContain('CNY');
  });
});