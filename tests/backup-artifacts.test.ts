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
  CREATE TABLE read_tx_projection (
    ledger_id TEXT, sync_id TEXT, user_id TEXT, tx_type TEXT, amount REAL, happened_at TEXT, note TEXT,
    category_sync_id TEXT, category_name TEXT, category_kind TEXT,
    account_sync_id TEXT, account_name TEXT,
    from_account_sync_id TEXT, from_account_name TEXT,
    to_account_sync_id TEXT, to_account_name TEXT,
    tags_csv TEXT, tag_sync_ids_json TEXT, attachments_json TEXT, tx_index INTEGER, source_change_id INTEGER,
    exclude_from_stats INTEGER, exclude_from_budget INTEGER,
    created_by_user_id TEXT, last_edited_by_user_id TEXT, currency_code TEXT, native_amount REAL
  );
  CREATE TABLE user_account_projection (
    sync_id TEXT NOT NULL, user_id TEXT NOT NULL, name TEXT, account_type TEXT, currency TEXT,
    initial_balance REAL, note TEXT, credit_limit REAL, billing_day INTEGER, payment_due_day INTEGER,
    bank_name TEXT, card_last_four TEXT, hidden INTEGER NOT NULL DEFAULT 0, source_change_id INTEGER DEFAULT 0,
    PRIMARY KEY (user_id, sync_id)
  );
  CREATE TABLE user_category_projection (sync_id TEXT NOT NULL, user_id TEXT NOT NULL, name TEXT, kind TEXT, level INTEGER, sort_order INTEGER, icon TEXT, icon_type TEXT, custom_icon_path TEXT, icon_cloud_file_id TEXT, icon_cloud_sha256 TEXT, parent_name TEXT, parent_sync_id TEXT, source_change_id INTEGER DEFAULT 0, PRIMARY KEY (user_id, sync_id));
  CREATE TABLE user_tag_projection (sync_id TEXT NOT NULL, user_id TEXT NOT NULL, name TEXT, color TEXT, source_change_id INTEGER, PRIMARY KEY (user_id, sync_id));
  CREATE TABLE read_budget_projection (ledger_id TEXT, sync_id TEXT, user_id TEXT, budget_type TEXT, category_sync_id TEXT, amount REAL, period TEXT, start_day INTEGER, enabled INTEGER DEFAULT 1, source_change_id INTEGER DEFAULT 0);
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

describe('恢复带回整个账本（对齐上游：账户/分类/标签/预算一并回写）', () => {
  it('restore 把快照中的 accounts/categories/tags/budgets 一并写回投影表', async () => {
    const owner = await registerApp('restore-full@example.com');
    const ownerToken = owner.access_token as string;
    const ownerUserId = owner.user.id as string;
    sqlite.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(ownerUserId);
    sqlite
      .prepare("INSERT INTO ledgers (id, user_id, external_id, name, currency) VALUES ('L-full', ?, 'L-full-ext', 'Full', 'CNY')")
      .run(ownerUserId);

    const snapshot = {
      ledger_external_id: 'L-full-ext',
      accounts: [{ sync_id: 'a1', user_id: ownerUserId, name: '现金', account_type: 'asset', currency: 'CNY', initial_balance: 0 }],
      categories: [{ sync_id: 'c1', user_id: ownerUserId, name: '餐饮', kind: 'expense', level: 0, sort_order: 0, icon: '🍜', icon_type: 'emoji' }],
      tags: [{ sync_id: 't1', user_id: ownerUserId, name: '午饭', color: '#ffffff' }],
      budgets: [{ ledger_id: 'L-full', sync_id: 'b1', user_id: ownerUserId, budget_type: 'monthly', category_sync_id: 'c1', amount: 100, period: 'monthly', start_day: 1, enabled: 1 }],
      transactions: [{
        sync_id: 'x1', tx_type: 'expense', amount: 10, happened_at: '2026-05-01T00:00:00Z', note: 'n',
        category_sync_id: 'c1', category_name: '餐饮', category_kind: 'expense',
        account_sync_id: 'a1', account_name: '现金',
        from_account_sync_id: null, from_account_name: null, to_account_sync_id: null, to_account_name: null,
        tags_csv: '午饭', tag_sync_ids_json: '["t1"]', attachments_json: null, tx_index: 0, source_change_id: 0,
        exclude_from_stats: 0, exclude_from_budget: 0, created_by_user_id: ownerUserId, last_edited_by_user_id: ownerUserId,
        currency_code: 'CNY', native_amount: 10,
      }],
    };
    sqlite
      .prepare('INSERT INTO backup_snapshots (id, user_id, ledger_id, snapshot_json) VALUES (?, ?, ?, ?)')
      .run('snap-full', ownerUserId, 'L-full', JSON.stringify(snapshot));

    const restore = await api('POST', '/api/v1/admin/backups/restore', {
      token: ownerToken,
      body: { snapshot_id: 'snap-full' },
    });
    expect(restore.status).toBe(200);

    const acc = sqlite.prepare('SELECT sync_id FROM user_account_projection WHERE user_id = ? AND sync_id = ?').get(ownerUserId, 'a1');
    expect(acc).toBeTruthy();
    const cat = sqlite.prepare('SELECT sync_id FROM user_category_projection WHERE user_id = ? AND sync_id = ?').get(ownerUserId, 'c1');
    expect(cat).toBeTruthy();
    const tag = sqlite.prepare('SELECT sync_id FROM user_tag_projection WHERE user_id = ? AND sync_id = ?').get(ownerUserId, 't1');
    expect(tag).toBeTruthy();
    const bud = sqlite.prepare('SELECT sync_id FROM read_budget_projection WHERE ledger_id = ? AND sync_id = ?').get('L-full', 'b1');
    expect(bud).toBeTruthy();
    const tx = sqlite.prepare('SELECT sync_id FROM read_tx_projection WHERE ledger_id = ? AND sync_id = ?').get('L-full', 'x1');
    expect(tx).toBeTruthy();
  });

  it('端到端：AdminBackupCreate 产出快照 → restore 完整回写 5 类实体（模拟与原版互通的字段格式）', async () => {
    const owner = await registerApp('e2e-restore@example.com');
    const ownerToken = owner.access_token as string;
    const ownerUserId = owner.user.id as string;
    sqlite.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(ownerUserId);
    sqlite.prepare("INSERT INTO ledgers (id, user_id, external_id, name, currency) VALUES ('L1-i', ?, 'L1', 'L1', 'CNY')").run(ownerUserId);

    sqlite.prepare(`INSERT INTO user_account_projection (sync_id, user_id, name, account_type, currency, initial_balance) VALUES (?, ?, ?, ?, ?, ?)`)
      .run('a1', ownerUserId, '现金', 'asset', 'CNY', 0);
    sqlite.prepare(`INSERT INTO user_category_projection (sync_id, user_id, name, kind) VALUES (?, ?, ?, ?)`)
      .run('c1', ownerUserId, '餐饮', 'expense');
    sqlite.prepare(`INSERT INTO user_tag_projection (sync_id, user_id, name, color) VALUES (?, ?, ?, ?)`)
      .run('t1', ownerUserId, '午饭', '#ffffff');
    sqlite.prepare(`INSERT INTO read_budget_projection (ledger_id, sync_id, user_id, budget_type, category_sync_id, amount, period, start_day, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('L1-i', 'b1', ownerUserId, 'monthly', 'c1', 100, 'monthly', 1, 1);
    sqlite.prepare(`INSERT INTO read_tx_projection (ledger_id, sync_id, user_id, tx_type, amount, happened_at, note, category_sync_id, category_name, category_kind, account_sync_id, account_name, tags_csv, tag_sync_ids_json, tx_index, source_change_id, created_by_user_id, last_edited_by_user_id, currency_code, native_amount) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run('L1-i', 'x1', ownerUserId, 'expense', 10, '2026-05-01T00:00:00Z', 'n', 'c1', '餐饮', 'expense', 'a1', '现金', '午饭', '["t1"]', 0, 0, ownerUserId, ownerUserId, 'CNY', 10);

    // 1) 真实 create 端点产出快照（验证 create 与 restore 的格式一致）
    const create = await api('POST', '/api/v1/admin/backups/create', { token: ownerToken, body: { ledger_id: 'L1' } });
    expect(create.status).toBe(201);
    const snapId = ((await create.json()) as { snapshot_id: string }).snapshot_id;

    // 2) 清空投影表，模拟数据丢失后从快照恢复
    sqlite.prepare('DELETE FROM read_tx_projection WHERE ledger_id = ?').run('L1-i');
    sqlite.prepare('DELETE FROM user_account_projection WHERE user_id = ?').run(ownerUserId);
    sqlite.prepare('DELETE FROM user_category_projection WHERE user_id = ?').run(ownerUserId);
    sqlite.prepare('DELETE FROM user_tag_projection WHERE user_id = ?').run(ownerUserId);
    sqlite.prepare('DELETE FROM read_budget_projection WHERE ledger_id = ?').run('L1-i');

    // 3) restore
    const restore = await api('POST', '/api/v1/admin/backups/restore', { token: ownerToken, body: { snapshot_id: snapId } });
    expect(restore.status).toBe(200);

    // 4) 5 类实体全部找回
    expect(sqlite.prepare('SELECT sync_id FROM read_tx_projection WHERE ledger_id=? AND sync_id=?').get('L1-i', 'x1')).toBeTruthy();
    expect(sqlite.prepare('SELECT sync_id FROM user_account_projection WHERE user_id=? AND sync_id=?').get(ownerUserId, 'a1')).toBeTruthy();
    expect(sqlite.prepare('SELECT sync_id FROM user_category_projection WHERE user_id=? AND sync_id=?').get(ownerUserId, 'c1')).toBeTruthy();
    expect(sqlite.prepare('SELECT sync_id FROM user_tag_projection WHERE user_id=? AND sync_id=?').get(ownerUserId, 't1')).toBeTruthy();
    expect(sqlite.prepare('SELECT sync_id FROM read_budget_projection WHERE ledger_id=? AND sync_id=?').get('L1-i', 'b1')).toBeTruthy();
  });

  it('向后兼容：仅含 transactions 的部分快照也能安全恢复（缺失实体数组不报错）', async () => {
    const owner = await registerApp('legacy-restore@example.com');
    const ownerToken = owner.access_token as string;
    const ownerUserId = owner.user.id as string;
    sqlite.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(ownerUserId);
    sqlite.prepare("INSERT INTO ledgers (id, user_id, external_id, name, currency) VALUES ('L2-i', ?, 'L2', 'L2', 'CNY')").run(ownerUserId);
    sqlite.prepare(`INSERT INTO read_tx_projection (ledger_id, sync_id, user_id, tx_type, amount, happened_at, note, category_sync_id, category_name, category_kind, account_sync_id, account_name, tags_csv, tag_sync_ids_json, tx_index, source_change_id, created_by_user_id, last_edited_by_user_id, currency_code, native_amount) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run('L2-i', 'x2', ownerUserId, 'expense', 10, '2026-05-01T00:00:00Z', 'n', 'c1', '餐饮', 'expense', 'a1', '现金', '午饭', '["t1"]', 0, 0, ownerUserId, ownerUserId, 'CNY', 10);

    // 旧式/部分快照：只有 transactions，没有 accounts/categories/tags/budgets（模拟旧上游或早期格式）
    const snapshot = {
      ledger_external_id: 'L2',
      transactions: [{ sync_id: 'x2', tx_type: 'expense', amount: 10, happened_at: '2026-05-01T00:00:00Z', note: 'n', category_sync_id: 'c1', category_name: '餐饮', category_kind: 'expense', account_sync_id: 'a1', account_name: '现金', tags_csv: '午饭', tag_sync_ids_json: '["t1"]', tx_index: 0, source_change_id: 0, created_by_user_id: ownerUserId, last_edited_by_user_id: ownerUserId, currency_code: 'CNY', native_amount: 10 }],
    };
    sqlite.prepare('INSERT INTO backup_snapshots (id, user_id, ledger_id, snapshot_json) VALUES (?, ?, ?, ?)')
      .run('snap-legacy', ownerUserId, 'L2-i', JSON.stringify(snapshot));

    const restore = await api('POST', '/api/v1/admin/backups/restore', { token: ownerToken, body: { snapshot_id: 'snap-legacy' } });
    expect(restore.status).toBe(200);
    expect(sqlite.prepare('SELECT sync_id FROM read_tx_projection WHERE ledger_id=? AND sync_id=?').get('L2-i', 'x2')).toBeTruthy();
  });
});