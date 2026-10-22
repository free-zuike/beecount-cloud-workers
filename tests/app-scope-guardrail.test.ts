// 移植上游 tests/test_app_scope_guardrail.py:
// 默认(ALLOW_APP_RW_SCOPES=false,对齐上游 conftest)app token 只有 app_write,
// 访问 /read/* /write/* /devices → 403;web token(web_read/web_write/ops_write)放行。
// 本地默认宽松(生产一致),该测试显式传 env ALLOW_APP_RW_SCOPES='false' 验证严格模式。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { authMiddleware } from '../src/middleware/auth';
import { scopeGuard } from '../src/middleware/scope';
import authRouter from '../src/routes/auth';
import syncRouter from '../src/routes/sync';
import readRouter from '../src/routes/read';
import writeRouter from '../src/routes/write';
import batchWriteRouter from '../src/routes/batch_write';
import devicesRouter from '../src/routes/devices';

const TEST_JWT_SECRET = 'test-secret-key-for-testing';
const TEST_PASSWORD = '12345678';

const DDL = `
  CREATE TABLE users (
    id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
    is_admin BOOLEAN DEFAULT 0 NOT NULL, is_enabled BOOLEAN DEFAULT 1 NOT NULL,
    created_at TEXT DEFAULT (datetime('now')) NOT NULL, totp_enabled BOOLEAN DEFAULT 0 NOT NULL
  );
  CREATE TABLE user_profiles (
    user_id TEXT UNIQUE NOT NULL, display_name TEXT, avatar_file_id TEXT,
    avatar_version INTEGER DEFAULT 0, appearance_json TEXT, ai_config_json TEXT, primary_currency TEXT
  );
  CREATE TABLE refresh_tokens (
    id TEXT PRIMARY KEY, user_id TEXT, device_id TEXT, token_hash TEXT UNIQUE NOT NULL,
    expires_at TEXT NOT NULL, revoked_at TEXT, created_at TEXT
  );
  CREATE TABLE devices (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT DEFAULT 'Unknown Device',
    platform TEXT DEFAULT 'unknown', app_version TEXT, os_version TEXT, device_model TEXT,
    last_ip TEXT, last_seen_at TEXT NOT NULL, revoked_at TEXT, created_at TEXT DEFAULT (datetime('now')) NOT NULL
  );
  CREATE TABLE ledgers (id TEXT PRIMARY KEY, user_id TEXT, external_id TEXT, name TEXT, currency TEXT, month_start_day INTEGER DEFAULT 1, created_at TEXT);
  CREATE TABLE ledger_members (ledger_id TEXT, user_id TEXT, role TEXT, joined_at TEXT);
  CREATE TABLE sync_changes (
    change_id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, ledger_id TEXT, entity_type TEXT,
    entity_sync_id TEXT, action TEXT, payload_json TEXT, updated_at TEXT,
    updated_by_user_id TEXT, updated_by_device_id TEXT, scope TEXT
  );
  CREATE TABLE read_tx_projection (
    ledger_id TEXT, sync_id TEXT, user_id TEXT, tx_type TEXT, amount REAL DEFAULT 0,
    happened_at TEXT, note TEXT, category_sync_id TEXT, category_name TEXT, category_kind TEXT,
    account_sync_id TEXT, account_name TEXT,
    from_account_sync_id TEXT, from_account_name TEXT,
    to_account_sync_id TEXT, to_account_name TEXT,
    tags_csv TEXT, tag_sync_ids_json TEXT, attachments_json TEXT, tx_index INTEGER DEFAULT 0,
    created_by_user_id TEXT, last_edited_by_user_id TEXT, source_change_id INTEGER DEFAULT 0,
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
  CREATE TABLE audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, ledger_id TEXT, action TEXT, metadata_json TEXT, created_at TEXT);
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
`;

let sqlite: DatabaseSync;
let db: D1Database;
let app: Hono<{ Bindings: any; Variables: { userId: string } }>;
let env: { DB: D1Database; JWT_SECRET: string; ALLOW_APP_RW_SCOPES: string };function makeD1(s: DatabaseSync): D1Database {
  return {
    prepare(sql: string) {
      const statement = s.prepare(sql);
      let params: unknown[] = [];
      return {
        bind(...values: unknown[]) { params = values; return this; },
        async run() {
          const r = statement.run(...(params as never[]));
          return { meta: { last_row_id: Number(r.lastInsertRowid), changes: r.changes } };
        },
        async first<T = unknown>() {
          const row = statement.get(...(params as never[])) as T | undefined;
          return row ?? null;
        },
        async all<T = unknown>() {
          return { results: statement.all(...(params as never[])) as T[] };
        },
      };
    },
    async batch(stmts: { run(): Promise<unknown> }[]) {
      s.exec('BEGIN');
      try {
        const out = [];
        for (const st of stmts) out.push(await st.run());
        s.exec('COMMIT');
        return out;
      } catch (e) {
        s.exec('ROLLBACK');
        throw e;
      }
    },
  } as unknown as D1Database;
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:');
  sqlite.exec(DDL);
  db = makeD1(sqlite);
  env = { DB: db, JWT_SECRET: TEST_JWT_SECRET, ALLOW_APP_RW_SCOPES: 'false' };
  app = new Hono<{ Bindings: any; Variables: { userId: string } }>();
  app.use('/api/v1/*', authMiddleware as any);
  app.use('/api/v1/read/*', scopeGuard as any);
  app.use('/api/v1/write/*', scopeGuard as any);
  app.use('/api/v1/devices/*', scopeGuard as any);
  app.route('/api/v1/auth', authRouter);
  app.route('/api/v1/sync', syncRouter);
  app.route('/api/v1/read', readRouter);
  app.route('/api/v1/write', writeRouter);
  app.route('/api/v1/write', batchWriteRouter);
  app.route('/api/v1/devices', devicesRouter);
});

afterEach(() => sqlite.close());

async function api(method: string, path: string, body?: unknown, token?: string): Promise<Response> {
  const headers: Record<string, string> = {};
  headers['CF-Connecting-IP'] = '127.0.0.1';
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  return app.request(path, init, env);
}

async function registerAppUser(email: string): Promise<{ access_token: string; device_id: string }> {
  const res = await api('POST', '/api/v1/auth/register', {
    email,
    password: TEST_PASSWORD,
    client_type: 'app',
    device_name: 'pytest-app',
    platform: 'ios',
  });
  expect(res.status).toBe(200);
  return res.json() as any;
}

async function loginWebUser(email: string): Promise<string> {
  const res = await api('POST', '/api/v1/auth/login', {
    email,
    password: TEST_PASSWORD,
    client_type: 'web',
    device_name: 'pytest-web',
    platform: 'web',
  });
  expect(res.status).toBe(200);
  return (await res.json() as any).access_token;
}

describe('app token scope 门禁(移植上游 test_app_scope_guardrail.py)', () => {
  it('app token push 正常,但 read/write/devices 默认 403;web token 放行', async () => {
    const appUser = await registerAppUser('guardrail@example.com');
    const appToken = appUser.access_token;
    const deviceId = appUser.device_id;

    const push = await api('POST', '/api/v1/sync/push', {
      device_id: deviceId,
      changes: [{
        ledger_id: 'ledger-guardrail',
        entity_type: 'ledger_snapshot',
        entity_sync_id: 'ledger-guardrail',
        action: 'upsert',
        payload: {
          content: '{"ledgerName":"Guardrail","currency":"CNY","count":0,"items":[],"accounts":[],"categories":[],"tags":[]}',
        },
        updated_at: new Date().toISOString(),
      }],
    }, appToken);
    expect(push.status).toBe(200);

    const readBlocked = await api('GET', '/api/v1/read/ledgers', undefined, appToken);
    expect(readBlocked.status).toBe(403);

    const writeBlocked = await api('POST', '/api/v1/write/ledgers/ledger-guardrail/accounts', {
      base_change_id: 1,
      name: 'Cash',
      account_type: 'cash',
      currency: 'CNY',
      initial_balance: 0,
    }, appToken);
    expect(writeBlocked.status).toBe(403);

    const devicesBlocked = await api('GET', '/api/v1/devices', undefined, appToken);
    expect(devicesBlocked.status).toBe(403);

    const webToken = await loginWebUser('guardrail@example.com');
    const readAllowed = await api('GET', '/api/v1/read/ledgers', undefined, webToken);
    expect(readAllowed.status).toBe(200);
  });
});