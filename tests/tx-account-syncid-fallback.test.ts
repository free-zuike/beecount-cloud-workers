import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import syncRouter from '../src/routes/sync';
import writeRouter from '../src/routes/write';
import readRouter from '../src/routes/read';

// 移植上游 tests/test_tx_account_syncid_fallback.py(#41 按名补全):
// 只带账户名不带 accountId 时按用户级唯一同名补全 account_sync_id
// （mobile push 合并路径 + web write 创建路径）;同名歧义保持 NULL;
// partial update 不清已有 id。#6 backfill(api-997 alembic) 本地无 → 不移植。
let sqlite: DatabaseSync;
let db: D1Database;
let app: Hono<{ Bindings: any; Variables: { userId: string } }>;

const USER = 'user-1';

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL);
    CREATE TABLE ledgers (id TEXT PRIMARY KEY, user_id TEXT, external_id TEXT, name TEXT, currency TEXT, month_start_day INTEGER DEFAULT 1);
    CREATE TABLE ledger_members (ledger_id TEXT, user_id TEXT, role TEXT, joined_at TEXT);
    CREATE TABLE devices (id TEXT PRIMARY KEY, user_id TEXT, name TEXT, platform TEXT, last_seen_at TEXT, last_ip TEXT, revoked_at TEXT, created_at TEXT);
    CREATE TABLE sync_cursors (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, device_id TEXT NOT NULL,
      ledger_external_id TEXT NOT NULL, last_cursor INTEGER DEFAULT 0 NOT NULL, updated_at TEXT,
      UNIQUE(user_id, device_id, ledger_external_id)
    );
    CREATE TABLE sync_changes (
      change_id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, ledger_id TEXT, entity_type TEXT,
      entity_sync_id TEXT, action TEXT, payload_json TEXT, updated_at TEXT,
      updated_by_user_id TEXT, updated_by_device_id TEXT, scope TEXT
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
    CREATE TABLE user_account_projection (sync_id TEXT PRIMARY KEY, user_id TEXT, name TEXT, account_type TEXT, currency TEXT, initial_balance REAL DEFAULT 0, note TEXT, credit_limit REAL, billing_day INTEGER, payment_due_day INTEGER, bank_name TEXT, card_last_four TEXT, hidden INTEGER DEFAULT 0, source_change_id INTEGER DEFAULT 0);
    CREATE TABLE user_category_projection (sync_id TEXT PRIMARY KEY, user_id TEXT, name TEXT, kind TEXT, level INTEGER, sort_order INTEGER, icon TEXT, icon_type TEXT, custom_icon_path TEXT, icon_cloud_file_id TEXT, icon_cloud_sha256 TEXT, parent_name TEXT, parent_sync_id TEXT, source_change_id INTEGER DEFAULT 0);
    CREATE TABLE user_tag_projection (sync_id TEXT PRIMARY KEY, user_id TEXT, name TEXT, color TEXT, source_change_id INTEGER);
    CREATE TABLE user_exchange_rate_projection (sync_id TEXT PRIMARY KEY, user_id TEXT, base_currency TEXT, quote_currency TEXT, rate REAL);
    CREATE TABLE read_budget_projection (ledger_id TEXT, sync_id TEXT, user_id TEXT, budget_type TEXT, category_sync_id TEXT, amount REAL, period TEXT, start_day INTEGER, enabled INTEGER DEFAULT 1);
    CREATE TABLE audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, ledger_id TEXT, action TEXT, metadata_json TEXT, created_at TEXT);
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

  sqlite.prepare("INSERT INTO users (id, email, password_hash) VALUES ('user-1', 'fb@x.com', 'x')").run();
  sqlite.prepare("INSERT INTO ledgers (id, user_id, external_id, name, currency) VALUES ('ledger-1', 'user-1', 'L1', 'L1', 'CNY')").run();
  sqlite.prepare("INSERT INTO ledger_members (ledger_id, user_id, role, joined_at) VALUES ('ledger-1', 'user-1', 'owner', '2025-01-01T00:00:00Z')").run();
  sqlite.prepare("INSERT INTO devices (id, user_id, name, platform, created_at) VALUES ('dev-1', 'user-1', 'dev-1', 'test', '2025-01-01T00:00:00Z')").run();

  app = new Hono<{ Bindings: any; Variables: { userId: string } }>();
  app.use('*', async (c, next) => {
    c.set('userId', USER);
    await next();
  });
  app.route('/api/v1/sync', syncRouter);
  app.route('/api/v1/write', writeRouter);
  app.route('/api/v1/read', readRouter);
});

afterEach(() => sqlite.close());

async function push(changes: unknown[]) {
  const res = await app.request('/api/v1/sync/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_id: 'dev-1', changes }),
  }, { DB: db } as any);
  expect(res.status).toBe(200);
}

function pushAccount(syncId: string, name: string) {
  return [{
    ledger_id: 'L1', entity_type: 'account', entity_sync_id: syncId, action: 'upsert',
    payload: { syncId, name, type: 'cash', currency: 'CNY' },
    updated_at: new Date().toISOString(),
  }];
}

function pushTx(syncId: string, payload: Record<string, unknown>, updatedAt?: string) {
  return [{
    ledger_id: 'L1', entity_type: 'transaction', entity_sync_id: syncId, action: 'upsert',
    payload: { syncId, type: 'expense', amount: 10, happenedAt: new Date().toISOString(), ...payload },
    updated_at: updatedAt ?? new Date().toISOString(),
  }];
}

function getTx(syncId: string) {
  return sqlite.prepare('SELECT * FROM read_tx_projection WHERE ledger_id = ? AND sync_id = ?')
    .get('ledger-1', syncId) as { account_sync_id: string | null; account_name: string | null; amount: number } | undefined;
}

describe('tx account_syncid 按名补全(移植上游 test_tx_account_syncid_fallback.py)', () => {
  it('mobile push:只带 accountName 不带 accountId → 补全为唯一同名账户 sync_id', async () => {
    await push(pushAccount('acc1', '微信余额'));
    await push(pushTx('tx-name-only', { accountName: '微信余额' })); // 无 accountId

    const tx = getTx('tx-name-only');
    expect(tx?.account_name).toBe('微信余额');
    expect(tx?.account_sync_id).toBe('acc1');
  });

  it('web write:只带 account_name 不带 account_id → 补全为唯一同名账户 sync_id', async () => {
    await push(pushAccount('wacc1', '支付宝'));
    const res = await app.request('/api/v1/write/ledgers/L1/transactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base_change_id: 0, tx_type: 'expense', amount: 99, happened_at: '2026-05-01T00:00:00Z', account_name: '支付宝' }),
    }, { DB: db } as any);
    expect(res.status).toBe(200);
    const syncId = (await res.json() as any).entity_id as string;

    const tx = getTx(syncId);
    expect(tx?.account_name).toBe('支付宝');
    expect(tx?.account_sync_id).toBe('wacc1');
  });

  it('同名两账户:按名补全不确定 → 保持 NULL(与上游一致)', async () => {
    await push([...pushAccount('dup1', '现金'), ...pushAccount('dup2', '现金')]);
    await push(pushTx('tx-ambig', { accountName: '现金' }));

    const tx = getTx('tx-ambig');
    expect(tx?.account_name).toBe('现金');
    expect(tx?.account_sync_id).toBeNull();
  });

  it('partial update 只改 amount:已有 account_sync_id 不被清除(与上游一致)', async () => {
    await push([...pushAccount('kacc1', '银行卡'), ...pushTx('tx-keep', { accountId: 'kacc1', accountName: '银行卡', amount: 50 })]);
    const before = getTx('tx-keep');
    expect(before?.account_sync_id).toBe('kacc1');

    await push(pushTx('tx-keep', { amount: 99 }, new Date(Date.now() + 2000).toISOString()));
    const after = getTx('tx-keep');
    expect(after?.amount).toBe(99);
    expect(after?.account_sync_id).toBe('kacc1');
  });

  it('transfer 只带 from/to 名 → 各自补全为唯一同名账户需两个不同账户', async () => {
    await push([...pushAccount('src', '现金账户'), ...pushAccount('dst', '储蓄账户')]);
    await push([{
      ledger_id: 'L1', entity_type: 'transaction', entity_sync_id: 'tx-xfer', action: 'upsert',
      payload: { syncId: 'tx-xfer', type: 'transfer', amount: 200, happenedAt: new Date().toISOString(), fromAccountName: '现金账户', toAccountName: '储蓄账户' },
      updated_at: new Date().toISOString(),
    }]);

    const tx = sqlite.prepare('SELECT from_account_sync_id, to_account_sync_id, from_account_name, to_account_name FROM read_tx_projection WHERE ledger_id = ? AND sync_id = ?')
      .get('ledger-1', 'tx-xfer') as { from_account_sync_id: string | null; to_account_sync_id: string | null; from_account_name: string | null; to_account_name: string | null };
    expect(tx.from_account_sync_id).toBe('src');
    expect(tx.to_account_sync_id).toBe('dst');
  });
});