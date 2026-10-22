import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import writeRouter from '../src/routes/write';
import readRouter from '../src/routes/read';
import syncRouter from '../src/routes/sync';

// 移植上游 tests/test_ledger_meta_update.py:
// web PATCH /write/ledgers/:id/meta 改名+改币种后,mobile /sync/pull 必须看到
// 一条 'ledger' upsert SyncChange(payload 带新 ledgerName/currency);
// read/ledgers list 同步返回新值。
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
      updated_by_user_id TEXT, updated_by_device_id TEXT, scope TEXT DEFAULT 'ledger'
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
    CREATE TABLE user_account_projection (sync_id TEXT PRIMARY KEY, user_id TEXT, name TEXT, account_type TEXT, currency TEXT, initial_balance REAL DEFAULT 0, hidden INTEGER DEFAULT 0);
    CREATE TABLE user_category_projection (sync_id TEXT PRIMARY KEY, user_id TEXT, name TEXT, kind TEXT, level INTEGER);
    CREATE TABLE user_tag_projection (sync_id TEXT PRIMARY KEY, user_id TEXT, name TEXT, color TEXT, source_change_id INTEGER);
    CREATE TABLE user_exchange_rate_projection (sync_id TEXT PRIMARY KEY, user_id TEXT, base_currency TEXT, quote_currency TEXT, rate REAL);
    CREATE TABLE attachment_files (id TEXT PRIMARY KEY, ledger_id TEXT, user_id TEXT NOT NULL, sha256 TEXT NOT NULL, size_bytes INTEGER DEFAULT 0, mime_type TEXT, file_name TEXT, storage_path TEXT NOT NULL, attachment_kind TEXT DEFAULT 'transaction' NOT NULL, created_at TEXT);
    CREATE TABLE sync_cursors (user_id TEXT, device_id TEXT, ledger_external_id TEXT, last_cursor INTEGER, updated_at TEXT, PRIMARY KEY (user_id, device_id, ledger_external_id));
    CREATE TABLE backup_remotes (id TEXT PRIMARY KEY, user_id TEXT, backend_type TEXT, config_summary TEXT);
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

  sqlite.prepare("INSERT INTO users (id, email, password_hash, is_admin) VALUES ('user-1', 'lm@x.com', 'x', 0)").run();
  sqlite.prepare("INSERT INTO ledgers (id, user_id, external_id, name, currency, created_at) VALUES ('ledger-1', 'user-1', 'L_META', 'L_META', 'CNY', '2025-01-01T00:00:00Z')").run();
  sqlite.prepare("INSERT INTO ledger_members (ledger_id, user_id, role, joined_at) VALUES ('ledger-1', 'user-1', 'owner', '2025-01-01T00:00:00Z')").run();
  sqlite.prepare("INSERT INTO devices (id, user_id, name, platform, created_at) VALUES ('dev-1', 'user-1', 'd', 'app', '2025-01-01T00:00:00Z')").run();

  app = new Hono<{ Bindings: { DB: D1Database }; Variables: { userId: string } }>();
  app.use('*', async (c, next) => {
    c.set('userId', 'user-1');
    await next();
  });
  app.route('/api/v1/write', writeRouter);
  app.route('/api/v1/read', readRouter);
  app.route('/api/v1/sync', syncRouter);
});

afterEach(() => sqlite.close());

async function seedLedgerSnapshot() {
  await app.request('/api/v1/sync/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Device-ID': 'dev-1' },
    body: JSON.stringify({
      device_id: 'dev-1',
      changes: [{
        ledger_id: 'L_META',
        entity_type: 'ledger_snapshot',
        entity_sync_id: 'L_META',
        action: 'upsert',
        payload: { content: JSON.stringify({ ledgerName: 'L_META', currency: 'CNY', count: 0, items: [], accounts: [], categories: [], tags: [] }) },
        updated_at: new Date().toISOString(),
      }],
    }),
  }, { DB: db });
}

async function latestChangeId(): Promise<number> {
  const row = sqlite.prepare('SELECT MAX(change_id) as max_id FROM sync_changes').get() as { max_id: number | null };
  return row.max_id ?? 0;
}

describe('账本 meta 更新(移植上游 test_ledger_meta_update.py)', () => {
  it('web 改名+改币种 → /sync/pull 见 ledger upsert change,payload 带新值;read list 同步', async () => {
    await seedLedgerSnapshot();
    const base = await latestChangeId();

    const res = await app.request('/api/v1/write/ledgers/L_META/meta', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'X-Device-ID': 'web-console' },
      body: JSON.stringify({ base_change_id: base, ledger_name: 'Family Budget', currency: 'USD' }),
    }, { DB: db });
    expect(res.status).toBe(200);

    // mobile /sync/pull from base → ledger upsert change
    const pull = await app.request('/api/v1/sync/pull?since=' + base + '&limit=100', {
      headers: { 'X-Device-ID': 'dev-1' },
    }, { DB: db });
    expect(pull.status).toBe(200);
    const changes = (await pull.json() as any).changes as any[];
    const ledgerChanges = changes.filter((c: any) => c.entity_type === 'ledger' && c.action === 'upsert');
    expect(ledgerChanges.length).toBeGreaterThan(0);
    const latest = ledgerChanges[ledgerChanges.length - 1];
    expect(latest.payload.ledgerName).toBe('Family Budget');
    expect(latest.payload.currency).toBe('USD');

    // read/ledgers list 返回新 name/currency
    const list = await app.request('/api/v1/read/ledgers', {}, { DB: db });
    expect(list.status).toBe(200);
    const rows = await list.json() as any[];
    const match = rows.find((r: any) => r.ledger_id === 'L_META');
    expect(match).toBeTruthy();
    expect(match.ledger_name).toBe('Family Budget');
    expect(match.currency).toBe('USD');
  });
});