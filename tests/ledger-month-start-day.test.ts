import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import syncRouter from '../src/routes/sync';
import readRouter from '../src/routes/read';
import writeRouter from '../src/routes/write';
import workspaceRouter from '../src/routes/workspace';

// 移植上游 tests/test_ledger_month_start_day.py(核心契约):
// push 带 monthStartDay → 落列;clamp 1-28;非 int(bool)忽略;
// partial update 不带键保留原值;read/ledgers 返回 msd;
// web meta 更新 msd + SyncChange payload 带 monthStartDay;
// web 创建账本带 msd;analytics natural_month override 用自然月、默认按 msd。
let sqlite: DatabaseSync;
let db: D1Database;
let app: Hono<{ Bindings: { DB: D1Database }; Variables: { userId: string } }>;

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, is_admin BOOLEAN DEFAULT 0);
    CREATE TABLE ledgers (id TEXT PRIMARY KEY, user_id TEXT, external_id TEXT, name TEXT, currency TEXT, month_start_day INTEGER DEFAULT 1, created_at TEXT);
    CREATE TABLE ledger_members (ledger_id TEXT, user_id TEXT, role TEXT, joined_at TEXT, invited_by TEXT, PRIMARY KEY (ledger_id, user_id));
    CREATE TABLE ledger_invites (code TEXT PRIMARY KEY, ledger_id TEXT, target_role TEXT, invited_by TEXT, expires_at TEXT, used_at TEXT, used_by TEXT, created_at TEXT);
    CREATE TABLE user_profiles (user_id TEXT PRIMARY KEY, primary_currency TEXT, display_name TEXT, avatar_file_id TEXT, avatar_version INTEGER, appearance_json TEXT, ai_config_json TEXT, updated_at TEXT);
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
    CREATE TABLE user_account_projection (sync_id TEXT PRIMARY KEY, user_id TEXT, name TEXT, account_type TEXT, currency TEXT, initial_balance REAL DEFAULT 0, note TEXT, credit_limit REAL, billing_day INTEGER, payment_due_day INTEGER, bank_name TEXT, card_last_four TEXT, hidden INTEGER DEFAULT 0);
    CREATE TABLE user_category_projection (sync_id TEXT PRIMARY KEY, user_id TEXT, name TEXT, kind TEXT, level INTEGER, sort_order INTEGER, icon TEXT, icon_type TEXT, custom_icon_path TEXT, icon_cloud_file_id TEXT, icon_cloud_sha256 TEXT, parent_name TEXT, parent_sync_id TEXT, note TEXT, source_change_id INTEGER DEFAULT 0);
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

  sqlite.prepare("INSERT INTO users (id, email, password_hash, is_admin) VALUES ('user-1', 'msd@x.com', 'x', 0)").run();
  sqlite.prepare("INSERT INTO ledgers (id, user_id, external_id, name, currency, created_at) VALUES ('ledger-1', 'user-1', 'L_MSD', 'L_MSD', 'CNY', '2025-01-01T00:00:00Z')").run();
  sqlite.prepare("INSERT INTO ledger_members (ledger_id, user_id, role, joined_at) VALUES ('ledger-1', 'user-1', 'owner', '2025-01-01T00:00:00Z')").run();
  sqlite.prepare("INSERT INTO devices (id, user_id, name, platform, created_at) VALUES ('dev-1', 'user-1', 'd', 'app', '2025-01-01T00:00:00Z')").run();

  app = new Hono<{ Bindings: { DB: D1Database }; Variables: { userId: string } }>();
  app.use('*', async (c, next) => {
    c.set('userId', 'user-1');
    await next();
  });
  app.route('/api/v1/sync', syncRouter);
  app.route('/api/v1/read', readRouter);
  app.route('/api/v1/read/workspace', workspaceRouter);
  app.route('/api/v1/write', writeRouter);
});

afterEach(() => sqlite.close());

async function pushLedgerUpsert(payload: Record<string, unknown>) {
  const res = await app.request('/api/v1/sync/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Device-ID': 'dev-1' },
    body: JSON.stringify({
      device_id: 'dev-1',
      changes: [{
        ledger_id: 'L_MSD', entity_type: 'ledger', entity_sync_id: 'L_MSD', action: 'upsert',
        payload, updated_at: new Date().toISOString(),
      }],
    }),
  }, { DB: db });
  expect(res.status).toBe(200);
}

function msd(): number {
  return (sqlite.prepare("SELECT month_start_day FROM ledgers WHERE id = 'ledger-1'").get() as { month_start_day: number }).month_start_day;
}

function latestLedgerPayload(): Record<string, unknown> {
  const row = sqlite.prepare(
    "SELECT payload_json FROM sync_changes WHERE entity_type = 'ledger' AND entity_sync_id = 'L_MSD' ORDER BY change_id DESC LIMIT 1"
  ).get() as { payload_json: string } | undefined;
  expect(row).toBeTruthy();
  return JSON.parse(row!.payload_json);
}

describe('账本 month_start_day(移植上游 test_ledger_month_start_day.py)', () => {
  it('push monthStartDay=15 → 落列;partial update 不带键保留原值', async () => {
    await pushLedgerUpsert({ syncId: 'L_MSD', ledgerName: 'L_MSD', currency: 'CNY', monthStartDay: 15 });
    expect(msd()).toBe(15);
    await pushLedgerUpsert({ syncId: 'L_MSD', ledgerName: '改名后', currency: 'CNY' });
    expect(msd()).toBe(15);
  });

  it('clamp 1-28:99→28,0→1;bool 忽略', async () => {
    await pushLedgerUpsert({ syncId: 'L_MSD', ledgerName: 'L_MSD', currency: 'CNY', monthStartDay: 99 });
    expect(msd()).toBe(28);
    await pushLedgerUpsert({ syncId: 'L_MSD', ledgerName: 'L_MSD', currency: 'CNY', monthStartDay: 0 });
    expect(msd()).toBe(1);
    await pushLedgerUpsert({ syncId: 'L_MSD', ledgerName: 'L_MSD', currency: 'CNY', monthStartDay: true });
    expect(msd()).toBe(1);
  });

  it('read/ledgers 返回 month_start_day(list + detail)', async () => {
    await pushLedgerUpsert({ syncId: 'L_MSD', ledgerName: 'L_MSD', currency: 'CNY', monthStartDay: 20 });
    const list = await app.request('/api/v1/read/ledgers', {}, { DB: db });
    expect(list.status).toBe(200);
    const rows = await list.json() as any[];
    expect(rows.find((r: any) => r.ledger_id === 'L_MSD')?.month_start_day).toBe(20);
    const detail = await app.request('/api/v1/read/ledgers/L_MSD', {}, { DB: db });
    expect(detail.status).toBe(200);
    expect((await detail.json() as any).month_start_day).toBe(20);
  });

  it('web meta 更新 msd → 落列 + SyncChange payload 带 monthStartDay;越界 422', async () => {
    const res = await app.request('/api/v1/write/ledgers/L_MSD/meta', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'X-Device-ID': 'web-console' },
      body: JSON.stringify({ base_change_id: 0, month_start_day: 10 }),
    }, { DB: db });
    expect(res.status).toBe(200);
    expect(msd()).toBe(10);
    const payload = latestLedgerPayload();
    expect(payload.monthStartDay).toBe(10);

    const bad = await app.request('/api/v1/write/ledgers/L_MSD/meta', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'X-Device-ID': 'web-console' },
      body: JSON.stringify({ base_change_id: 1, month_start_day: 29 }),
    }, { DB: db });
    expect(bad.status).toBe(422);
  });

  it('web 创建账本带 month_start_day → 落列 + SyncChange payload', async () => {
    await pushLedgerUpsert({ syncId: 'L_MSD', ledgerName: 'L_MSD', currency: 'CNY', monthStartDay: 1 });
    const create = await app.request('/api/v1/write/ledgers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Device-ID': 'web-console' },
      body: JSON.stringify({ ledger_id: 'NEW_L', ledger_name: '新账本', currency: 'CNY', month_start_day: 12 }),
    }, { DB: db });
    expect(create.status).toBe(200);
    const extId = (await create.json() as any).ledger_id as string;
    const cmd = sqlite.prepare('SELECT month_start_day FROM ledgers WHERE external_id = ?').get(extId) as { month_start_day: number };
    expect(cmd.month_start_day).toBe(12);
  });

  it('workspace/analytics:natural_month=true 用自然月;默认按 msd', async () => {
    await pushLedgerUpsert({ syncId: 'L_MSD', ledgerName: 'L_MSD', currency: 'CNY', monthStartDay: 15 });
    const natural = await app.request('/api/v1/read/workspace/analytics?scope=month&period=2026-06&ledger_id=L_MSD&natural_month=true', {}, { DB: db });
    expect(natural.status).toBe(200);
    const nb = await natural.json() as any;
    expect(nb.range.start_at.startsWith('2026-06-01')).toBe(true);
    expect(nb.range.end_at.startsWith('2026-06-30')).toBe(true);

    const defaultMsd = await app.request('/api/v1/read/workspace/analytics?scope=month&period=2026-06&ledger_id=L_MSD', {}, { DB: db });
    expect(defaultMsd.status).toBe(200);
    const mb = await defaultMsd.json() as any;
    expect(mb.range.start_at.startsWith('2026-06-15')).toBe(true);
    expect(mb.range.end_at.startsWith('2026-07-14')).toBe(true);
  });
});