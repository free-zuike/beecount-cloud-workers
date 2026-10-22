import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import workspaceRouter from '../src/routes/workspace';
import writeRouter from '../src/routes/write';
import syncRouter from '../src/routes/sync';

// 移植上游 tests/test_shared_ledger_e2e.py:
// 1. Owner 邀请 + Editor preview/accept → ledger_members 写入、member_count=2;
// 2. Editor sync/ledgers 能看到共享账本;
// 3. shared-resources 返回 Owner 的 user-global 资源;
// 4. Editor 不能 PATCH ledger meta(404);
// 5. Owner 踢 Editor → Editor 失去访问。
let sqlite: DatabaseSync;
let db: D1Database;
let app: Hono<{ Bindings: { DB: D1Database }; Variables: { userId: string } }>;

function createTables() {
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
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:');
  createTables();
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

  app = new Hono<{ Bindings: { DB: D1Database }; Variables: { userId: string } }>();
  app.use('*', async (c, next) => {
    c.set('userId', c.req.header('X-Test-User') ?? 'user-1');
    await next();
  });
  app.route('/api/v1', workspaceRouter);
  app.route('/api/v1/write', writeRouter);
  app.route('/api/v1/sync', syncRouter);
});

afterEach(() => sqlite.close());

function insertUser(id: string, email: string) {
  sqlite.prepare("INSERT INTO users (id, email, password_hash, is_admin) VALUES (?, ?, 'x', 0)").run(id, email);
}

function req(userId: string, path: string, init: RequestInit = {}) {
  return app.request(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', 'X-Test-User': userId, ...(init.headers ?? {}) },
  }, { DB: db });
}

async function createLedger(ownerId: string, ledgerId: string) {
  const res = await req(ownerId, '/api/v1/write/ledgers', {
    method: 'POST',
    body: JSON.stringify({ ledger_id: ledgerId, ledger_name: ledgerId, currency: 'CNY' }),
  });
  expect(res.status).toBe(200);
}

async function inviteAndAccept(ownerId: string, editorId: string, ledgerId: string, role = 'editor') {
  const inv = await req(ownerId, `/api/v1/ledgers/${ledgerId}/invites`, {
    method: 'POST',
    body: JSON.stringify({ target_role: role, expires_in_hours: 24 }),
  });
  expect(inv.status).toBe(200);
  const { code } = await inv.json() as any;
  expect(code.length).toBe(6);

  const preview = await req(editorId, `/api/v1/invites/${code}/preview`, { method: 'POST' });
  expect(preview.status).toBe(200);
  const pv = await preview.json() as any;
  expect(pv.ledger_id).toBe(ledgerId);
  expect(pv.target_role).toBe(role);

  const accept = await req(editorId, `/api/v1/invites/${code}/accept`, { method: 'POST' });
  expect(accept.status).toBe(200);
  return await accept.json() as any;
}

describe('共享账本 e2e(移植上游 test_shared_ledger_e2e.py)', () => {
  it('invite → preview → accept → Editor sync/ledgers 能看到账本', async () => {
    insertUser('owner', 'owner@e2e.test');
    insertUser('editor', 'editor@e2e.test');
    await createLedger('owner', 'shared1');

    const acceptBody = await inviteAndAccept('owner', 'editor', 'shared1');
    expect(acceptBody.role).toBe('editor');
    expect(acceptBody.member_count).toBe(2);

    const ed = await req('editor', '/api/v1/sync/ledgers');
    expect(ed.status).toBe(200);
    const ledgerIds = (await ed.json() as any[]).map((lg: any) => lg.ledger_id);
    expect(ledgerIds).toContain('shared1');
  });

  it('shared-resources 返回 Owner 的 user-global 资源', async () => {
    insertUser('owner', 'owner2@e2e.test');
    insertUser('editor', 'editor2@e2e.test');
    await createLedger('owner', 'shared2');
    sqlite.prepare(
      "INSERT INTO user_category_projection (user_id, sync_id, name, kind, icon_type, sort_order) VALUES ('owner', 'cat-1', '早餐', 'expense', 'material', 0)"
    ).run();
    await inviteAndAccept('owner', 'editor', 'shared2');

    const res = await req('editor', '/api/v1/ledgers/shared2/shared-resources');
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.owner_user_id).toBe('owner');
    expect(data.categories.length).toBe(1);
    expect(data.categories[0].name).toBe('早餐');
    expect(data.categories[0].kind).toBe('expense');
  });

  it('Editor 不能 PATCH ledger meta → 404', async () => {
    insertUser('owner', 'owner3@e2e.test');
    insertUser('editor', 'editor3@e2e.test');
    await createLedger('owner', 'shared3');
    await inviteAndAccept('owner', 'editor', 'shared3');

    const res = await req('editor', '/api/v1/write/ledgers/shared3/meta', {
      method: 'PATCH',
      body: JSON.stringify({ base_change_id: 0, ledger_name: 'ed' }),
    });
    expect(res.status).toBe(404);
  });

  it('Owner 踢 Editor → Editor 失去访问', async () => {
    insertUser('owner', 'owner4@e2e.test');
    insertUser('editor', 'editor4@e2e.test');
    await createLedger('owner', 'shared4');
    await inviteAndAccept('owner', 'editor', 'shared4');

    const del = await req('owner', '/api/v1/ledgers/shared4/members/editor', { method: 'DELETE' });
    expect(del.status).toBe(204); // 对齐上游 test_owner_remove_editor 的 204

    const ed = await req('editor', '/api/v1/sync/ledgers');
    expect(ed.status).toBe(200);
    const ledgerIds = (await ed.json() as any[]).map((lg: any) => lg.ledger_id);
    expect(ledgerIds.includes('shared4')).toBe(false);
  });
});