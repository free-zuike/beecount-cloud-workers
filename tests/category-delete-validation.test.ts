import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { createRealDb } from './helpers/realsql-db';
import writeRouter from '../src/routes/write';

// 移植上游 tests/test_category_delete_validation.py:
// 1) 父分类下有子分类 → 本地 409(上游 ≥400 + child 文案,语义对齐);
// 2) 分类被交易引用:409 拒删(对齐上游,防止 orphan category 污染)
// 3) 空闲叶子分类 → 删除成功且投影行消失。
let sqlite: DatabaseSync;
let db: D1Database;
let app: Hono<{ Bindings: any; Variables: { userId: string } }>;

const TABLES = `
  CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL);
  CREATE TABLE ledgers (id TEXT PRIMARY KEY, external_id TEXT, user_id TEXT, name TEXT, currency TEXT, month_start_day INTEGER DEFAULT 1);
  CREATE TABLE ledger_members (ledger_id TEXT, user_id TEXT, role TEXT, PRIMARY KEY (ledger_id, user_id));
  CREATE TABLE sync_changes (
    change_id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, ledger_id TEXT, entity_type TEXT,
    entity_sync_id TEXT, action TEXT, payload_json TEXT, updated_at TEXT,
    updated_by_user_id TEXT, updated_by_device_id TEXT, scope TEXT
  );
  CREATE TABLE user_category_projection (
    sync_id TEXT PRIMARY KEY, user_id TEXT, name TEXT, kind TEXT, parent_sync_id TEXT, parent_name TEXT,
    icon_cloud_file_id TEXT, icon TEXT, icon_type TEXT, custom_icon_path TEXT, icon_cloud_sha256 TEXT
  );
  CREATE TABLE read_tx_projection (
    ledger_id TEXT, sync_id TEXT, user_id TEXT, tx_type TEXT, amount REAL DEFAULT 0,
    happened_at TEXT, category_sync_id TEXT, category_name TEXT, category_kind TEXT,
    primary key (ledger_id, sync_id)
  );
  CREATE TABLE audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, ledger_id TEXT, action TEXT, metadata_json TEXT, created_at TEXT);
`;

const USER = 'user-1';

function insertCategory(syncId: string, name: string, kind = 'expense', parentSyncId: string | null = null) {
  sqlite.prepare('INSERT INTO user_category_projection (sync_id, user_id, name, kind, parent_sync_id) VALUES (?, ?, ?, ?, ?)')
    .run(syncId, USER, name, kind, parentSyncId);
}

async function deleteCategory(categorySyncId: string) {
  return app.request('/api/v1/write/ledgers/L1/categories/' + categorySyncId, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ base_change_id: 0 }),
  }, { DB: db, JWT_SECRET: 'test-secret' } as any);
}

beforeEach(() => {
  const created = createRealDb();
  sqlite = created.sqlite;
  db = created.db;
  sqlite.exec(TABLES);
  sqlite.prepare("INSERT INTO users (id, email, password_hash) VALUES (?, 'cat@x.com', 'x')").run(USER);
  sqlite.prepare("INSERT INTO ledgers (id, external_id, user_id, name, currency) VALUES ('lg1', 'L1', ?, '账本', 'CNY')").run(USER);
  sqlite.prepare("INSERT INTO ledger_members (ledger_id, user_id, role) VALUES ('lg1', ?, 'owner')").run(USER);

  app = new Hono<{ Bindings: any; Variables: { userId: string } }>();
  app.use('/api/v1/*', async (c, next) => {
    c.set('userId', USER);
    await next();
  });
  app.route('/api/v1/write', writeRouter);
});

afterEach(() => sqlite.close());

describe('分类删除校验(移植上游 test_category_delete_validation.py)', () => {
  it('父分类下有子分类 → 409,错误信息含 child', async () => {
    insertCategory('cat-parent', '餐饮');
    insertCategory('cat-child', '早餐', 'expense', 'cat-parent');

    const res = await deleteCategory('cat-parent');
    expect(res.status).toBe(409);
    const body = await res.json() as any;
    expect(String(body.error).toLowerCase()).toContain('child');

    // 分类还在
    const row = sqlite.prepare("SELECT sync_id FROM user_category_projection WHERE sync_id = 'cat-parent'").get();
    expect(row).toBeDefined();
  });

  it('分类被交易引用 → 409 拒删(对齐上游:防止 orphan)', async () => {
    insertCategory('cat-tx', '交通');
    sqlite.prepare(
      `INSERT INTO read_tx_projection (ledger_id, sync_id, user_id, tx_type, amount, happened_at, category_sync_id, category_name, category_kind)
       VALUES ('lg1', 'tx-1', ?, 'expense', 12.5, '2026-01-01T00:00:00Z', 'cat-tx', '交通', 'expense')`
    ).run(USER);

    const res = await deleteCategory('cat-tx');
    expect(res.status).toBe(409);
    const body = await res.json() as any;
    expect(String(body.error).toLowerCase()).toContain('transaction');

    // 分类还在
    const row = sqlite.prepare("SELECT sync_id FROM user_category_projection WHERE sync_id = 'cat-tx'").get();
    expect(row).toBeDefined();
  });

  it('空闲叶子分类 → 删除成功且投影行消失', async () => {
    insertCategory('cat-leaf', '临时分类');
    const res = await deleteCategory('cat-leaf');
    expect(res.status).toBe(200);

    const row = sqlite.prepare("SELECT sync_id FROM user_category_projection WHERE sync_id = 'cat-leaf'").get();
    expect(row).toBeUndefined();
  });
});