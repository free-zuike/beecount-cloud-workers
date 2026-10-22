// 移植上游 tests/test_projection_consistency.py(14 例):
// mobile /sync/push 与 web /write 两条路径各自打一发,断言 projection 表与
// 快照关键字段一致:tx 投影 create/delete、account/category/tag 改名级联、
// web 创建/删除 tx、web 删账本清投影、混合写入后投影计数、跨账本隔离、
// budget 创建与增量 merge 保字段、混合 5 实体批量 push。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import syncRouter from '../src/routes/sync';
import writeRouter from '../src/routes/write';

let sqlite: DatabaseSync;
let db: D1Database;
let app: Hono<{ Bindings: { DB: D1Database }; Variables: { userId: string } }>;

const USER = 'user-1';

function iso(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL);
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
    CREATE TABLE attachment_files (
      id TEXT PRIMARY KEY, ledger_id TEXT, user_id TEXT, sha256 TEXT, size_bytes INTEGER,
      mime_type TEXT, file_name TEXT, storage_path TEXT, attachment_kind TEXT, created_at TEXT
    );
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

  sqlite.prepare("INSERT INTO users (id, email, password_hash) VALUES (?, 'proj@x.com', 'x')").run(USER);
  sqlite.prepare("INSERT INTO devices (id, user_id, name, platform, created_at) VALUES ('d1', ?, 'd1', 'test', '2025-01-01T00:00:00Z')").run(USER);
  sqlite.prepare("INSERT INTO ledgers (id, user_id, external_id, name, currency, created_at) VALUES ('lg1', ?, 'L1', 'L1', 'CNY', '2025-01-01T00:00:00Z')").run(USER);
  sqlite.prepare("INSERT INTO ledger_members (ledger_id, user_id, role, joined_at) VALUES ('lg1', ?, 'owner', '2025-01-01T00:00:00Z')").run(USER);

  app = new Hono<{ Bindings: { DB: D1Database }; Variables: { userId: string } }>();
  app.use('*', async (c, next) => {
    c.set('userId', USER);
    await next();
  });
  app.route('/api/v1/sync', syncRouter);
  app.route('/api/v1/write', writeRouter);
});

afterEach(() => sqlite.close());

async function push(ledgerExt: string, changes: Array<Record<string, unknown>>) {
  const res = await app.request('/api/v1/sync/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Device-ID': 'd1', 'CF-Connecting-IP': '127.0.0.1' },
    body: JSON.stringify({ device_id: 'd1', changes }),
  }, { DB: db } as any);
  expect(res.status).toBe(200);
  return res;
}

function txRow(ledgerId: string, syncId: string): Record<string, unknown> | undefined {
  return sqlite.prepare('SELECT * FROM read_tx_projection WHERE ledger_id = ? AND sync_id = ?').get(ledgerId, syncId) as any;
}

describe('mobile push 投影一致性(移植上游 test_projection_consistency.py)', () => {
  it('push tx 创建投影行:字段完整落表', async () => {
    await push('L1', [
      { ledger_id: 'L1', entity_type: 'account', entity_sync_id: 'acc1', action: 'upsert', updated_at: iso(),
        payload: { syncId: 'acc1', name: 'Cash', type: 'cash', currency: 'CNY' } },
      { ledger_id: 'L1', entity_type: 'transaction', entity_sync_id: 'tx1', action: 'upsert', updated_at: iso(),
        payload: { syncId: 'tx1', type: 'expense', amount: 12.5, happenedAt: iso(), note: 'coffee',
                   accountId: 'acc1', accountName: 'Cash' } },
    ]);
    const tx = txRow('lg1', 'tx1');
    expect(tx).toBeDefined();
    expect(tx!.tx_type).toBe('expense');
    expect(tx!.amount).toBe(12.5);
    expect(tx!.note).toBe('coffee');
    expect(tx!.account_sync_id).toBe('acc1');
    expect(tx!.account_name).toBe('Cash');
    const acc = sqlite.prepare('SELECT * FROM user_account_projection WHERE user_id = ? AND sync_id = ?').get(USER, 'acc1') as any;
    expect(acc).toBeDefined();
    expect(acc.name).toBe('Cash');
  });

  it('push tx delete 移除投影行', async () => {
    await push('L1', [
      { ledger_id: 'L1', entity_type: 'transaction', entity_sync_id: 'tx1', action: 'upsert', updated_at: iso(),
        payload: { syncId: 'tx1', type: 'income', amount: 100, happenedAt: iso() } },
    ]);
    expect(txRow('lg1', 'tx1')).toBeDefined();
    await push('L1', [
      { ledger_id: 'L1', entity_type: 'transaction', entity_sync_id: 'tx1', action: 'delete', updated_at: iso(5000), payload: {} },
    ]);
    expect(txRow('lg1', 'tx1')).toBeUndefined();
  });

  it('account 改名级联刷新 tx 投影 account_name', async () => {
    await push('L1', [
      { ledger_id: 'L1', entity_type: 'account', entity_sync_id: 'a1', action: 'upsert', updated_at: iso(),
        payload: { syncId: 'a1', name: '招商', type: 'bank_card', currency: 'CNY' } },
      { ledger_id: 'L1', entity_type: 'transaction', entity_sync_id: 't1', action: 'upsert', updated_at: iso(),
        payload: { syncId: 't1', type: 'expense', amount: 5, happenedAt: iso(), accountId: 'a1', accountName: '招商' } },
    ]);
    await push('L1', [
      { ledger_id: 'L1', entity_type: 'account', entity_sync_id: 'a1', action: 'upsert', updated_at: iso(2000),
        payload: { syncId: 'a1', name: '招商银行', type: 'bank_card', currency: 'CNY' } },
    ]);
    const tx = txRow('lg1', 't1');
    expect(tx!.account_name).toBe('招商银行');
    const acc = sqlite.prepare('SELECT name FROM user_account_projection WHERE user_id = ? AND sync_id = ?').get(USER, 'a1') as any;
    expect(acc.name).toBe('招商银行');
  });

  it('category 改名级联刷新 tx 投影 category_name', async () => {
    await push('L1', [
      { ledger_id: 'L1', entity_type: 'category', entity_sync_id: 'c1', action: 'upsert', updated_at: iso(),
        payload: { syncId: 'c1', name: '餐饮', kind: 'expense' } },
      { ledger_id: 'L1', entity_type: 'transaction', entity_sync_id: 't1', action: 'upsert', updated_at: iso(),
        payload: { syncId: 't1', type: 'expense', amount: 5, happenedAt: iso(), categoryId: 'c1', categoryName: '餐饮', categoryKind: 'expense' } },
    ]);
    await push('L1', [
      { ledger_id: 'L1', entity_type: 'category', entity_sync_id: 'c1', action: 'upsert', updated_at: iso(2000),
        payload: { syncId: 'c1', name: '吃饭', kind: 'expense' } },
    ]);
    const tx = txRow('lg1', 't1');
    expect(tx!.category_name).toBe('吃饭');
  });

  it('tag 改名级联刷新 tx 投影 tags_csv', async () => {
    await push('L1', [
      { ledger_id: 'L1', entity_type: 'tag', entity_sync_id: 'g1', action: 'upsert', updated_at: iso(),
        payload: { syncId: 'g1', name: 'A' } },
      { ledger_id: 'L1', entity_type: 'transaction', entity_sync_id: 't1', action: 'upsert', updated_at: iso(),
        payload: { syncId: 't1', type: 'expense', amount: 5, happenedAt: iso(), tags: 'A', tagIds: ['g1'] } },
    ]);
    await push('L1', [
      { ledger_id: 'L1', entity_type: 'tag', entity_sync_id: 'g1', action: 'upsert', updated_at: iso(2000),
        payload: { syncId: 'g1', name: 'B' } },
    ]);
    const tx = txRow('lg1', 't1');
    expect(tx!.tags_csv).toBe('B');
  });

  it('tag 改名级联:tx 只有 tag 名无 tagIds(issue #5 回归)', async () => {
    await push('L1', [
      { ledger_id: 'L1', entity_type: 'tag', entity_sync_id: 'g1', action: 'upsert', updated_at: iso(),
        payload: { syncId: 'g1', name: '旧标签' } },
      { ledger_id: 'L1', entity_type: 'transaction', entity_sync_id: 't1', action: 'upsert', updated_at: iso(),
        payload: { syncId: 't1', type: 'expense', amount: 5, happenedAt: iso(), tags: '旧标签' } },
    ]);
    await push('L1', [
      { ledger_id: 'L1', entity_type: 'tag', entity_sync_id: 'g1', action: 'upsert', updated_at: iso(2000),
        payload: { syncId: 'g1', name: '新标签' } },
    ]);
    const tx = txRow('lg1', 't1');
    expect(tx!.tags_csv).toBe('新标签');
  });

  it('budget 创建写入 read_budget_projection', async () => {
    await push('L1', [
      { ledger_id: 'L1', entity_type: 'budget', entity_sync_id: 'bud1', action: 'upsert', updated_at: iso(),
        payload: { syncId: 'bud1', type: 'total', amount: 500.0, period: 'monthly', startDay: 1, enabled: true } },
    ]);
    const b = sqlite.prepare('SELECT * FROM read_budget_projection WHERE ledger_id = ? AND sync_id = ?').get('lg1', 'bud1') as any;
    expect(b).toBeDefined();
    expect(b.budget_type).toBe('total');
    expect(b.amount).toBe(500.0);
    expect(b.period).toBe('monthly');
    expect(b.start_day).toBe(1);
    expect(b.enabled).toBe(1);
  });

  it('budget 增量 update 保留旧字段(merge 契约)', async () => {
    await push('L1', [
      { ledger_id: 'L1', entity_type: 'budget', entity_sync_id: 'bud1', action: 'upsert', updated_at: iso(),
        payload: { syncId: 'bud1', type: 'category', categoryId: 'cat-x', amount: 300.0, period: 'monthly', startDay: 5, enabled: true } },
    ]);
    await push('L1', [
      { ledger_id: 'L1', entity_type: 'budget', entity_sync_id: 'bud1', action: 'upsert', updated_at: iso(2000),
        payload: { syncId: 'bud1', amount: 700.0 } },
    ]);
    const b = sqlite.prepare('SELECT * FROM read_budget_projection WHERE ledger_id = ? AND sync_id = ?').get('lg1', 'bud1') as any;
    expect(b.amount).toBe(700.0);
    expect(b.budget_type).toBe('category');
    expect(b.category_sync_id).toBe('cat-x');
    expect(b.period).toBe('monthly');
    expect(b.start_day).toBe(5);
    expect(b.enabled).toBe(1);
  });

  it('一次 push 混合 5 实体(account/category/tag/budget/tx)全部落投影', async () => {
    await push('L1', [
      { ledger_id: 'L1', entity_type: 'account', entity_sync_id: 'a1', action: 'upsert', updated_at: iso(),
        payload: { syncId: 'a1', name: 'Cash', type: 'cash', currency: 'CNY' } },
      { ledger_id: 'L1', entity_type: 'category', entity_sync_id: 'c1', action: 'upsert', updated_at: iso(),
        payload: { syncId: 'c1', name: 'Food', kind: 'expense' } },
      { ledger_id: 'L1', entity_type: 'tag', entity_sync_id: 'tg1', action: 'upsert', updated_at: iso(),
        payload: { syncId: 'tg1', name: 'work', color: '#F00' } },
      { ledger_id: 'L1', entity_type: 'budget', entity_sync_id: 'bu1', action: 'upsert', updated_at: iso(),
        payload: { syncId: 'bu1', type: 'total', amount: 1000, period: 'monthly', startDay: 1, enabled: true } },
      { ledger_id: 'L1', entity_type: 'transaction', entity_sync_id: 't1', action: 'upsert', updated_at: iso(),
        payload: { syncId: 't1', type: 'expense', amount: 12, happenedAt: iso(), accountId: 'a1', accountName: 'Cash' } },
    ]);
    expect(sqlite.prepare('SELECT 1 FROM user_account_projection WHERE user_id = ? AND sync_id = ?').get(USER, 'a1')).toBeDefined();
    expect(sqlite.prepare('SELECT 1 FROM user_category_projection WHERE user_id = ? AND sync_id = ?').get(USER, 'c1')).toBeDefined();
    expect(sqlite.prepare('SELECT 1 FROM user_tag_projection WHERE user_id = ? AND sync_id = ?').get(USER, 'tg1')).toBeDefined();
    expect(sqlite.prepare('SELECT 1 FROM read_budget_projection WHERE ledger_id = ? AND sync_id = ?').get('lg1', 'bu1')).toBeDefined();
    expect(txRow('lg1', 't1')).toBeDefined();
  });

  it('混合写入(3 create + 1 delete)后投影计数与快照一致', async () => {
    for (let i = 1; i <= 3; i++) {
      await push('L1', [
        { ledger_id: 'L1', entity_type: 'transaction', entity_sync_id: `tx${i}`, action: 'upsert', updated_at: iso(),
          payload: { syncId: `tx${i}`, type: 'expense', amount: i * 10.0, happenedAt: iso() } },
      ]);
    }
    await push('L1', [
      { ledger_id: 'L1', entity_type: 'transaction', entity_sync_id: 'tx2', action: 'delete', updated_at: iso(2000), payload: {} },
    ]);
    const ids = (sqlite.prepare('SELECT sync_id FROM read_tx_projection WHERE ledger_id = ?').all('lg1') as unknown as Array<{ sync_id: string }>).map(r => r.sync_id);
    expect(new Set(ids)).toEqual(new Set(['tx1', 'tx3']));
  });

  it('投影按 ledger 隔离:两个账本同 sync_id 互不混淆', async () => {
    sqlite.prepare("INSERT INTO ledgers (id, user_id, external_id, name, currency, created_at) VALUES ('lga', ?, 'LA', 'LA', 'CNY', '2025-01-01T00:00:00Z')").run(USER);
    sqlite.prepare("INSERT INTO ledger_members (ledger_id, user_id, role, joined_at) VALUES ('lga', ?, 'owner', '2025-01-01T00:00:00Z')").run(USER);
    await push('LA', [
      { ledger_id: 'LA', entity_type: 'transaction', entity_sync_id: 'tx1', action: 'upsert', updated_at: iso(),
        payload: { syncId: 'tx1', type: 'expense', amount: 1, happenedAt: iso() } },
    ]);
    sqlite.prepare("INSERT INTO ledgers (id, user_id, external_id, name, currency, created_at) VALUES ('lgb', ?, 'LB', 'LB', 'CNY', '2025-01-01T00:00:00Z')").run(USER);
    sqlite.prepare("INSERT INTO ledger_members (ledger_id, user_id, role, joined_at) VALUES ('lgb', ?, 'owner', '2025-01-01T00:00:00Z')").run(USER);
    await push('LB', [
      { ledger_id: 'LB', entity_type: 'transaction', entity_sync_id: 'tx1', action: 'upsert', updated_at: iso(),
        payload: { syncId: 'tx1', type: 'income', amount: 2, happenedAt: iso() } },
    ]);
    const a = txRow('lga', 'tx1');
    const b = txRow('lgb', 'tx1');
    expect(a!.tx_type).toBe('expense');
    expect(a!.amount).toBe(1);
    expect(b!.tx_type).toBe('income');
    expect(b!.amount).toBe(2);
  });
});

describe('web /write 投影一致性(移植上游 test_projection_consistency.py)', () => {
  it('web 创建 tx 落投影行(带 category id+name)', async () => {
    const createLedger = await app.request('/api/v1/write/ledgers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Device-ID': 'web' },
      body: JSON.stringify({ ledger_id: 'wlg1', ledger_name: 'WebLedger', currency: 'CNY' }),
    }, { DB: db } as any);
    expect(createLedger.status).toBe(200);
    const ledBody = await createLedger.json() as any;
    const base0 = ledBody.new_change_id as number;

    const catRes = await app.request('/api/v1/write/ledgers/wlg1/categories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Device-ID': 'web' },
      body: JSON.stringify({ base_change_id: base0, name: 'Food', kind: 'expense' }),
    }, { DB: db } as any);
    expect(catRes.status).toBe(200);
    const catBody = await catRes.json() as any;
    const catId = catBody.entity_id as string;
    const base1 = catBody.new_change_id as number;

    const txRes = await app.request('/api/v1/write/ledgers/wlg1/transactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Device-ID': 'web' },
      body: JSON.stringify({
        base_change_id: base1, tx_type: 'expense', amount: 9.99, happened_at: iso(),
        note: 'web tx', category_id: catId, category_name: 'Food', category_kind: 'expense',
      }),
    }, { DB: db } as any);
    expect(txRes.status).toBe(200);
    const txBody = await txRes.json() as any;
    const txId = txBody.entity_id as string;

    const lid = (sqlite.prepare('SELECT id FROM ledgers WHERE external_id = ?').get('wlg1') as any).id;
    const tx = txRow(lid, txId);
    expect(tx).toBeDefined();
    expect(tx!.amount).toBe(9.99);
    expect(tx!.note).toBe('web tx');
    expect(tx!.category_sync_id).toBe(catId);
    expect(tx!.category_name).toBe('Food');
    const cat = sqlite.prepare('SELECT name FROM user_category_projection WHERE user_id = ? AND sync_id = ?').get(USER, catId) as any;
    expect(cat.name).toBe('Food');
  });

  it('web 删除 tx 移除投影行', async () => {
    const createLedger = await app.request('/api/v1/write/ledgers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Device-ID': 'web' },
      body: JSON.stringify({ ledger_id: 'wlg2', ledger_name: 'L', currency: 'CNY' }),
    }, { DB: db } as any);
    const ledBody = await createLedger.json() as any;
    const base0 = ledBody.new_change_id as number;
    const txRes = await app.request('/api/v1/write/ledgers/wlg2/transactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Device-ID': 'web' },
      body: JSON.stringify({ base_change_id: base0, tx_type: 'income', amount: 1, happened_at: iso() }),
    }, { DB: db } as any);
    const txBody = await txRes.json() as any;
    const txId = txBody.entity_id as string;
    const base1 = txBody.new_change_id as number;
    const lid = (sqlite.prepare('SELECT id FROM ledgers WHERE external_id = ?').get('wlg2') as any).id;
    expect(txRow(lid, txId)).toBeDefined();

    const del = await app.request(`/api/v1/write/ledgers/wlg2/transactions/${txId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', 'X-Device-ID': 'web' },
      body: JSON.stringify({ base_change_id: base1 }),
    }, { DB: db } as any);
    expect(del.status).toBe(200);
    expect(txRow(lid, txId)).toBeUndefined();
  });

  it('web 删账本清空该账本投影', async () => {
    const createLedger = await app.request('/api/v1/write/ledgers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Device-ID': 'web' },
      body: JSON.stringify({ ledger_id: 'wlg3', ledger_name: 'L', currency: 'CNY' }),
    }, { DB: db } as any);
    const ledBody = await createLedger.json() as any;
    const base0 = ledBody.new_change_id as number;
    const txRes = await app.request('/api/v1/write/ledgers/wlg3/transactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Device-ID': 'web' },
      body: JSON.stringify({ base_change_id: base0, tx_type: 'income', amount: 1, happened_at: iso() }),
    }, { DB: db } as any);
    expect(txRes.status).toBe(200);
    const lid = (sqlite.prepare('SELECT id FROM ledgers WHERE external_id = ?').get('wlg3') as any).id;
    expect(sqlite.prepare('SELECT 1 FROM read_tx_projection WHERE ledger_id = ?').get(lid)).toBeDefined();

    const del = await app.request('/api/v1/write/ledgers/wlg3', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', 'X-Device-ID': 'web' },
    }, { DB: db } as any);
    expect(del.status).toBe(200);
    expect(sqlite.prepare('SELECT 1 FROM read_tx_projection WHERE ledger_id = ?').get(lid)).toBeUndefined();
  });
});