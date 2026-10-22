import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import writeRouter from '../src/routes/write';
import readRouter from '../src/routes/read';

// 移植上游 tests/test_write_tx_exclude_flags.py(web 写端点契约):
// - POST /write/ledgers/{id}/transactions 带 exclude_from_stats/exclude_from_budget
//   → read 端点读回、SyncChange payload 用 camelCase、projection 落库;
// - PATCH 只翻一个 flag,另一个不传保持不变。
let sqlite: DatabaseSync;
let db: D1Database;
let app: Hono<{ Bindings: { DB: D1Database }; Variables: { userId: string } }>;

const USER = 'user-1';

function createTables() {
  sqlite.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, is_admin BOOLEAN DEFAULT 0);
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
    CREATE TABLE user_account_projection (sync_id TEXT PRIMARY KEY, user_id TEXT, name TEXT, account_type TEXT, currency TEXT);
    CREATE TABLE user_category_projection (sync_id TEXT PRIMARY KEY, user_id TEXT, name TEXT, kind TEXT, level INTEGER);
    CREATE TABLE user_tag_projection (sync_id TEXT PRIMARY KEY, user_id TEXT, name TEXT, color TEXT, source_change_id INTEGER);
    CREATE TABLE user_exchange_rate_projection (sync_id TEXT PRIMARY KEY, user_id TEXT, base_currency TEXT, quote_currency TEXT, rate REAL);
    CREATE TABLE read_budget_projection (ledger_id TEXT, sync_id TEXT, user_id TEXT, budget_type TEXT, category_sync_id TEXT, amount REAL, period TEXT, start_day INTEGER, enabled INTEGER DEFAULT 1);
    CREATE TABLE audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, ledger_id TEXT, action TEXT, metadata_json TEXT, created_at TEXT);
  `);
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:');
  createTables();
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

  sqlite.prepare("INSERT INTO users (id, email, password_hash, is_admin) VALUES ('user-1', 'ex@x.com', 'x', 0)").run();
  sqlite.prepare("INSERT INTO ledgers (id, user_id, external_id, name, currency) VALUES ('ledger-1', 'user-1', 'EX_C1', 'L', 'CNY')").run();
  sqlite.prepare("INSERT INTO ledger_members (ledger_id, user_id, role, joined_at) VALUES ('ledger-1', 'user-1', 'owner', '2025-01-01T00:00:00Z')").run();
  sqlite.prepare("INSERT INTO devices (id, user_id, name, platform, created_at) VALUES ('web-console', 'user-1', 'web', 'web', '2025-01-01T00:00:00Z')").run();

  app = new Hono<{ Bindings: { DB: D1Database }; Variables: { userId: string } }>();
  app.use('*', async (c, next) => {
    c.set('userId', USER);
    await next();
  });
  app.route('/api/v1/write', writeRouter);
  app.route('/api/v1/read', readRouter);
});

afterEach(() => sqlite.close());

async function baseChangeId(ledgerExtId: string): Promise<number> {
  const row = sqlite.prepare('SELECT MAX(change_id) as max_id FROM sync_changes WHERE ledger_id = ?')
    .get('ledger-1') as { max_id: number | null };
  return row.max_id ?? 0;
}

async function createTx(ledgerExtId: string, body: Record<string, unknown>) {
  const { ledger_id, ...rest } = body;
  return app.request(`/api/v1/write/ledgers/${ledgerExtId}/transactions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Device-ID': 'web-console' },
    body: JSON.stringify(rest),
  }, { DB: db });
}

async function patchTx(ledgerExtId: string, txId: string, body: Record<string, unknown>) {
  return app.request(`/api/v1/write/ledgers/${ledgerExtId}/transactions/${txId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'X-Device-ID': 'web-console' },
    body: JSON.stringify(body),
  }, { DB: db });
}

function latestChangePayload(txId: string): Record<string, unknown> {
  const row = sqlite.prepare(
    `SELECT payload_json FROM sync_changes
     WHERE ledger_id = 'ledger-1' AND entity_type = 'transaction' AND entity_sync_id = ?
     ORDER BY change_id DESC LIMIT 1`
  ).get(txId) as { payload_json: string } | undefined;
  expect(row).toBeTruthy();
  return JSON.parse(row!.payload_json);
}

function projectionRow(txId: string): Record<string, unknown> {
  return sqlite.prepare(
    'SELECT amount, exclude_from_stats, exclude_from_budget FROM read_tx_projection WHERE ledger_id = ? AND sync_id = ?'
  ).get('ledger-1', txId) as Record<string, unknown>;
}

describe('web 写端点 exclude flags(移植上游 test_write_tx_exclude_flags.py)', () => {
  it('POST 创建交易带标记 → read 读回 + SyncChange camelCase + 投影落库', async () => {
    const base = await baseChangeId('EX_C1');
    const createRes = await createTx('EX_C1', {
      base_change_id: base,
      tx_type: 'expense',
      amount: 42.0,
      happened_at: new Date().toISOString(),
      exclude_from_stats: true,
      exclude_from_budget: false,
    });
    expect(createRes.status).toBe(200);
    const created = await createRes.json() as any;
    const txId = created.entity_id;

    // read 端点读回布尔
    const listRes = await app.request('/api/v1/read/ledgers/EX_C1/transactions', {}, { DB: db });
    expect(listRes.status).toBe(200);
    const items = (await listRes.json() as any[]).filter((it: any) => it.id === txId);
    expect(items.length).toBe(1);
    expect(items[0].exclude_from_stats).toBe(true);
    expect(items[0].exclude_from_budget).toBe(false);

    // SyncChange payload camelCase
    const payload = latestChangePayload(txId);
    expect(payload.excludeFromStats).toBe(true);
    expect(payload.excludeFromBudget).toBe(false);

    // 投影落库
    const row = projectionRow(txId);
    expect(row.exclude_from_stats).toBe(1);
    expect(row.exclude_from_budget).toBe(0);
  });

  it('PATCH 只翻 exclude_from_stats,另一个保持不变', async () => {
    const base = await baseChangeId('EX_C1');
    const createRes = await createTx('EX_C1', {
      base_change_id: base,
      tx_type: 'expense',
      amount: 10.0,
      happened_at: new Date().toISOString(),
      exclude_from_stats: false,
      exclude_from_budget: true,
    });
    expect(createRes.status).toBe(200);
    const created = await createRes.json() as any;
    const txId = created.entity_id;
    const newBase = Number(created.new_change_id);

    const updRes = await patchTx('EX_C1', txId, {
      base_change_id: newBase,
      exclude_from_stats: true,
    });
    expect(updRes.status).toBe(200);

    const row = projectionRow(txId);
    expect(row.exclude_from_stats).toBe(1);
    expect(row.exclude_from_budget).toBe(1);

    const payload = latestChangePayload(txId);
    expect(payload.excludeFromStats).toBe(true);
    expect(payload.excludeFromBudget).toBe(true);
  });
});