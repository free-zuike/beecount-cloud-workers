import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import syncRouter from '../src/routes/sync';

// 移植上游 tests/test_sync_concurrency.py::
// test_operation_receipts_distinguish_same_second_writes_replay_and_batch_rejection
// (#150)：操作回执按 device_id+operation_id 持久化，区分同秒写入、重放、
// 批量混合拒绝；changed_fields 产生完整事件 winner；删除态保护 +
// restore_after_change_id 显式恢复协议。
let sqlite: DatabaseSync;
let db: D1Database;
let app: Hono<{ Bindings: { DB: D1Database; JWT_SECRET: string }; Variables: { userId: string } }>;

const NOW = new Date('2026-01-01T12:00:00.000Z');

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, is_admin BOOLEAN DEFAULT 0);
    CREATE TABLE ledgers (id TEXT PRIMARY KEY, user_id TEXT, external_id TEXT, name TEXT, currency TEXT, month_start_day INTEGER DEFAULT 1, created_at TEXT);
    CREATE TABLE ledger_members (ledger_id TEXT, user_id TEXT, role TEXT, joined_at TEXT);
    CREATE TABLE devices (id TEXT PRIMARY KEY, user_id TEXT, name TEXT, platform TEXT, app_version TEXT, os_version TEXT, device_model TEXT, last_ip TEXT, last_seen_at TEXT, revoked_at TEXT, created_at TEXT);
    CREATE TABLE sync_operation_receipts (
      device_id TEXT NOT NULL, operation_id TEXT NOT NULL, change_id INTEGER NOT NULL,
      ledger_id TEXT, entity_type TEXT NOT NULL, entity_sync_id TEXT NOT NULL, action TEXT NOT NULL,
      PRIMARY KEY (device_id, operation_id)
    );
    CREATE TABLE transaction_move_retirements (ledger_id TEXT, sync_id TEXT, PRIMARY KEY (ledger_id, sync_id));
    CREATE TABLE device_sync_failures (
      device_id TEXT, direction TEXT, incident_id TEXT, failure_count INTEGER,
      reason TEXT, first_failed_at TEXT, last_failed_at TEXT, PRIMARY KEY (device_id, direction)
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
      tags_csv TEXT, tag_sync_ids_json TEXT, attachments_json TEXT, pending_attachment_gc_json TEXT, attachment_gc_after TEXT, tx_index INTEGER,
      created_by_user_id TEXT, last_edited_by_user_id TEXT, source_change_id INTEGER,
      currency_code TEXT, native_amount REAL,
      exclude_from_stats INTEGER DEFAULT 0, exclude_from_budget INTEGER DEFAULT 0,
      PRIMARY KEY (ledger_id, sync_id)
    );
    CREATE TABLE read_budget_projection (ledger_id TEXT, sync_id TEXT, user_id TEXT, budget_type TEXT, category_sync_id TEXT, amount REAL, period TEXT, start_day INTEGER, enabled INTEGER DEFAULT 1, source_change_id INTEGER DEFAULT 0);
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

  sqlite.prepare("INSERT INTO users (id, email, password_hash, is_admin) VALUES ('user-1', 'receipts@x.com', 'x', 0)").run();
  sqlite.prepare("INSERT INTO devices (id, user_id, name, platform, app_version, created_at) VALUES ('d1', 'user-1', 'phone', 'ios', '4.1.0', '2025-01-01T00:00:00Z')").run();
  sqlite.prepare("INSERT INTO ledgers (id, user_id, external_id, name, currency, created_at) VALUES ('ledger-1', 'user-1', 'L', 'L', 'CNY', '2025-01-01T00:00:00Z')").run();
  sqlite.prepare("INSERT INTO ledger_members (ledger_id, user_id, role, joined_at) VALUES ('ledger-1', 'user-1', 'owner', '2025-01-01T00:00:00Z')").run();

  app = new Hono<{ Bindings: { DB: D1Database; JWT_SECRET: string }; Variables: { userId: string } }>();
  app.use('*', async (c, next) => {
    c.set('userId', 'user-1');
    await next();
  });
  app.route('/api/v1/sync', syncRouter);
});

afterEach(() => sqlite.close());

function event(operationId: string, amount: number, instant: Date = NOW, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    operation_id: operationId,
    ledger_id: 'L',
    entity_type: 'transaction',
    entity_sync_id: 'T',
    action: 'upsert',
    updated_at: instant.toISOString(),
    payload: { type: 'expense', amount, happenedAt: NOW.toISOString(), ...fields },
  };
}

async function send(...events: Record<string, unknown>[]): Promise<Record<string, any>> {
  const res = await app.request('/api/v1/sync/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_id: 'd1', changes: events, return_results: true }),
  }, { DB: db, JWT_SECRET: 'x' });
  expect(res.status).toBe(200);
  return await res.json() as Record<string, any>;
}

describe('操作回执（移植上游 test_operation_receipts_*）', () => {
  it('同秒写入、重放与批量混合拒绝', async () => {
    const first = event('first', 12, NOW, { note: 'keep remote note' });
    const second = { ...event('second', 18, NOW, { note: 'stale local note' }), changed_fields: ['amount'] };
    const batch = await send(first, second);
    expect([batch.accepted, batch.rejected]).toEqual([2, 0]);
    const [a, b] = batch.results;
    expect(b.change_id).toBeGreaterThan(a.change_id);
    expect(b.winner.payload.amount).toBe(18);
    expect(b.winner.payload.note).toBe('keep remote note');

    const mixed = await send(
      first,
      event('stale', 7, new Date(NOW.getTime() - 1000)),
      { ...event('another', 42), entity_sync_id: 'U' },
      { ...event('mismatched-reuse', 5), ledger_id: null },
    );
    const [replay, stale, independent, missing] = mixed.results;
    expect([mixed.accepted, mixed.rejected, mixed.conflict_count]).toEqual([2, 2, 1]);
    expect([replay.status, replay.change_id]).toEqual(['accepted', a.change_id]);
    expect(replay.winner.change_id).toBe(b.change_id);
    expect(stale.winner.change_id).toBe(b.change_id);
    expect(stale.status).toBe('conflict');
    expect(stale.winner.payload.amount).toBe(18);
    expect(independent.status).toBe('accepted');
    expect(missing.status).toBe('rejected');
    expect(missing.winner).toBeNull();

    const replayAgain = await send(first);
    expect(replayAgain.results[0].winner.payload.note).toBe('keep remote note');

    const tombstone = { ...event('delete', 0), action: 'delete', payload: {} };
    const deleted = (await send(tombstone)).results[0].change_id;
    const lateReplay = (await send(first)).results[0];
    expect(lateReplay.status).toBe('accepted');
    expect(lateReplay.change_id).toBe(a.change_id);
    expect(lateReplay.winner.change_id).toBe(deleted);
    expect(lateReplay.winner.action).toBe('delete');

    const staleAfterDelete = (await send(event('offline-edit', 27))).results[0];
    expect(staleAfterDelete.status).toBe('conflict');
    expect(staleAfterDelete.winner.change_id).toBe(deleted);

    const wrongVersion = { ...event('stale-restore', 27), restore_after_change_id: a.change_id };
    expect((await send(wrongVersion)).results[0].reason).toBe('restore_version_mismatch');

    const restored = {
      ...event('newer-edit', 27, NOW, {}),
      changed_fields: ['amount'],
      restore_after_change_id: deleted,
    };
    const result = (await send(restored)).results[0].winner;
    expect(result.payload.type).toBe('expense');
    expect(result.payload.amount).toBe(27);
    expect(result.payload.happenedAt).toBeTruthy();
  });

  it('实体 U 独立接受（上游 mixed 批次的第三条）', async () => {
    const first = event('first', 12, NOW, { note: 'keep remote note' });
    const second = { ...event('second', 18, NOW, { note: 'stale local note' }), changed_fields: ['amount'] };
    await send(first, second);

    const mixed = await send(
      first,
      event('stale', 7, new Date(NOW.getTime() - 1000)),
      { ...event('another', 42), entity_sync_id: 'U' },
      { ...event('mismatched-reuse', 5), ledger_id: null },
    );
    expect(mixed.results[2].status).toBe('accepted');
    const row = sqlite.prepare("SELECT amount FROM read_tx_projection WHERE sync_id = 'U'").get() as { amount: number };
    expect(row.amount).toBe(42);
  });

  it('不带 return_results 时响应不含 results 字段（老客户端兼容）', async () => {
    const res = await app.request('/api/v1/sync/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_id: 'd1', changes: [event('x1', 5)] }),
    }, { DB: db, JWT_SECRET: 'x' });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.results).toBeUndefined();
    expect(body.accepted).toBe(1);
  });
});
