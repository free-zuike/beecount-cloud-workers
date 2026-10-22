import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import syncRouter from '../src/routes/sync';

// 移植上游 tests/test_sync_exclude_flags.py(push 侧契约):
// - mobile push camelCase excludeFromStats/excludeFromBudget → 落 read_tx_projection 两列;
// - partial-update(后续 push 不带该 key)时保持原值,不得被抹成 False(D6 核心)。
let sqlite: DatabaseSync;
let db: D1Database;
let app: Hono<{ Bindings: { DB: D1Database }; Variables: { userId: string } }>;

function createTables() {
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

  sqlite.prepare("INSERT INTO users (id, email, password_hash) VALUES ('user-1', 'excl@x.com', 'x')").run();
  sqlite.prepare("INSERT INTO ledgers (id, user_id, external_id, name, currency) VALUES ('ledger-1', 'user-1', 'L_EXCL', 'L', 'CNY')").run();
  sqlite.prepare("INSERT INTO ledger_members (ledger_id, user_id, role, joined_at) VALUES ('ledger-1', 'user-1', 'owner', '2025-01-01T00:00:00Z')").run();
  sqlite.prepare("INSERT INTO devices (id, user_id, name, platform, created_at) VALUES ('m-device', 'user-1', 'm', 'app', '2025-01-01T00:00:00Z')").run();

  app = new Hono<{ Bindings: { DB: D1Database }; Variables: { userId: string } }>();
  app.use('*', async (c, next) => {
    c.set('userId', 'user-1');
    await next();
  });
  app.route('/api/v1/sync', syncRouter);
});

afterEach(() => sqlite.close());

async function pushTx(payload: Record<string, unknown>) {
  const res = await app.request('/api/v1/sync/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      device_id: 'm-device',
      changes: [{
        ledger_id: 'L_EXCL',
        entity_type: 'transaction',
        entity_sync_id: payload.syncId,
        action: 'upsert',
        payload,
        updated_at: new Date().toISOString(),
      }],
    }),
  }, { DB: db });
  expect(res.status).toBe(200);
  return await res.json() as Record<string, unknown>;
}

function txRow(syncId: string): Record<string, unknown> {
  return sqlite.prepare(
    'SELECT amount, exclude_from_stats, exclude_from_budget FROM read_tx_projection WHERE ledger_id = ? AND sync_id = ?'
  ).get('ledger-1', syncId) as Record<string, unknown>;
}

describe('sync push exclude flags 契约(移植上游 test_sync_exclude_flags.py)', () => {
  it('push camelCase exclude 标记 → 落投影两列 True', async () => {
    await pushTx({
      syncId: 'tx-flag-1',
      type: 'expense',
      amount: 500.0,
      happenedAt: new Date().toISOString(),
      excludeFromStats: true,
      excludeFromBudget: true,
    });
    const row = txRow('tx-flag-1');
    expect(row.exclude_from_stats).toBe(1);
    expect(row.exclude_from_budget).toBe(1);
  });

  it('partial-update 不带 exclude 键时保留原值,不被抹成 False', async () => {
    await pushTx({
      syncId: 'tx-flag-2',
      type: 'expense',
      amount: 500.0,
      happenedAt: new Date().toISOString(),
      excludeFromStats: true,
    });
    // 只改金额的 partial update
    await pushTx({
      syncId: 'tx-flag-2',
      type: 'expense',
      amount: 600.0,
      happenedAt: new Date().toISOString(),
    });
    const row = txRow('tx-flag-2');
    expect(row.amount).toBe(600);
    expect(row.exclude_from_stats).toBe(1);
  });
});