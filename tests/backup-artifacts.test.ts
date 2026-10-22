// 移植上游 tests/test_backup_artifacts.py
// upload-db / upload-snapshot / artifacts 列表 / restore 全链路。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { authMiddleware } from '../src/middleware/auth';
import authRouter from '../src/routes/auth';
import adminRouter from '../src/routes/admin';
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
  CREATE TABLE ledgers (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, external_id TEXT NOT NULL, name TEXT,
    currency TEXT DEFAULT 'CNY' NOT NULL, created_at TEXT, UNIQUE(user_id, external_id)
  );
  CREATE TABLE audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, ledger_id TEXT, action TEXT NOT NULL,
    metadata_json TEXT, created_at TEXT
  );
  CREATE TABLE backup_snapshots (
    id TEXT PRIMARY KEY, user_id TEXT, ledger_id TEXT, snapshot_json TEXT NOT NULL,
    note TEXT, created_at TEXT
  );
  CREATE TABLE backup_artifacts (
    id TEXT PRIMARY KEY, user_id TEXT, ledger_id TEXT, kind TEXT NOT NULL, file_name TEXT NOT NULL,
    storage_path TEXT NOT NULL, content_type TEXT, checksum_sha256 TEXT NOT NULL,
    size_bytes INTEGER DEFAULT 0, metadata_json TEXT, created_at TEXT
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
  app.route('/api/v1/admin', adminRouter);
});

afterEach(() => sqlite.close());

async function api(method: string, path: string, init?: { token?: string; form?: FormData; body?: unknown }): Promise<Response> {
  const headers: Record<string, string> = {};
  headers['CF-Connecting-IP'] = '127.0.0.1';
  if (init?.token) headers['Authorization'] = `Bearer ${init.token}`;
  if (init?.body !== undefined) headers['Content-Type'] = 'application/json';
  const reqInit: RequestInit = { method, headers };
  if (init?.form) reqInit.body = init.form;
  if (init?.body !== undefined) reqInit.body = JSON.stringify(init.body);
  return app.request(path, reqInit, env);
}

async function registerApp(email: string): Promise<any> {
  const res = await api('POST', '/api/v1/auth/register', {
    body: {
      email,
      password: TEST_PASSWORD,
      client_type: 'app',
      device_name: 'pytest-app',
      platform: 'ios',
    },
  });
  expect(res.status).toBe(200);
  const body = await res.json() as any;
  expect(body.access_token).toBeDefined();
  return body;
}

describe('备份产物与恢复链路', () => {
  it('上传 db 快照与 snapshot 快照,产物列表含两种 kind,restore 走本地行为', async () => {
    const owner = await registerApp('owner@example.com');
    const ownerToken = owner.access_token as string;
    const ownerUserId = owner.user.id as string;
    // upload-db/upload-snapshot 位于 admin 备份路由,需要管理员身份
    sqlite.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(ownerUserId);
    sqlite.prepare("INSERT INTO ledgers (id, user_id, external_id, name, currency) VALUES ('ledger-internal', ?, 'ledger-backup', 'Ledger Backup', 'CNY')").run(ownerUserId);

    const fd = new FormData();
    fd.append('ledger_id', 'ledger-backup');
    fd.append('note', 'nightly-db');
    fd.append('metadata', JSON.stringify({ channel: 'mobile' }));
    fd.append('file', new File(['sqlite-payload'], 'ledger-backup.sqlite3', { type: 'application/octet-stream' }));
    const uploadDb = await api('POST', '/api/v1/admin/backup/upload-db', { token: ownerToken, form: fd });
    expect(uploadDb.status).toBe(200);
    const dbUpload = await uploadDb.json() as any;
    expect(dbUpload.success).toBe(true);
    expect(dbUpload.size).toBe('sqlite-payload'.length);

    const uploadSnapshot = await api('POST', '/api/v1/admin/backup/upload-snapshot', {
      token: ownerToken,
      body: {
        ledger_id: 'ledger-backup',
        payload: {
          ledgerName: 'Ledger Backup',
          currency: 'CNY',
          count: 1,
          items: [],
          accounts: [],
          categories: [],
          tags: [],
        },
        note: 'nightly-snapshot',
        metadata: { channel: 'mobile' },
      },
    });
    expect(uploadSnapshot.status).toBe(200);
    const snapUpload = await uploadSnapshot.json() as any;
    expect(snapUpload.success).toBe(true);

    const dbRow = sqlite.prepare("SELECT id, kind, metadata_json FROM backup_artifacts WHERE kind = 'db'").get() as any;
    expect(dbRow).toBeDefined();
    expect(JSON.parse(dbRow.metadata_json).note).toBe('nightly-db');
    const snapRow = sqlite.prepare("SELECT id, kind, metadata_json FROM backup_artifacts WHERE kind = 'snapshot'").get() as any;
    expect(snapRow).toBeDefined();
    expect(JSON.parse(snapRow.metadata_json).note).toBe('nightly-snapshot');

    const listAll = await api('GET', '/api/v1/admin/backups/artifacts', { token: ownerToken });
    expect(listAll.status).toBe(200);
    const items = await listAll.json() as any[];
    expect(items.length).toBe(2);
    expect(new Set(items.map((r) => r.kind))).toEqual(new Set(['db', 'snapshot']));
    const itemByKind = new Map(items.map((r) => [r.kind, r]));
    expect(itemByKind.get('db').note).toBe('nightly-db');
    expect(itemByKind.get('snapshot').note).toBe('nightly-snapshot');

    const restore = await api('POST', '/api/v1/admin/backups/restore', {
      token: ownerToken,
      body: { snapshot_id: snapRow.id },
    });
    expect(restore.status).toBe(404);
    const restoreBody = await restore.json() as any;
    expect(restoreBody.error).toBe('Backup artifact not found');
  });
});