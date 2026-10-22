import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import syncRouter from '../src/routes/sync';
import readRouter from '../src/routes/read';

// 移植上游 tests/test_tx_read_id_resolution.py(P1.1 按 id 解析当前名):
// 本地投影同时存名称与 id,read 直接输出存储时点的名字 —— 实体改名不反写
// tx 列表(上游按 tagIds/accountId 解析当前名,差异见用例);legacy 无 id
// 回退存储名、id 找不到回退存储名两条结果与上游一致。
let sqlite: DatabaseSync;
let db: D1Database;
let app: Hono<{ Bindings: any; Variables: { userId: string } }>;

const USER = 'user-1';

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL);
    CREATE TABLE ledgers (id TEXT PRIMARY KEY, user_id TEXT, external_id TEXT, name TEXT, currency TEXT);
    CREATE TABLE ledger_members (ledger_id TEXT, user_id TEXT, role TEXT, joined_at TEXT);
    CREATE TABLE devices (id TEXT PRIMARY KEY, user_id TEXT, name TEXT, platform TEXT, last_seen_at TEXT, last_ip TEXT, revoked_at TEXT, created_at TEXT);
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

  sqlite.prepare("INSERT INTO users (id, email, password_hash) VALUES ('user-1', 'rid@x.com', 'x')").run();
  sqlite.prepare("INSERT INTO ledgers (id, user_id, external_id, name, currency) VALUES ('ledger-1', 'user-1', 'L1', 'L1', 'CNY')").run();
  sqlite.prepare("INSERT INTO ledger_members (ledger_id, user_id, role, joined_at) VALUES ('ledger-1', 'user-1', 'owner', '2025-01-01T00:00:00Z')").run();
  sqlite.prepare("INSERT INTO devices (id, user_id, name, platform, created_at) VALUES ('dev-1', 'user-1', 'dev-1', 'test', '2025-01-01T00:00:00Z')").run();

  app = new Hono<{ Bindings: any; Variables: { userId: string } }>();
  app.use('*', async (c, next) => {
    c.set('userId', USER);
    await next();
  });
  app.route('/api/v1/sync', syncRouter);
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

function upsert(entityType: string, syncId: string, payload: Record<string, unknown>, updatedAt?: string) {
  return {
    ledger_id: 'L1', entity_type: entityType, entity_sync_id: syncId, action: 'upsert',
    payload, updated_at: updatedAt ?? new Date().toISOString(),
  };
}

async function readTxList() {
  const res = await app.request('/api/v1/read/ledgers/L1/transactions', {}, { DB: db } as any);
  expect(res.status).toBe(200);
  const body = await res.json() as any;
  return Array.isArray(body) ? body : body.items;
}

describe('read id 解析(移植上游 test_tx_read_id_resolution.py)', () => {
  it('tag 改名后 tx 列表 tags_list 反映现名(与上游一致;本地为写入时级联,上游为读时解析)', async () => {
    await push([
      upsert('tag', 'tag-alpha', { syncId: 'tag-alpha', name: 'A' }),
      upsert('transaction', 'tx-1', { syncId: 'tx-1', type: 'expense', amount: 10, happenedAt: new Date().toISOString(), note: 'x', tags: 'A', tagIds: ['tag-alpha'] }),
    ]);
    const later = new Date(Date.now() + 2000).toISOString();
    await push([upsert('tag', 'tag-alpha', { syncId: 'tag-alpha', name: 'B' }, later)]);

    const rows = await readTxList();
    const tx = rows.find((r: any) => r.id === 'tx-1');
    expect(tx.tags_list).toEqual(['B']);
  });

  it('account 改名后 tx 列表 account_name 反映现名(与上游一致;本地为写入时级联)', async () => {
    await push([
      upsert('account', 'acc-1', { syncId: 'acc-1', name: '招商', type: 'bank_card', currency: 'CNY' }),
      upsert('transaction', 'tx-2', { syncId: 'tx-2', type: 'expense', amount: 5, happenedAt: new Date().toISOString(), accountName: '招商', accountId: 'acc-1' }),
    ]);
    const later = new Date(Date.now() + 2000).toISOString();
    await push([upsert('account', 'acc-1', { syncId: 'acc-1', name: '招商银行', type: 'bank_card', currency: 'CNY' }, later)]);

    const rows = await readTxList();
    const tx = rows.find((r: any) => r.id === 'tx-2');
    expect(tx.account_name).toBe('招商银行');
  });

  it('legacy tx(无 id)回退到存储名(与上游一致)', async () => {
    await push([
      upsert('transaction', 'tx-3', { syncId: 'tx-3', type: 'expense', amount: 1, happenedAt: new Date().toISOString(), accountName: '现金', categoryName: '餐饮', categoryKind: 'expense', tags: '午餐,外卖' }),
    ]);

    const rows = await readTxList();
    const tx = rows.find((r: any) => r.id === 'tx-3');
    expect(tx.account_name).toBe('现金');
    expect(tx.category_name).toBe('餐饮');
    expect(tx.tags_list).toEqual(['午餐', '外卖']);
  });

  it('tagIds 指向不存在 tag 时回退到存储名(与上游结果一致)', async () => {
    await push([
      upsert('transaction', 'tx-4', { syncId: 'tx-4', type: 'expense', amount: 1, happenedAt: new Date().toISOString(), tags: '历史标签', tagIds: ['tag-nonexistent'] }),
    ]);

    const rows = await readTxList();
    const tx = rows.find((r: any) => r.id === 'tx-4');
    expect(tx.tags_list).toEqual(['历史标签']);
  });
});