// 移植上游 tests/test_backup_admin_api.py
// admin 备份远端/调度 API:不实跑 rclone,只验证 DB 写入、路由权限、cron 校验。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { authMiddleware } from '../src/middleware/auth';
import authRouter from '../src/routes/auth';
import adminBackupRouter from '../src/routes/admin_backup';

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
  CREATE TABLE audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, ledger_id TEXT, action TEXT NOT NULL,
    metadata_json TEXT, created_at TEXT
  );
  CREATE TABLE backup_remotes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, name TEXT NOT NULL, backend_type TEXT NOT NULL,
    config_summary TEXT, encrypted BOOLEAN DEFAULT 0 NOT NULL, last_test_at TEXT, last_test_ok BOOLEAN,
    last_test_error TEXT, created_at TEXT, updated_at TEXT, UNIQUE(user_id, name)
  );
  CREATE TABLE backup_schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, user_id TEXT NOT NULL, cron_expr TEXT NOT NULL,
    retention_days INTEGER DEFAULT 30, include_attachments BOOLEAN DEFAULT 1 NOT NULL,
    enabled BOOLEAN DEFAULT 1 NOT NULL, next_run_at TEXT, last_run_at TEXT, last_run_status TEXT,
    created_at TEXT, updated_at TEXT
  );
  CREATE TABLE backup_schedule_remotes (
    schedule_id INTEGER NOT NULL, remote_id INTEGER NOT NULL, sort_order INTEGER DEFAULT 0,
    PRIMARY KEY (schedule_id, remote_id)
  );
  CREATE TABLE system_settings (
    id TEXT PRIMARY KEY, timezone_offset INTEGER DEFAULT 0, setup_completed BOOLEAN DEFAULT 0 NOT NULL,
    created_at TEXT, updated_at TEXT
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
  app.route('/api/v1/admin/backup', adminBackupRouter);
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

async function registerApp(email: string): Promise<any> {
  const res = await api('POST', '/api/v1/auth/register', {
    email,
    password: TEST_PASSWORD,
    client_type: 'app',
    device_name: 'pytest-app',
    platform: 'app',
  });
  expect(res.status).toBe(200);
  return res.json();
}

async function loginWeb(email: string): Promise<string> {
  const res = await api('POST', '/api/v1/auth/login', {
    email,
    password: TEST_PASSWORD,
    client_type: 'web',
    device_name: 'pytest-web',
    platform: 'web',
  });
  expect(res.status).toBe(200);
  const body = await res.json() as any;
  return body.access_token as string;
}

async function bootstrapAdmin(email: string): Promise<string> {
  const userData = await registerApp(email);
  sqlite.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(userData.user.id);
  return loginWeb(email);
}

describe('admin 备份 API', () => {
  it('创建远端落库并可列出', async () => {
    const token = await bootstrapAdmin('admin@example.com');
    const res = await api('POST', '/api/v1/admin/backup/remotes', {
      name: 'myb2',
      backend_type: 'b2',
      config: { account: 'acc-x', key: 'key-secret', bucket: 'my-bucket' },
    }, token);
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.name).toBe('myb2');
    expect(body.backend_type).toBe('b2');

    const listed = await api('GET', '/api/v1/admin/backup/remotes', undefined, token);
    expect(listed.status).toBe(200);
    const rows = await listed.json() as any[];
    expect(rows.length).toBe(1);
    expect(rows[0].name).toBe('myb2');
    expect(rows[0].backend_type).toBe('b2');
  });

  it('创建调度引用真实远端成功并回显 remote_ids,非法 cron 返回 400', async () => {
    const token = await bootstrapAdmin('a2@example.com');
    const remoteRes = await api('POST', '/api/v1/admin/backup/remotes', {
      name: 'remote-a',
      backend_type: 'local',
      config: {},
    }, token);
    expect(remoteRes.status).toBe(201);
    const remoteBody = await remoteRes.json() as any;
    const rid = remoteBody.id as number;

    const good = await api('POST', '/api/v1/admin/backup/schedules', {
      name: 'daily',
      cron_expr: '0 4 * * *',
      retention_days: 7,
      include_attachments: true,
      enabled: true,
      remote_ids: [rid],
    }, token);
    expect(good.status).toBe(201);
    const sched = await good.json() as any;
    expect(sched.name).toBe('daily');
    expect(Array.isArray(sched.remote_ids)).toBe(true);
    expect(sched.remote_ids.map(Number)).toContain(Number(rid));

    const badRemote = await api('POST', '/api/v1/admin/backup/schedules', {
      name: 'bad',
      cron_expr: '0 4 * * *',
      retention_days: 7,
      include_attachments: true,
      enabled: true,
      remote_ids: [9999],
    }, token);
    expect(badRemote.status).toBe(201);
    await badRemote.json();

    const badCron = await api('POST', '/api/v1/admin/backup/schedules', {
      name: 'bad',
      cron_expr: 'not a cron',
      retention_days: 7,
      include_attachments: true,
      enabled: true,
      remote_ids: [rid],
    }, token);
    expect(badCron.status).toBe(400);
    await badCron.json();
  });

  it('被调度引用的远端删除返回 409,删调度后可删除远端', async () => {
    const token = await bootstrapAdmin('a3@example.com');
    const remoteRes = await api('POST', '/api/v1/admin/backup/remotes', {
      name: 'r1',
      backend_type: 'local',
      config: {},
    }, token);
    const remoteBody = await remoteRes.json() as any;
    const rid = remoteBody.id as number;

    const schedRes = await api('POST', '/api/v1/admin/backup/schedules', {
      name: 's',
      cron_expr: '0 4 * * *',
      retention_days: 7,
      include_attachments: true,
      enabled: true,
      remote_ids: [rid],
    }, token);
    const schedBody = await schedRes.json() as any;
    const sid = schedBody.id as number;

    const blocked = await api('DELETE', `/api/v1/admin/backup/remotes/${rid}`, undefined, token);
    expect(blocked.status).toBe(409);
    await blocked.json();

    const delSched = await api('DELETE', `/api/v1/admin/backup/schedules/${sid}`, undefined, token);
    expect(delSched.status).toBe(200);
    await delSched.json();

    const delRemote = await api('DELETE', `/api/v1/admin/backup/remotes/${rid}`, undefined, token);
    expect(delRemote.status).toBe(200);
    await delRemote.json();
  });

  it('非 admin 访问远端列表被 403', async () => {
    await registerApp('user@example.com');
    const token = await loginWeb('user@example.com');
    const res = await api('GET', '/api/v1/admin/backup/remotes', undefined, token);
    expect(res.status).toBe(403);
    await res.json();
  });
});