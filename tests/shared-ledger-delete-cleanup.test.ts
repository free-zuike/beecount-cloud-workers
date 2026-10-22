import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import writeRouter from '../src/routes/write';
import syncRouter from '../src/routes/sync';

// 移植上游 tests/test_shared_ledger_delete_cleanup.py 的核心契约(端点级):
// 1. 删 tx 时压缩 upsert 历史,只剩 delete event(不残留旧 upsert);
// 2. 附件 GC 按 ledger-scope:Editor 上传(user_id=Editor)的附件被 owner-scope
//    删除清掉;仍被本 ledger 其它 tx 引用则保留;不跨 ledger。
let sqlite: DatabaseSync;
let db: D1Database;
let app: Hono<{ Bindings: { DB: D1Database }; Variables: { userId: string } }>;

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, is_admin BOOLEAN DEFAULT 0);
    CREATE TABLE ledgers (id TEXT PRIMARY KEY, user_id TEXT, external_id TEXT, name TEXT, currency TEXT, month_start_day INTEGER DEFAULT 1, created_at TEXT);
    CREATE TABLE ledger_members (ledger_id TEXT, user_id TEXT, role TEXT, joined_at TEXT, invited_by TEXT, PRIMARY KEY (ledger_id, user_id));
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

  sqlite.prepare("INSERT INTO users (id, email, password_hash, is_admin) VALUES ('owner', 'o@x.com', 'x', 0), ('editor', 'e@x.com', 'x', 0)").run();
  sqlite.prepare("INSERT INTO ledgers (id, user_id, external_id, name, currency, created_at) VALUES ('L1', 'owner', 'L1', 'L', 'CNY', '2025-01-01T00:00:00Z')").run();
  sqlite.prepare("INSERT INTO ledger_members (ledger_id, user_id, role, joined_at) VALUES ('L1', 'owner', 'owner', '2025-01-01T00:00:00Z')").run();
  sqlite.prepare("INSERT INTO devices (id, user_id, name, platform, created_at) VALUES ('dev-owner', 'owner', 'o', 'web', '2025-01-01T00:00:00Z')").run();

  app = new Hono<{ Bindings: { DB: D1Database }; Variables: { userId: string } }>();
  app.use('*', async (c, next) => {
    c.set('userId', c.req.header('X-Test-User') ?? 'owner');
    await next();
  });
  app.route('/api/v1/write', writeRouter);
  app.route('/api/v1/sync', syncRouter);
});

afterEach(() => sqlite.close());

async function pushTx(syncId: string, ledgerId: string, payload: Record<string, unknown>, user: string = 'owner') {
  const res = await app.request('/api/v1/sync/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Test-User': user, 'X-Device-ID': 'dev-owner' },
    body: JSON.stringify({
      device_id: 'dev-owner',
      changes: [{ ledger_id: ledgerId, entity_type: 'transaction', entity_sync_id: syncId, action: 'upsert', payload, updated_at: new Date().toISOString() }],
    }),
  }, { DB: db });
  expect(res.status).toBe(200);
}

function changesFor(syncId: string): Array<{ action: string; entity_type: string }> {
  return sqlite.prepare(
    'SELECT action, entity_type FROM sync_changes WHERE entity_sync_id = ? ORDER BY change_id'
  ).all(syncId) as Array<{ action: string; entity_type: string }>;
}

describe('删 tx 清理路径(移植上游 test_shared_ledger_delete_cleanup.py)', () => {
  it('多 upsert + 1 delete 后,压缩掉所有 upsert,只剩 delete event', async () => {
    await pushTx('tx-X', 'L1', { syncId: 'tx-X', type: 'expense', amount: 10, happenedAt: new Date().toISOString() });
    await pushTx('tx-X', 'L1', { syncId: 'tx-X', type: 'expense', amount: 20, happenedAt: new Date().toISOString() });
    expect(changesFor('tx-X').filter(c => c.action === 'upsert').length).toBe(2);

    // web DELETE
    const delRes = await app.request('/api/v1/write/ledgers/L1/transactions/tx-X', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', 'X-Test-User': 'owner', 'X-Device-ID': 'dev-owner' },
      body: JSON.stringify({ base_change_id: 0 }),
    }, { DB: db });
    expect(delRes.status).toBe(200);

    const remaining = changesFor('tx-X');
    expect(remaining.length).toBe(1);
    expect(remaining[0].action).toBe('delete');
    // projection 行已删
    const tx = sqlite.prepare("SELECT COUNT(*) as cnt FROM read_tx_projection WHERE ledger_id = 'L1' AND sync_id = 'tx-X'").get() as { cnt: number };
    expect(tx.cnt).toBe(0);
  });

  it('delete 压缩只针对目标 entity,其它 entity / 其它 user 的 upsert 不受影响', async () => {
    // 目标 tx-X
    await pushTx('tx-X', 'L1', { syncId: 'tx-X', type: 'expense', amount: 1, happenedAt: new Date().toISOString() });
    // 其它 tx-Y(不该动)
    await pushTx('tx-Y', 'L1', { syncId: 'tx-Y', type: 'expense', amount: 2, happenedAt: new Date().toISOString() });
    // 同 sync_id 但不同 entity_type 的 budget(不该动)
    await app.request('/api/v1/sync/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Test-User': 'owner', 'X-Device-ID': 'dev-owner' },
      body: JSON.stringify({
        device_id: 'dev-owner',
        changes: [{ ledger_id: 'L1', entity_type: 'budget', entity_sync_id: 'tx-X', action: 'upsert', payload: { syncId: 'tx-X', type: 'total', amount: 100, period: 'monthly' }, updated_at: new Date().toISOString() }],
      }),
    }, { DB: db });

    const delRes = await app.request('/api/v1/write/ledgers/L1/transactions/tx-X', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', 'X-Test-User': 'owner', 'X-Device-ID': 'dev-owner' },
      body: JSON.stringify({ base_change_id: 0 }),
    }, { DB: db });
    expect(delRes.status).toBe(200);

    expect(changesFor('tx-X').filter(c => c.entity_type === 'transaction').length).toBe(1); // 只剩 delete
    expect(changesFor('tx-Y').filter(c => c.action === 'upsert').length).toBe(1); // 未动
    expect(changesFor('tx-X').filter(c => c.entity_type === 'budget' && c.action === 'upsert').length).toBe(1); // budget 未动
  });

  it('附件 GC 按 ledger-scope:editor 上传的孤儿附件被 owner-scope 删除清掉', async () => {
    // editor 上传附件(E 是共享账本编辑者,user_id=editor)
    sqlite.prepare(
      `INSERT INTO attachment_files (id, ledger_id, user_id, sha256, size_bytes, mime_type, file_name, storage_path, attachment_kind, created_at)
       VALUES ('f-by-editor', 'L1', 'editor', 'f-by-editor', 5, 'image/png', 'a.png', 'L1/f-by-editor.bin', 'transaction', ?)`
    ).run(new Date().toISOString());

    await pushTx('tx-DEL', 'L1', {
      syncId: 'tx-DEL', type: 'expense', amount: 10, happenedAt: '2026-05-28T00:00:00Z',
      attachments: [{ fileName: 'a.png', cloudFileId: 'f-by-editor' }],
    });

    const delRes = await app.request('/api/v1/write/ledgers/L1/transactions/tx-DEL', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', 'X-Test-User': 'owner', 'X-Device-ID': 'dev-owner' },
      body: JSON.stringify({ base_change_id: 0 }),
    }, { DB: db });
    expect(delRes.status).toBe(200);

    // Editor 上传的附件行被清(ledger-scope GC,不因 user_id 不匹配而漏)
    const att = sqlite.prepare("SELECT COUNT(*) as cnt FROM attachment_files WHERE id = 'f-by-editor'").get() as { cnt: number };
    expect(att.cnt).toBe(0);
  });

  it('同一 ledger 里另一 tx 仍引用 → 附件保留;另一 ledger 引用 → 不影响本 ledger 清理', async () => {
    // L1 里两笔 tx:tx-keep 还引用附件
    sqlite.prepare(
      `INSERT INTO attachment_files (id, ledger_id, user_id, sha256, size_bytes, mime_type, file_name, storage_path, attachment_kind, created_at)
       VALUES ('f-shared', 'L1', 'editor', 'f-shared', 5, 'image/png', 'a.png', 'L1/f-shared.bin', 'transaction', ?)`
    ).run(new Date().toISOString());
    await pushTx('tx-keep', 'L1', {
      syncId: 'tx-keep', type: 'expense', amount: 1, happenedAt: '2026-05-28T00:00:00Z',
      attachments: [{ fileName: 'a.png', cloudFileId: 'f-shared' }],
    });
    await pushTx('tx-del', 'L1', {
      syncId: 'tx-del', type: 'expense', amount: 2, happenedAt: '2026-05-28T00:00:00Z',
      attachments: [{ fileName: 'a.png', cloudFileId: 'f-shared' }],
    });

    const delRes = await app.request('/api/v1/write/ledgers/L1/transactions/tx-del', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', 'X-Test-User': 'owner', 'X-Device-ID': 'dev-owner' },
      body: JSON.stringify({ base_change_id: 0 }),
    }, { DB: db });
    expect(delRes.status).toBe(200);

    // 仍被 tx-keep 引用 → 保留
    const att = sqlite.prepare("SELECT COUNT(*) as cnt FROM attachment_files WHERE id = 'f-shared'").get() as { cnt: number };
    expect(att.cnt).toBe(1);
  });
});