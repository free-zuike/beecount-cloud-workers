import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import syncRouter from '../src/routes/sync';
import workspaceRouter from '../src/routes/workspace';

// 移植上游 tests/test_account_hidden_sync.py(push/merge/full/读侧):
// - account push 带 hidden → 落 user_account_projection.hidden;
// - 缺键默认 False;partial update 不带 hidden 键保留原值(merge 契约);
// - 显式 hidden=False 正常覆盖;
// - pull 原样透传 hidden;
// - /read/ledgers/{id}/accounts 与 /read/workspace/accounts 带 hidden,
//   且隐藏账户仍计入统计(balance=70)。
let sqlite: DatabaseSync;
let db: D1Database;
let app: Hono<{ Bindings: { DB: D1Database }; Variables: { userId: string } }>;

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, is_admin BOOLEAN DEFAULT 0);
    CREATE TABLE ledgers (id TEXT PRIMARY KEY, user_id TEXT, external_id TEXT, name TEXT, currency TEXT, month_start_day INTEGER DEFAULT 1, created_at TEXT);
    CREATE TABLE ledger_members (ledger_id TEXT, user_id TEXT, role TEXT, joined_at TEXT);
    CREATE TABLE devices (id TEXT PRIMARY KEY, user_id TEXT, name TEXT, platform TEXT, app_version TEXT, os_version TEXT, device_model TEXT, last_ip TEXT, last_seen_at TEXT, revoked_at TEXT, created_at TEXT);
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
    CREATE TABLE read_budget_projection (ledger_id TEXT, sync_id TEXT, user_id TEXT, budget_type TEXT, category_sync_id TEXT, amount REAL, period TEXT, start_day INTEGER, enabled INTEGER DEFAULT 1);
    CREATE TABLE user_account_projection (
      sync_id TEXT PRIMARY KEY, user_id TEXT, name TEXT, account_type TEXT, currency TEXT,
      initial_balance REAL DEFAULT 0, note TEXT, credit_limit REAL, billing_day INTEGER, payment_due_day INTEGER,
      bank_name TEXT, card_last_four TEXT, hidden INTEGER DEFAULT 0, source_change_id INTEGER DEFAULT 0
    );
    CREATE TABLE user_category_projection (sync_id TEXT PRIMARY KEY, user_id TEXT, name TEXT, kind TEXT, level INTEGER);
    CREATE TABLE user_tag_projection (sync_id TEXT PRIMARY KEY, user_id TEXT, name TEXT, color TEXT, source_change_id INTEGER);
    CREATE TABLE audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, ledger_id TEXT, action TEXT, metadata_json TEXT, created_at TEXT);
  `);

  db = {
    prepare(sql: string) {
      const statement = sqlite.prepare(sql);
      // D1 接受 boolean 绑定(SQLite 不支持),测试包装统一转 0/1 保持语义一致
      const normalize = (v: unknown): unknown => (typeof v === 'boolean' ? (v ? 1 : 0) : v);
      let params: unknown[] = [];
      return {
        bind(...values: unknown[]) { params = values.map(normalize); return this; },
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

  sqlite.prepare("INSERT INTO users (id, email, password_hash, is_admin) VALUES ('user-1', 'h@x.com', 'x', 0)").run();
  sqlite.prepare("INSERT INTO ledgers (id, user_id, external_id, name, currency, created_at) VALUES ('ledger-1', 'user-1', 'lg1', '账本', 'CNY', '2025-01-01T00:00:00Z')").run();
  sqlite.prepare("INSERT INTO ledger_members (ledger_id, user_id, role, joined_at) VALUES ('ledger-1', 'user-1', 'owner', '2025-01-01T00:00:00Z')").run();
  sqlite.prepare("INSERT INTO devices (id, user_id, name, platform, created_at) VALUES ('d1', 'user-1', 'd', 'app', '2025-01-01T00:00:00Z')").run();

  app = new Hono<{ Bindings: { DB: D1Database }; Variables: { userId: string } }>();
  app.use('*', async (c, next) => {
    c.set('userId', 'user-1');
    await next();
  });
  app.route('/api/v1/sync', syncRouter);
  app.route('/api/v1/read/workspace', workspaceRouter);
});

afterEach(() => sqlite.close());

async function pushAccount(payload: Record<string, unknown>, action: 'upsert' | 'delete' = 'upsert') {
  const res = await app.request('/api/v1/sync/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Device-ID': 'd1' },
    body: JSON.stringify({
      device_id: 'd1',
      changes: [{
        ledger_id: 'lg1',
        entity_type: 'account',
        entity_sync_id: payload.syncId,
        action,
        payload,
        updated_at: new Date().toISOString(),
      }],
    }),
  }, { DB: db });
  expect(res.status).toBe(200);
  return await res.json() as Record<string, unknown>;
}

function accountRow(syncId: string): Record<string, unknown> {
  return sqlite.prepare('SELECT name, hidden FROM user_account_projection WHERE sync_id = ?').get(syncId) as Record<string, unknown>;
}

describe('账户 hidden 同步(移植上游 test_account_hidden_sync.py 侧)', () => {
  it('push hidden=True → 落投影 hidden;缺键默认 False', async () => {
    await pushAccount({ syncId: 'acc-1', name: '旧卡', type: 'cash', currency: 'CNY', hidden: true });
    expect(accountRow('acc-1').hidden).toBe(1);
    await pushAccount({ syncId: 'acc-2', name: '新卡', type: 'cash', currency: 'CNY' });
    expect(accountRow('acc-2').hidden).toBe(0);
  });

  it('partial update 不带 hidden 键保留原值;显式 hidden=False 正常覆盖', async () => {
    await pushAccount({ syncId: 'acc-3', name: '旧卡', type: 'cash', currency: 'CNY', hidden: true });
    await pushAccount({ syncId: 'acc-3', name: '旧卡改名' });
    expect(accountRow('acc-3').name).toBe('旧卡改名');
    expect(accountRow('acc-3').hidden).toBe(1);

    await pushAccount({ syncId: 'acc-4', name: '旧卡', type: 'cash', currency: 'CNY', hidden: true });
    await pushAccount({ syncId: 'acc-4', name: '旧卡', hidden: false });
    expect(accountRow('acc-4').hidden).toBe(0);
  });

  it('pull 原样透传 hidden', async () => {
    await pushAccount({ syncId: 'acc-5', name: '旧卡', type: 'cash', currency: 'CNY', hidden: true });
    const res = await app.request('/api/v1/sync/pull?since=0', { headers: { 'X-Device-ID': 'd1' } }, { DB: db });
    expect(res.status).toBe(200);
    const changes = (await res.json() as any).changes as any[];
    const acc = changes.filter((c: any) => c.entity_sync_id === 'acc-5');
    expect(acc.length).toBe(1);
    expect(acc[0].payload.hidden).toBe(true);
  });

  it('/read/workspace/accounts 带 hidden 且不筛统计(balance=70,tx_count=1)', async () => {
    await pushAccount({ syncId: 'acc-w1', name: '隐藏卡', type: 'cash', currency: 'CNY', initialBalance: 100.0, hidden: true });
    await app.request('/api/v1/sync/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Device-ID': 'd1' },
      body: JSON.stringify({
        device_id: 'd1',
        changes: [{
          ledger_id: 'lg1', entity_type: 'transaction', entity_sync_id: 'tx-w1', action: 'upsert',
          payload: { syncId: 'tx-w1', type: 'expense', amount: 30.0, happenedAt: new Date().toISOString(), accountId: 'acc-w1', accountName: '隐藏卡' },
          updated_at: new Date().toISOString(),
        }],
      }),
    }, { DB: db });

    const res = await app.request('/api/v1/read/workspace/accounts', {}, { DB: db });
    expect(res.status).toBe(200);
    const accs = await res.json() as any[];
    const acc = accs.find((a: any) => a.id === 'acc-w1');
    expect(acc).toBeTruthy();
    expect(acc.hidden).toBe(true);
    expect(acc.expense_total).toBe(30);
    expect(acc.balance).toBe(70);
    expect(acc.tx_count).toBe(1);
  });
});