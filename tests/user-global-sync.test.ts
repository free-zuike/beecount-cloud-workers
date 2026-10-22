import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import syncRouter from '../src/routes/sync';

// 移植上游 tests/test_user_global_sync.py:
// - category/account/tag push 落 user_*_projection,SyncChange scope='user'、
//   ledger_id NULL、user_id=caller;
// - 老客户端误填 ledger_id → server 忽略,不自动建账本;
// - pull 返回 user-scope 变化(category ledger_id=sentinel,scope=user);
// - account 改名跨全部 ledger 级联刷 read_tx_projection.account_name。
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
    CREATE TABLE user_category_projection (sync_id TEXT PRIMARY KEY, user_id TEXT, name TEXT, kind TEXT, level INTEGER, sort_order INTEGER, icon TEXT, icon_type TEXT, custom_icon_path TEXT, icon_cloud_file_id TEXT, icon_cloud_sha256 TEXT, parent_name TEXT, parent_sync_id TEXT, source_change_id INTEGER DEFAULT 0);
    CREATE TABLE user_tag_projection (sync_id TEXT PRIMARY KEY, user_id TEXT, name TEXT, color TEXT, source_change_id INTEGER);
    CREATE TABLE user_exchange_rate_projection (sync_id TEXT PRIMARY KEY, user_id TEXT, base_currency TEXT, quote_currency TEXT, rate REAL);
    CREATE TABLE audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, ledger_id TEXT, action TEXT, metadata_json TEXT, created_at TEXT);
  `);

  db = {
    prepare(sql: string) {
      const statement = sqlite.prepare(sql);
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

  sqlite.prepare("INSERT INTO users (id, email, password_hash, is_admin) VALUES ('user-1', 'ug@x.com', 'x', 0)").run();
  sqlite.prepare("INSERT INTO devices (id, user_id, name, platform, created_at) VALUES ('d1', 'user-1', 'd', 'app', '2025-01-01T00:00:00Z')").run();

  app = new Hono<{ Bindings: { DB: D1Database }; Variables: { userId: string } }>();
  app.use('*', async (c, next) => {
    c.set('userId', 'user-1');
    await next();
  });
  app.route('/api/v1/sync', syncRouter);
});

afterEach(() => sqlite.close());

async function push(ledgerId: string, entityType: string, syncId: string, payload: Record<string, unknown>) {
  const res = await app.request('/api/v1/sync/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Device-ID': 'd1' },
    body: JSON.stringify({
      device_id: 'd1',
      changes: [{ ledger_id: ledgerId, entity_type: entityType, entity_sync_id: syncId, action: 'upsert', payload, updated_at: new Date().toISOString() }],
    }),
  }, { DB: db });
  expect(res.status).toBe(200);
  return await res.json() as Record<string, unknown>;
}

function changeRow(syncId: string): Record<string, unknown> {
  return sqlite.prepare('SELECT user_id, ledger_id, scope, updated_by_user_id FROM sync_changes WHERE entity_sync_id = ?').get(syncId) as Record<string, unknown>;
}

describe('user-global 同步(移植上游 test_user_global_sync.py)', () => {
  it('category push 落 user_category_projection;SyncChange scope=user、ledger_id NULL、user_id=caller', async () => {
    await push('lg1', 'category', 'cat-food', { syncId: 'cat-food', name: 'Food', kind: 'expense' });
    const row = sqlite.prepare('SELECT name, kind FROM user_category_projection WHERE sync_id = ?').get('cat-food') as Record<string, unknown>;
    expect(row.name).toBe('Food');
    expect(row.kind).toBe('expense');

    const ch = changeRow('cat-food');
    expect(ch.scope).toBe('user');
    expect(ch.ledger_id).toBeNull();
    expect(ch.user_id).toBe('user-1');
    expect(ch.updated_by_user_id).toBe('user-1');
  });

  it('account / tag 同样落 user_*_projection', async () => {
    await push('lg1', 'account', 'acc1', { syncId: 'acc1', name: 'Cash', type: 'cash', currency: 'CNY' });
    await push('lg1', 'tag', 'tag1', { syncId: 'tag1', name: 'work', color: '#F00' });
    const acc = sqlite.prepare('SELECT name FROM user_account_projection WHERE sync_id = ?').get('acc1') as Record<string, unknown>;
    const tag = sqlite.prepare('SELECT name FROM user_tag_projection WHERE sync_id = ?').get('tag1') as Record<string, unknown>;
    expect(acc.name).toBe('Cash');
    expect(tag.name).toBe('work');
  });

  it('老客户端误填 ledger_id → 忽略,不自动建账本,SyncChange.ledger_id NULL', async () => {
    await push('wrong-ledger', 'category', 'cat-x', { syncId: 'cat-x', name: 'X', kind: 'expense' });
    const ch = changeRow('cat-x');
    expect(ch.scope).toBe('user');
    expect(ch.ledger_id).toBeNull();
    const ledger = sqlite.prepare("SELECT COUNT(*) as cnt FROM ledgers WHERE external_id = 'wrong-ledger'").get() as { cnt: number };
    expect(ledger.cnt).toBe(0);
  });

  it('pull 返回 user-scope 变化 + ledger-scope 变化,scope/ledger_id 正确', async () => {
    sqlite.prepare("INSERT INTO ledgers (id, user_id, external_id, name, currency, created_at) VALUES ('ledger-1', 'user-1', 'lg1', 'L', 'CNY', '2025-01-01T00:00:00Z')").run();
    sqlite.prepare("INSERT INTO ledger_members (ledger_id, user_id, role, joined_at) VALUES ('ledger-1', 'user-1', 'owner', '2025-01-01T00:00:00Z')").run();
    await push('lg1', 'category', 'c1', { syncId: 'c1', name: 'X', kind: 'expense' });
    await push('lg1', 'transaction', 'tx1', { syncId: 'tx1', type: 'income', amount: 100, happenedAt: new Date().toISOString() });

    const res = await app.request('/api/v1/sync/pull?since=0', {}, { DB: db });
    expect(res.status).toBe(200);
    const changes = (await res.json() as any).changes as any[];
    const types = new Set(changes.map((c: any) => c.entity_type));
    expect(types.has('category')).toBe(true);
    expect(types.has('transaction')).toBe(true);

    const cats = changes.filter((c: any) => c.entity_type === 'category');
    expect(cats.every((c: any) => c.ledger_id === '__user_global__')).toBe(true);
    expect(cats.every((c: any) => c.scope === 'user')).toBe(true);
    const txs = changes.filter((c: any) => c.entity_type === 'transaction');
    expect(txs.every((c: any) => c.ledger_id === 'lg1')).toBe(true);
    expect(txs.every((c: any) => c.scope === 'ledger')).toBe(true);
  });

  it('account 改名跨全部 ledger 级联刷 read_tx_projection.account_name', async () => {
    sqlite.prepare("INSERT INTO ledgers (id, user_id, external_id, name, currency, created_at) VALUES ('ledger-1', 'user-1', 'lg1', 'L1', 'CNY', '2025-01-01T00:00:00Z'), ('ledger-2', 'user-1', 'lg2', 'L2', 'CNY', '2025-01-01T00:00:00Z')").run();
    sqlite.prepare("INSERT INTO ledger_members (ledger_id, user_id, role, joined_at) VALUES ('ledger-1', 'user-1', 'owner', '2025-01-01T00:00:00Z'), ('ledger-2', 'user-1', 'owner', '2025-01-01T00:00:00Z')").run();

    await push('lg1', 'account', 'a1', { syncId: 'a1', name: 'Old', type: 'cash', currency: 'CNY' });
    await push('lg1', 'transaction', 'tx-A', { syncId: 'tx-A', type: 'expense', amount: 1, happenedAt: new Date().toISOString(), accountId: 'a1', accountName: 'Old' });
    await push('lg2', 'transaction', 'tx-B', { syncId: 'tx-B', type: 'expense', amount: 2, happenedAt: new Date().toISOString(), accountId: 'a1', accountName: 'Old' });

    await push('lg1', 'account', 'a1', { syncId: 'a1', name: 'New', type: 'cash', currency: 'CNY' });

    for (const sid of ['tx-A', 'tx-B']) {
      const tx = sqlite.prepare('SELECT account_name FROM read_tx_projection WHERE sync_id = ?').get(sid) as { account_name: string | null };
      expect(tx.account_name).toBe('New');
    }
  });
});