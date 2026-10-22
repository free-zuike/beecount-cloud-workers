import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import syncRouter from '../src/routes/sync';

// 移植上游 tests/test_sync_concurrency.py:
// 1) 同 updated_at 时 device_id 字典序大者胜(冲突拒绝 rejected=1/conflict_count=1);
// 2) 同设备同 ts 重放幂等 accepted=1 且 SyncChange 只有 1 行;
// 3) 顺序 3 次 push 全部落 read_tx_projection。
let sqlite: DatabaseSync;
let db: D1Database;
let app: Hono<{ Bindings: { DB: D1Database }; Variables: { userId: string } }>;

const TS = '2025-01-15T10:00:00.000Z';

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
    CREATE TABLE user_account_projection (sync_id TEXT PRIMARY KEY, user_id TEXT, name TEXT, account_type TEXT, currency TEXT);
    CREATE TABLE user_category_projection (sync_id TEXT PRIMARY KEY, user_id TEXT, name TEXT, kind TEXT, level INTEGER);
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

  sqlite.prepare("INSERT INTO users (id, email, password_hash) VALUES ('user-1', 'lww@x.com', 'x')").run();
  sqlite.prepare("INSERT INTO ledgers (id, user_id, external_id, name, currency) VALUES ('ledger-1', 'user-1', 'L1', 'L1', 'CNY')").run();
  sqlite.prepare("INSERT INTO ledger_members (ledger_id, user_id, role, joined_at) VALUES ('ledger-1', 'user-1', 'owner', '2025-01-01T00:00:00Z')").run();
  for (const dev of ['lww-test-device', 'aaa-device-a', 'zzz-device-b', 'idem-device', 'seq-device']) {
    sqlite.prepare("INSERT INTO devices (id, user_id, name, platform, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(dev, 'user-1', dev, 'test', '2025-01-01T00:00:00Z');
  }

  app = new Hono<{ Bindings: { DB: D1Database }; Variables: { userId: string } }>();
  app.use('*', async (c, next) => {
    c.set('userId', 'user-1');
    await next();
  });
  app.route('/api/v1/sync', syncRouter);
});

afterEach(() => sqlite.close());

async function pushTx(deviceId: string, syncId: string, amount: number, updatedAt: string) {
  const res = await app.request('/api/v1/sync/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      device_id: deviceId,
      changes: [{
        ledger_id: 'L1',
        entity_type: 'transaction',
        entity_sync_id: syncId,
        action: 'upsert',
        payload: {
          syncId,
          type: 'expense',
          amount,
          happenedAt: updatedAt,
          categoryName: 'Food',
          categoryKind: 'expense',
          accountName: 'Cash',
        },
        updated_at: updatedAt,
      }],
    }),
  }, { DB: db });
  expect(res.status).toBe(200);
  return await res.json() as Record<string, unknown>;
}

describe('sync push 确定性 LWW(移植上游 test_sync_concurrency.py)', () => {
  it('同 updated_at 时 device_id 字典序大者胜,小者再推被拒', async () => {
    const deviceA = 'aaa-device-a';
    const deviceB = 'zzz-device-b';
    expect(deviceB > deviceA).toBe(true);

    // A 先推 amount=100
    await pushTx(deviceA, 'tx1', 100, TS);
    // B 同 ts 推 amount=200 → B 胜
    await pushTx(deviceB, 'tx1', 200, TS);
    // A 再推 amount=300 同 ts → 必须被拒
    const res = await pushTx(deviceA, 'tx1', 300, TS);
    expect(res.rejected).toBe(1);
    expect(res.conflict_count).toBe(1);

    const row = sqlite.prepare('SELECT amount FROM read_tx_projection WHERE ledger_id = ? AND sync_id = ?')
      .get('ledger-1', 'tx1') as { amount: number } | undefined;
    expect(row).toBeTruthy();
    expect(row!.amount).toBe(200);
  });

  it('同设备同 ts 重放幂等:accepted=1 且 SyncChange 只有 1 行', async () => {
    const device = 'idem-device';
    await pushTx(device, 'tx-idem', 42, TS);
    const body2 = await pushTx(device, 'tx-idem', 42, TS);
    expect(body2.accepted).toBe(1);

    const count = sqlite.prepare(
      "SELECT COUNT(*) as cnt FROM sync_changes WHERE entity_type = 'transaction' AND entity_sync_id = 'tx-idem'"
    ).get() as { cnt: number };
    expect(count.cnt).toBe(1);
  });

  it('顺序 3 次 push 全部落 read_tx_projection', async () => {
    const device = 'seq-device';
    const base = new Date('2025-01-15T10:00:00.000Z');
    for (let i = 0; i < 3; i++) {
      const t = new Date(base.getTime() + (i + 1) * 1000).toISOString();
      await pushTx(device, ['a', 'b', 'c'][i], 10 * (i + 1), t);
    }
    const rows = sqlite.prepare('SELECT sync_id FROM read_tx_projection WHERE ledger_id = ? ORDER BY sync_id').all('ledger-1') as { sync_id: string }[];
    expect(rows.map(r => r.sync_id)).toEqual(['a', 'b', 'c']);
  });
});