import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { Hono } from 'hono';
import syncRouter from '../../src/routes/sync';
import { TEST_DEVICE_ID } from '../helpers/test-env';

// 真实 SQLite 验证 normalize 全链路（PR #2 教训：mock-db 不求值真实 SQL——
// SUM/CASE/INSERT 语义与生产 D1 不一致，本测试用 node:sqlite 真值求值）。
let sqlite: DatabaseSync;
let db: D1Database;
let app: Hono<{ Bindings: { DB: D1Database; NODE_ENV?: string }; Variables: { userId: string } }>;

beforeEach(async () => {
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
      currency_code TEXT, native_amount REAL, transfer_to_amount REAL,
      exclude_from_stats INTEGER DEFAULT 0, exclude_from_budget INTEGER DEFAULT 0,
      PRIMARY KEY (ledger_id, sync_id)
    );
    CREATE TABLE user_account_projection (sync_id TEXT PRIMARY KEY, user_id TEXT, name TEXT, account_type TEXT, currency TEXT);
    CREATE TABLE user_category_projection (sync_id TEXT PRIMARY KEY, user_id TEXT, name TEXT, kind TEXT, level INTEGER);
    CREATE TABLE user_tag_projection (sync_id TEXT PRIMARY KEY, user_id TEXT, name TEXT, color TEXT, source_change_id INTEGER);
    CREATE TABLE audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, ledger_id TEXT, action TEXT, metadata_json TEXT, created_at TEXT);
  `);

  db = {
    prepare(sql: string) {
      const statement = sqlite.prepare(sql);
      let params: SQLInputValue[] = [];
      return {
        bind(...values: SQLInputValue[]) { params = values; return this; },
        async run() {
          const r = statement.run(...params);
          return { meta: { last_row_id: Number(r.lastInsertRowid), changes: r.changes } };
        },
        async first<T = unknown>() {
          const row = statement.get(...params) as T | undefined;
          return row ?? null;
        },
        async all<T = unknown>() {
          return { results: statement.all(...params) as T[] };
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

  await db.prepare('INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)')
    .bind('user-1', 'realsql@example.com', 'x').run();
  await db.prepare('INSERT INTO ledgers (id, user_id, external_id, name, currency) VALUES (?, ?, ?, ?, ?)')
    .bind('ledger-1', 'user-1', 'ledger-1', 'Real SQL Ledger', 'CNY').run();
  await db.prepare('INSERT INTO ledger_members (ledger_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)')
    .bind('ledger-1', 'user-1', 'owner', new Date().toISOString()).run();
  await db.prepare('INSERT INTO devices (id, user_id, name, platform, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(TEST_DEVICE_ID, 'user-1', 'test', 'test', new Date().toISOString()).run();

  app = new Hono<{ Bindings: { DB: D1Database; NODE_ENV?: string }; Variables: { userId: string } }>();
  app.use('*', async (c, next) => {
    c.set('userId', 'user-1');
    await next();
  });
  app.route('/api/v1/sync', syncRouter);
});

afterEach(() => sqlite.close());

async function pushTx(payload: Record<string, unknown>) {
  const syncId = crypto.randomUUID();
  const res = await app.request('/api/v1/sync/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Device-ID': TEST_DEVICE_ID },
    body: JSON.stringify({
      device_id: TEST_DEVICE_ID,
      changes: [{
        ledger_id: 'ledger-1',
        entity_type: 'transaction',
        entity_sync_id: syncId,
        action: 'upsert',
        payload,
        updated_at: new Date().toISOString(),
      }],
    }),
  }, { DB: db, NODE_ENV: 'test' });
  expect(res.status).toBe(200);
  return syncId;
}

function projection(syncId: string): Record<string, unknown> {
  return sqlite.prepare(
    'SELECT tx_type, account_sync_id, account_name, from_account_sync_id, from_account_name, to_account_sync_id, to_account_name FROM read_tx_projection WHERE sync_id = ?'
  ).get(syncId) as Record<string, unknown>;
}

describe('Sync push 交易账户字段规范化（真实 SQLite）', () => {
  it('expense 带转账字段 → from/to 真实清空、单账户保留', async () => {
    const syncId = await pushTx({
      tx_type: 'expense', amount: 10, happened_at: '2025-01-15T10:00:00.000Z',
      accountName: '现金',
      fromAccountId: 'from-1', fromAccountName: '旧转账A',
      toAccountId: 'to-1', toAccountName: '旧转账B',
    });
    const row = projection(syncId);
    expect(row.tx_type).toBe('expense');
    expect(row.account_name).toBe('现金');
    expect(row.from_account_sync_id).toBeNull();
    expect(row.from_account_name).toBeNull();
    expect(row.to_account_sync_id).toBeNull();
    expect(row.to_account_name).toBeNull();
  });

  it('transfer 带单账户字段 → account 真实清空、from/to 保留', async () => {
    const syncId = await pushTx({
      tx_type: 'transfer', amount: 10, happened_at: '2025-01-15T10:00:00.000Z',
      accountId: 'acc-1', accountName: '现金',
      fromAccountId: 'from-1', toAccountId: 'to-1',
    });
    const row = projection(syncId);
    expect(row.tx_type).toBe('transfer');
    expect(row.account_sync_id).toBeNull();
    expect(row.account_name).toBeNull();
    expect(row.from_account_sync_id).toBe('from-1');
    expect(row.to_account_sync_id).toBe('to-1');
  });

  it('合并已有转账行改为 expense 后旧 from/to 不残留（partial merge 场景）', async () => {
    // 先作为 transfer 写入（保留 from/to）
    const syncId = await pushTx({
      tx_type: 'transfer', amount: 10, happened_at: '2025-01-15T10:00:00.000Z',
      fromAccountId: 'from-1', toAccountId: 'to-1',
    });
    let row = projection(syncId);
    expect(row.from_account_sync_id).toBe('from-1');
    expect(row.to_account_sync_id).toBe('to-1');

    // 第二台设备把同一条改成 expense（partial payload 不带任何账户字段）
    await db.prepare('INSERT INTO devices (id, user_id, name, platform, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind('device-2', 'user-1', 'test', 'test', new Date().toISOString()).run();
    const res = await app.request('/api/v1/sync/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Device-ID': 'device-2' },
      body: JSON.stringify({
        device_id: 'device-2',
        changes: [{
          ledger_id: 'ledger-1',
          entity_type: 'transaction',
          entity_sync_id: syncId,
          action: 'upsert',
          payload: { tx_type: 'expense', amount: 12, happened_at: '2025-01-15T10:00:00.000Z', accountName: '微信' },
          updated_at: new Date().toISOString(),
        }],
      }),
    }, { DB: db, NODE_ENV: 'test' });
    expect(res.status).toBe(200);

    row = projection(syncId);
    expect(row.tx_type).toBe('expense');
    expect(row.account_name).toBe('微信');
    // 旧转账关联必须被清掉，不能残留
    expect(row.from_account_sync_id).toBeNull();
    expect(row.from_account_name).toBeNull();
    expect(row.to_account_sync_id).toBeNull();
    expect(row.to_account_name).toBeNull();
  });
});