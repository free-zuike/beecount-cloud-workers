// 移植上游 tests/test_attachment_gc.py —— 本地无独立 gc_orphan_attachments 函数
// （逻辑内联在 write.ts 删交易/PATCH 路径，按集成断言覆盖等价语义）：
// 1. 删交易 → 无引用附件删行 + R2 文件删
// 2. 删交易 → 另一笔 tx 还引用 → 保留
// 3. 删分类 → category icon 还被其他分类引用 → 保留
// 4. attachment_files 无该行 → 静默跳过不崩
// 5. R2 unlink 失败 → DB 行仍删
// 6-8. PATCH 附件 prev/new 差集 → 被剔除的触发 GC、共享附件保留（对齐 upsert_tx）
// 豁免：例 9（dedup/空输入）为函数内部细节，本地无独立函数。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import writeRouter from '../src/routes/write';

let sqlite: DatabaseSync;
let db: D1Database;
let app: Hono<{ Bindings: { DB: D1Database; R2?: unknown }; Variables: { userId: string } }>;
let r2Calls: string[];

const USER = 'user-1';

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

const DDL = `
  CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL);
  CREATE TABLE ledgers (id TEXT PRIMARY KEY, user_id TEXT, external_id TEXT, name TEXT, currency TEXT, created_at TEXT);
  CREATE TABLE ledger_members (ledger_id TEXT, user_id TEXT, role TEXT, joined_at TEXT);
  CREATE TABLE sync_changes (
    change_id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, ledger_id TEXT, entity_type TEXT,
    entity_sync_id TEXT, action TEXT, payload_json TEXT, updated_at TEXT,
    updated_by_user_id TEXT, updated_by_device_id TEXT, scope TEXT
  );
  CREATE TABLE read_tx_projection (
    ledger_id TEXT, sync_id TEXT, user_id TEXT, tx_type TEXT, amount REAL DEFAULT 0, happened_at TEXT, note TEXT,
    category_sync_id TEXT, category_name TEXT, category_kind TEXT,
    account_sync_id TEXT, account_name TEXT,
    from_account_sync_id TEXT, from_account_name TEXT,
    to_account_sync_id TEXT, to_account_name TEXT,
    tags_csv TEXT, tag_sync_ids_json TEXT, attachments_json TEXT, tx_index INTEGER DEFAULT 0,
    created_by_user_id TEXT, last_edited_by_user_id TEXT, source_change_id INTEGER DEFAULT 0,
    currency_code TEXT, native_amount REAL,
    exclude_from_stats INTEGER DEFAULT 0, exclude_from_budget INTEGER DEFAULT 0,
    PRIMARY KEY (ledger_id, sync_id)
  );
  CREATE TABLE attachment_files (
    id TEXT PRIMARY KEY, ledger_id TEXT, user_id TEXT, sha256 TEXT,
    size_bytes INTEGER, mime_type TEXT, file_name TEXT, storage_path TEXT,
    attachment_kind TEXT, created_at TEXT
  );
  CREATE TABLE user_category_projection (sync_id TEXT PRIMARY KEY, user_id TEXT, name TEXT, kind TEXT, level INTEGER, sort_order INTEGER, icon TEXT, icon_type TEXT, custom_icon_path TEXT, icon_cloud_file_id TEXT, icon_cloud_sha256 TEXT, parent_name TEXT, parent_sync_id TEXT, source_change_id INTEGER DEFAULT 0);
  CREATE TABLE audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, ledger_id TEXT, action TEXT, metadata_json TEXT, created_at TEXT);
  CREATE TABLE backup_remotes (id TEXT PRIMARY KEY, backend_type TEXT, config_summary TEXT);
`;

function seedAttachment(fileId: string, opts: { storagePath?: string; kind?: string } = {}) {
  sqlite.prepare(
    `INSERT INTO attachment_files (id, ledger_id, user_id, sha256, size_bytes, mime_type, file_name, storage_path, attachment_kind, created_at)
     VALUES (?, 'lg1', ?, ?, 5, 'image/png', 'a.png', ?, ?, '2025-01-01T00:00:00Z')`
  ).run(fileId, USER, fileId, opts.storagePath ?? `attachments/L1/${fileId}.jpg`, opts.kind ?? 'transaction');
}

function seedTx(syncId: string, attachments: Array<{ cloudFileId: string }>) {
  sqlite.prepare(
    `INSERT INTO read_tx_projection (ledger_id, sync_id, user_id, tx_type, amount, happened_at, attachments_json, tx_index, source_change_id)
     VALUES ('lg1', ?, ?, 'expense', 1.0, '2026-04-21T00:00:00Z', ?, 0, 1)`
  ).run(syncId, USER, JSON.stringify(attachments));
}

function seedTxWithPayload(syncId: string, attachments: Array<{ cloudFileId: string }>) {
  seedTx(syncId, attachments);
  sqlite.prepare(
    `INSERT INTO sync_changes (user_id, ledger_id, entity_type, entity_sync_id, action, payload_json, updated_at, updated_by_user_id, updated_by_device_id, scope)
     VALUES (?, 'lg1', 'transaction', ?, 'upsert', ?, '2026-04-21T00:00:00Z', ?, 'web-console', 'ledger')`
  ).run(USER, syncId, JSON.stringify({ syncId, type: 'expense', amount: 1.0, happenedAt: '2026-04-21T00:00:00Z', note: null, attachments }), USER);
}

function makeR2(failDelete = false): unknown {
  return {
    put: async () => ({}) as never,
    get: async () => null as never,
    delete: async (key: string) => {
      r2Calls.push(String(key));
      if (failDelete) throw new Error('simulated unlink failure');
    },
  };
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:');
  sqlite.exec(DDL);
  db = makeD1(sqlite);
  r2Calls = [];
  sqlite.prepare("INSERT INTO users (id, email, password_hash) VALUES (?, 'g@x.com', 'x')").run(USER);
  sqlite.prepare("INSERT INTO ledgers (id, user_id, external_id, name, currency, created_at) VALUES ('lg1', ?, 'L1', 'g', 'CNY', '2025-01-01T00:00:00Z')").run(USER);
  sqlite.prepare("INSERT INTO ledger_members (ledger_id, user_id, role, joined_at) VALUES ('lg1', ?, 'owner', '2025-01-01T00:00:00Z')").run(USER);

  app = new Hono<{ Bindings: { DB: D1Database; R2?: unknown }; Variables: { userId: string } }>();
  app.use('*', async (c, next) => { c.set('userId', USER); await next(); });
  app.route('/api/v1/write', writeRouter);
});

afterEach(() => sqlite.close());

function env(r2: unknown) {
  return { DB: db, R2: r2 } as any;
}

async function deleteTx(txSyncId: string, r2: unknown) {
  return app.request(`/api/v1/write/ledgers/L1/transactions/${txSyncId}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', 'X-Device-ID': 'd1', 'CF-Connecting-IP': '127.0.0.1' },
    body: JSON.stringify({ base_change_id: 0 }),
  }, env(r2));
}

async function deleteCategory(catSyncId: string, r2: unknown) {
  return app.request(`/api/v1/write/ledgers/L1/categories/${catSyncId}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', 'X-Device-ID': 'd1', 'CF-Connecting-IP': '127.0.0.1' },
    body: JSON.stringify({ base_change_id: 0 }),
  }, env(r2));
}

async function patchTx(txSyncId: string, body: Record<string, unknown>, r2: unknown) {
  return app.request(`/api/v1/write/ledgers/L1/transactions/${txSyncId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'X-Device-ID': 'd1', 'CF-Connecting-IP': '127.0.0.1' },
    body: JSON.stringify({ base_change_id: 0, ...body }),
  }, env(r2));
}

describe('attachment GC（移植上游 test_attachment_gc.py，集成断言）', () => {
  it('无引用附件：删交易 → 行删 + R2 文件删', async () => {
    seedAttachment('f-orphan');
    seedTx('tx-1', [{ cloudFileId: 'f-orphan' }]);
    const r2 = makeR2();

    const res = await deleteTx('tx-1', r2);
    expect(res.status).toBe(200);
    const row = sqlite.prepare('SELECT COUNT(*) AS c FROM attachment_files WHERE id = ?').get('f-orphan') as { c: number };
    expect(row.c).toBe(0);
    expect(r2Calls.some(k => k.includes('f-orphan'))).toBe(true);
  });

  it('另一笔 tx 还引用 → 保留（共享附件不误删）', async () => {
    seedAttachment('f-shared');
    seedTx('tx-1', [{ cloudFileId: 'f-shared' }]);
    seedTx('tx-2', [{ cloudFileId: 'f-shared' }]);
    const r2 = makeR2();

    const res = await deleteTx('tx-1', r2);
    expect(res.status).toBe(200);
    const row = sqlite.prepare('SELECT COUNT(*) AS c FROM attachment_files WHERE id = ?').get('f-shared') as { c: number };
    expect(row.c).toBe(1);
    expect(r2Calls.some(k => k.includes('f-shared'))).toBe(false);
  });

  it('删分类：icon 还被其他分类引用 → 保留', async () => {
    seedAttachment('f-iconshared', { kind: 'category_icon' });
    sqlite.prepare(
      "INSERT INTO user_category_projection (sync_id, user_id, name, kind, icon_cloud_file_id, source_change_id) VALUES ('cat-1', ?, 'A', 'expense', 'f-iconshared', 1)"
    ).run(USER);
    sqlite.prepare(
      "INSERT INTO user_category_projection (sync_id, user_id, name, kind, icon_cloud_file_id, source_change_id) VALUES ('cat-2', ?, 'B', 'expense', 'f-iconshared', 1)"
    ).run(USER);
    const r2 = makeR2();

    const res = await deleteCategory('cat-1', r2);
    expect(res.status).toBe(200);
    const row = sqlite.prepare('SELECT COUNT(*) AS c FROM attachment_files WHERE id = ?').get('f-iconshared') as { c: number };
    expect(row.c).toBe(1);
    expect(r2Calls.some(k => k.includes('f-iconshared'))).toBe(false);
  });

  it('attachment_files 无该行 → 静默跳过不崩', async () => {
    seedTx('tx-1', [{ cloudFileId: 'f-nonexistent' }]);
    const r2 = makeR2();

    const res = await deleteTx('tx-1', r2);
    expect(res.status).toBe(200);
  });

  it('R2 unlink 失败 → DB 行仍删', async () => {
    seedAttachment('f-nofile');
    seedTx('tx-1', [{ cloudFileId: 'f-nofile' }]);
    const r2 = makeR2(true);

    const res = await deleteTx('tx-1', r2);
    expect(res.status).toBe(200);
    const row = sqlite.prepare('SELECT COUNT(*) AS c FROM attachment_files WHERE id = ?').get('f-nofile') as { c: number };
    expect(row.c).toBe(0);
  });
});

describe('PATCH 附件 diff 触发 GC（移植上游 upsert_tx prev/new 差集）', () => {
  it('剔除 1 个附件 → 被剔除的 GC，保留的保留', async () => {
    seedAttachment('f-keep');
    seedAttachment('f-drop');
    seedTxWithPayload('tx-multi', [{ cloudFileId: 'f-keep' }, { cloudFileId: 'f-drop' }]);
    const r2 = makeR2();

    const res = await patchTx('tx-multi', { attachments: [{ cloudFileId: 'f-keep' }] }, r2);
    expect(res.status).toBe(200);
    const dropped = sqlite.prepare('SELECT COUNT(*) AS c FROM attachment_files WHERE id = ?').get('f-drop') as { c: number };
    expect(dropped.c).toBe(0);
    expect(r2Calls.some(k => k.includes('f-drop'))).toBe(true);
    const kept = sqlite.prepare('SELECT COUNT(*) AS c FROM attachment_files WHERE id = ?').get('f-keep') as { c: number };
    expect(kept.c).toBe(1);
  });

  it('清空全部附件 → 全部 GC（差集对空 new 正确）', async () => {
    seedAttachment('f-only');
    seedTxWithPayload('tx-empty-after', [{ cloudFileId: 'f-only' }]);
    const r2 = makeR2();

    const res = await patchTx('tx-empty-after', { attachments: [] }, r2);
    expect(res.status).toBe(200);
    const row = sqlite.prepare('SELECT COUNT(*) AS c FROM attachment_files WHERE id = ?').get('f-only') as { c: number };
    expect(row.c).toBe(0);
    expect(r2Calls.some(k => k.includes('f-only'))).toBe(true);
  });

  it('同一 fileId 被另一笔 tx 共享 → 移除后仍保留', async () => {
    seedAttachment('f-dual');
    seedTxWithPayload('tx-A', [{ cloudFileId: 'f-dual' }]);
    seedTx('tx-B', [{ cloudFileId: 'f-dual' }]);
    const r2 = makeR2();

    const res = await patchTx('tx-A', { attachments: [] }, r2);
    expect(res.status).toBe(200);
    const row = sqlite.prepare('SELECT COUNT(*) AS c FROM attachment_files WHERE id = ?').get('f-dual') as { c: number };
    expect(row.c).toBe(1);
    expect(r2Calls.some(k => k.includes('f-dual'))).toBe(false);
  });
});
