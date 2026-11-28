import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import syncRouter from '../src/routes/sync';

// 移植上游 tests/test_sync_publication.py::
// test_delayed_shared_resource_frames_use_current_projection_and_membership
// （#150 ws_relay）：共享资源帧在投递时按当前投影解析 payload（不是 push 时的
// 原始 payload），实体删除后投递 delete 墓碑；帧持久化到 ws_relay_frames。
let sqlite: DatabaseSync;
let db: D1Database;
let app: Hono<{ Bindings: { DB: D1Database; JWT_SECRET: string }; Variables: { userId: string } }>;

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, is_admin BOOLEAN DEFAULT 0);
    CREATE TABLE ledgers (id TEXT PRIMARY KEY, user_id TEXT, external_id TEXT, name TEXT, currency TEXT, month_start_day INTEGER DEFAULT 1, created_at TEXT);
    CREATE TABLE ledger_members (ledger_id TEXT, user_id TEXT, role TEXT, joined_at TEXT);
    CREATE TABLE devices (id TEXT PRIMARY KEY, user_id TEXT, name TEXT, platform TEXT, app_version TEXT, os_version TEXT, device_model TEXT, last_ip TEXT, last_seen_at TEXT, revoked_at TEXT, created_at TEXT);
    CREATE TABLE sync_operation_receipts (device_id TEXT NOT NULL, operation_id TEXT NOT NULL, change_id INTEGER NOT NULL, ledger_id TEXT, entity_type TEXT NOT NULL, entity_sync_id TEXT NOT NULL, action TEXT NOT NULL, PRIMARY KEY (device_id, operation_id));
    CREATE TABLE transaction_move_retirements (ledger_id TEXT, sync_id TEXT, PRIMARY KEY (ledger_id, sync_id));
    CREATE TABLE ws_relay_frames (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE sync_changes (change_id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, ledger_id TEXT, entity_type TEXT, entity_sync_id TEXT, action TEXT, payload_json TEXT, updated_at TEXT, updated_by_user_id TEXT, updated_by_device_id TEXT, scope TEXT);
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
      pending_attachment_gc_json TEXT, attachment_gc_after TEXT,
      PRIMARY KEY (ledger_id, sync_id)
    );
    CREATE TABLE read_budget_projection (ledger_id TEXT, sync_id TEXT, user_id TEXT, budget_type TEXT, category_sync_id TEXT, amount REAL, period TEXT, start_day INTEGER, enabled INTEGER DEFAULT 1, source_change_id INTEGER DEFAULT 0);
    CREATE TABLE user_account_projection (sync_id TEXT PRIMARY KEY, user_id TEXT, name TEXT, account_type TEXT, currency TEXT, initial_balance REAL DEFAULT 0, note TEXT, credit_limit REAL, billing_day INTEGER, payment_due_day INTEGER, bank_name TEXT, card_last_four TEXT, hidden INTEGER DEFAULT 0, source_change_id INTEGER DEFAULT 0);
    CREATE TABLE user_category_projection (sync_id TEXT PRIMARY KEY, user_id TEXT, name TEXT, kind TEXT, level INTEGER, sort_order INTEGER, icon TEXT, icon_type TEXT, custom_icon_path TEXT, icon_cloud_file_id TEXT, icon_cloud_sha256 TEXT, parent_name TEXT, parent_sync_id TEXT, source_change_id INTEGER DEFAULT 0);
    CREATE TABLE user_tag_projection (sync_id TEXT PRIMARY KEY, user_id TEXT, name TEXT, color TEXT, source_change_id INTEGER);
    CREATE TABLE user_exchange_rate_projection (sync_id TEXT PRIMARY KEY, user_id TEXT, base_currency TEXT, quote_currency TEXT, rate REAL);
    CREATE TABLE audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, ledger_id TEXT, action TEXT, metadata_json TEXT, created_at TEXT);
    CREATE TABLE backup_remotes (id TEXT PRIMARY KEY, backend_type TEXT, config_summary TEXT);
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
      const out = [];
      for (const s of stmts) out.push(await s.run());
      return out;
    },
  } as unknown as D1Database;

  sqlite.prepare("INSERT INTO users (id, email, password_hash, is_admin) VALUES ('user-1', 'owner@x.com', 'x', 0)").run();
  sqlite.prepare("INSERT INTO users (id, email, password_hash, is_admin) VALUES ('user-2', 'editor@x.com', 'x', 0)").run();
  sqlite.prepare("INSERT INTO devices (id, user_id, name, platform, app_version, created_at) VALUES ('d1', 'user-1', 'p', 'ios', '4.1.0', '2025-01-01')").run();
  sqlite.prepare("INSERT INTO ledgers (id, user_id, external_id, name, currency, created_at) VALUES ('ledger-1', 'user-1', 'shared', 'S', 'CNY', '2025-01-01')").run();
  sqlite.prepare("INSERT INTO ledger_members (ledger_id, user_id, role, joined_at) VALUES ('ledger-1', 'user-1', 'owner', '2025-01-01')").run();
  sqlite.prepare("INSERT INTO ledger_members (ledger_id, user_id, role, joined_at) VALUES ('ledger-1', 'user-2', 'editor', '2025-01-01')").run();

  app = new Hono<{ Bindings: { DB: D1Database; JWT_SECRET: string }; Variables: { userId: string } }>();
  app.use('*', async (c, next) => {
    c.set('userId', 'user-1');
    await next();
  });
  app.route('/api/v1/sync', syncRouter);
});

afterEach(() => sqlite.close());

async function pushTag(entityType: string, syncId: string, action: 'upsert' | 'delete', payload: Record<string, unknown>): Promise<void> {
  const res = await app.request('/api/v1/sync/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      device_id: 'd1',
      changes: [{
        entity_type: entityType, entity_sync_id: syncId, action,
        payload, updated_at: new Date().toISOString(),
      }],
    }),
  }, { DB: db, JWT_SECRET: 'x' });
  expect(res.status).toBe(200);
}

function memberFrames(): Array<Record<string, unknown>> {
  const rows = sqlite.prepare("SELECT payload FROM ws_relay_frames WHERE user_id = 'user-2' ORDER BY id").all() as Array<{ payload: string }>;
  return rows.map(r => JSON.parse(r.payload) as Record<string, unknown>);
}

describe('共享资源帧（移植上游 delayed frames 场景）', () => {
  it('投递时按当前投影解析 payload；删除投递墓碑；帧落库', async () => {
    // owner 推 tag upsert：帧 payload 取投影物化行（含 syncId/name/color）
    await pushTag('tag', 'tag1', 'upsert', { syncId: 'tag1', name: 'work', color: '#F00' });

    const frames1 = memberFrames();
    const shared = frames1.find(f => f.type === 'shared_resource_change') as Record<string, unknown> | undefined;
    expect(shared).toBeDefined();
    expect(shared?.action).toBe('upsert');
    expect(shared?.payload).toMatchObject({ syncId: 'tag1', name: 'work' });

    // owner 也收到 user-global 通道帧
    const ownerFrames = (sqlite.prepare("SELECT payload FROM ws_relay_frames WHERE user_id = 'user-1'").all() as Array<{ payload: string }>)
      .map(r => JSON.parse(r.payload) as Record<string, unknown>);
    expect(ownerFrames.some(f => f.ledgerId === '__user_global__')).toBe(true);

    // 删除 tag：帧投递 delete 墓碑（payload 仅 syncId）
    await pushTag('tag', 'tag1', 'delete', {});
    const frames2 = memberFrames();
    const tombstone = frames2[frames2.length - 1] as Record<string, unknown>;
    expect(tombstone.action).toBe('delete');
    expect(tombstone.payload).toEqual({ syncId: 'tag1' });
  });
});
