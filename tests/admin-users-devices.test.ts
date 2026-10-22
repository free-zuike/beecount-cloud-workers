// 移植上游 tests/test_admin_users_and_devices_api.py
// 管理员可见性:admin 可建用户/看全部设备/软删用户;非 admin 访问 admin 端点被 403。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { authMiddleware } from '../src/middleware/auth';
import authRouter from '../src/routes/auth';
import devicesRouter from '../src/routes/devices';
import adminRouter from '../src/routes/admin';

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
    last_ip TEXT, last_seen_at TEXT NOT NULL, revoked_at TEXT,
    created_at TEXT DEFAULT (datetime('now')) NOT NULL
  );
  CREATE TABLE ledgers (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, external_id TEXT NOT NULL, name TEXT,
    currency TEXT DEFAULT 'CNY' NOT NULL, created_at TEXT, UNIQUE(user_id, external_id)
  );
  CREATE TABLE ledger_members (
    ledger_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT DEFAULT 'editor', joined_at TEXT,
    PRIMARY KEY (ledger_id, user_id)
  );
  CREATE TABLE audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, ledger_id TEXT, action TEXT NOT NULL,
    metadata_json TEXT, created_at TEXT
  );
`;

let sqlite: DatabaseSync;
let db: D1Database;
let app: Hono<{ Bindings: any }>;
let env: { DB: D1Database; JWT_SECRET: string };

function makeD1(s: DatabaseSync): D1Database {
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
  env = { DB: db, JWT_SECRET: TEST_JWT_SECRET };
  app = new Hono<{ Bindings: any }>();
  app.use('/api/v1/*', authMiddleware as any);
  app.route('/api/v1/auth', authRouter);
  app.route('/api/v1/devices', devicesRouter);
  app.route('/api/v1/admin', adminRouter);
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

async function registerWeb(email: string, extra: Record<string, unknown> = {}): Promise<any> {
  const res = await api('POST', '/api/v1/auth/register', {
    email,
    password: TEST_PASSWORD,
    client_type: 'web',
    device_name: `${email}-device`,
    platform: 'web',
    os_version: 'macOS',
    device_model: 'MacBook',
    ...extra,
  });
  expect(res.status).toBe(200);
  return res.json();
}

function setAdmin(userId: string): void {
  sqlite.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(userId);
}

describe('admin 用户与设备 API', () => {
  it('admin 可创建用户、被创建者可登录,非 admin 创建被拒 403', async () => {
    const adminAuth = await registerWeb('admin@example.com');
    const adminToken = adminAuth.access_token as string;
    setAdmin(adminAuth.user.id);

    const created = await api('POST', '/api/v1/admin/users', {
      email: 'created@example.com',
      password: TEST_PASSWORD,
      is_admin: false,
      is_enabled: true,
    }, adminToken);
    expect(created.status).toBe(200);
    const payload = await created.json() as any;
    expect(payload.email).toBe('created@example.com');
    expect(payload.is_admin).toBe(false);
    expect(payload.is_enabled).toBe(true);

    const createdLogin = await api('POST', '/api/v1/auth/login', {
      email: 'created@example.com',
      password: TEST_PASSWORD,
      client_type: 'web',
      device_name: 'created-device',
      platform: 'web',
    });
    expect(createdLogin.status).toBe(200);
    await createdLogin.json();

    const memberAuth = await registerWeb('member@example.com');
    const denied = await api('POST', '/api/v1/admin/users', {
      email: 'x@example.com',
      password: TEST_PASSWORD,
    }, memberAuth.access_token as string);
    expect(denied.status).toBe(403);
    await denied.json();
  });

  it('admin 设备列表含全部用户,非 admin 访问 admin 设备端点被 403,app 设备端点只返回自己', async () => {
    const adminAuth = await registerWeb('admin@example.com', { app_version: '2.0.0' });
    const adminToken = adminAuth.access_token as string;
    setAdmin(adminAuth.user.id);

    await registerWeb('member@example.com', { app_version: '3.1.0' });
    const memberLogin = await api('POST', '/api/v1/auth/login', {
      email: 'member@example.com',
      password: TEST_PASSWORD,
      client_type: 'web',
      device_name: 'member@example.com-device',
      platform: 'web',
      app_version: '3.1.0',
      os_version: 'macOS',
      device_model: 'MacBook',
    });
    expect(memberLogin.status).toBe(200);
    const memberBody = await memberLogin.json() as any;
    const memberToken = memberBody.access_token as string;

    const adminDevices = await api('GET', '/api/v1/admin/devices', undefined, adminToken);
    expect(adminDevices.status).toBe(200);
    const adminItems = (await adminDevices.json() as any).items as any[];
    const emails = new Set(adminItems.map((r) => r.user_email));
    expect(emails.has('admin@example.com')).toBe(true);
    expect(emails.has('member@example.com')).toBe(true);
    expect(adminItems.some((r) => ['2.0.0', '3.1.0'].includes(r.app_version))).toBe(true);

    const memberAdminView = await api('GET', '/api/v1/admin/devices', undefined, memberToken);
    expect(memberAdminView.status).toBe(403);
    await memberAdminView.json();

    const appDevices = await api('GET', '/api/v1/devices', undefined, memberToken);
    expect(appDevices.status).toBe(200);
    const appItems = await appDevices.json() as any[];
    expect(appItems.length).toBeGreaterThanOrEqual(1);
    expect(appItems.some((r) => (r.session_count || 0) >= 2)).toBe(true);
    for (const row of appItems) {
      expect('session_count' in row).toBe(true);
      expect('app_version' in row).toBe(true);
      expect('os_version' in row).toBe(true);
      expect('device_model' in row).toBe(true);
      expect('last_ip' in row).toBe(true);
    }

    const sessionView = await api('GET', '/api/v1/devices?view=sessions&active_within_days=0', undefined, memberToken);
    expect(sessionView.status).toBe(200);
    const sessionItems = await sessionView.json() as any[];
    expect(sessionItems.length).toBeGreaterThanOrEqual(2);
    for (const row of sessionItems) {
      expect(row.session_count).toBe(1);
    }
  });

  it('admin 软删用户:默认/status=all/status=disabled 列表可见性、禁用后登录 403、删除自己 400', async () => {
    const adminAuth = await registerWeb('admin@example.com');
    const adminToken = adminAuth.access_token as string;
    setAdmin(adminAuth.user.id);
    const memberAuth = await registerWeb('member@example.com');
    const memberUserId = memberAuth.user.id as string;

    const deleted = await api('DELETE', `/api/v1/admin/users/${memberUserId}`, undefined, adminToken);
    expect(deleted.status).toBe(200);
    const payload = await deleted.json() as any;
    expect(payload.id).toBe(memberUserId);
    expect(payload.is_enabled).toBe(false);
    expect(payload.is_admin).toBe(false);

    const defaultUsers = await api('GET', '/api/v1/admin/users', undefined, adminToken);
    expect(defaultUsers.status).toBe(200);
    const defaultItems = (await defaultUsers.json() as any).items as any[];
    const defaultRow = defaultItems.find((r) => r.id === memberUserId);
    expect(defaultRow).toBeDefined();
    expect(defaultRow.is_enabled).toBe(false);

    const allUsers = await api('GET', '/api/v1/admin/users?status=all', undefined, adminToken);
    expect(allUsers.status).toBe(200);
    const allMap = new Map(((await allUsers.json() as any).items as any[]).map((r) => [r.id, r]));
    expect(allMap.has(memberUserId)).toBe(true);
    expect(allMap.get(memberUserId).is_enabled).toBe(false);

    const disabledOnly = await api('GET', '/api/v1/admin/users?status=disabled', undefined, adminToken);
    expect(disabledOnly.status).toBe(200);
    const disabledIds = new Set(((await disabledOnly.json() as any).items as any[]).map((r) => r.id));
    expect(disabledIds.has(memberUserId)).toBe(true);

    const deniedLogin = await api('POST', '/api/v1/auth/login', {
      email: 'member@example.com',
      password: TEST_PASSWORD,
      client_type: 'web',
      device_name: 'member-disabled',
      platform: 'web',
    });
    expect(deniedLogin.status).toBe(403);
    await deniedLogin.json();

    const deleteSelf = await api('DELETE', `/api/v1/admin/users/${adminAuth.user.id}`, undefined, adminToken);
    expect(deleteSelf.status).toBe(400);
    await deleteSelf.json();
  });
});