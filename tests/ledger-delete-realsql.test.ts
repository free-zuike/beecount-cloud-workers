import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import writeRouter from '../src/routes/write';
import readRouter from '../src/routes/read';
import syncRouter from '../src/routes/sync';

// 移植上游 tests/test_ledger_delete.py:
// 1) push ledger_snapshot delete tombstone → sync/ledgers、read/ledgers 隐藏,read detail 404,历史保留;
// 2) web DELETE /write/ledgers/:id → 同样隐藏 + owner 自己 pull 能拿到 tombstone(回归);
// 3) web delete 清 sync_changes 只剩 tombstone + attachment_files 行删干净(物理文件本地无 R2 跳过);
// 4) 软删不影响其他用户同 external_id 的账本。
let sqlite: DatabaseSync;
let db: D1Database;
let app: Hono<{ Bindings: { DB: D1Database }; Variables: { userId: string } }>;

function insertTables() {
  sqlite.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, is_admin BOOLEAN DEFAULT 0);
    CREATE TABLE ledgers (id TEXT PRIMARY KEY, user_id TEXT, external_id TEXT, name TEXT, currency TEXT, month_start_day INTEGER DEFAULT 1, created_at TEXT);
    CREATE TABLE ledger_members (ledger_id TEXT, user_id TEXT, role TEXT, joined_at TEXT);
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
    CREATE TABLE user_account_projection (sync_id TEXT PRIMARY KEY, user_id TEXT, name TEXT, account_type TEXT, currency TEXT, initial_balance REAL DEFAULT 0, hidden INTEGER DEFAULT 0);
    CREATE TABLE user_category_projection (sync_id TEXT PRIMARY KEY, user_id TEXT, name TEXT, kind TEXT, level INTEGER);
    CREATE TABLE user_tag_projection (sync_id TEXT PRIMARY KEY, user_id TEXT, name TEXT, color TEXT, source_change_id INTEGER);
    CREATE TABLE user_exchange_rate_projection (sync_id TEXT PRIMARY KEY, user_id TEXT, base_currency TEXT, quote_currency TEXT, rate REAL);
    CREATE TABLE attachment_files (
      id TEXT PRIMARY KEY, ledger_id TEXT, user_id TEXT NOT NULL, sha256 TEXT NOT NULL,
      size_bytes INTEGER DEFAULT 0, mime_type TEXT, file_name TEXT, storage_path TEXT NOT NULL,
      attachment_kind TEXT DEFAULT 'transaction' NOT NULL, created_at TEXT
    );
    CREATE TABLE sync_cursors (user_id TEXT, device_id TEXT, ledger_external_id TEXT, last_cursor INTEGER, updated_at TEXT, PRIMARY KEY (user_id, device_id, ledger_external_id));
    CREATE TABLE backup_remotes (id TEXT PRIMARY KEY, user_id TEXT, backend_type TEXT, config_summary TEXT);
    CREATE TABLE audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, ledger_id TEXT, action TEXT, metadata_json TEXT, created_at TEXT);
  `);
}

function insertUserAndLedger(userId: string, email: string, ledgerExtId: string, ledgerInternalId: string) {
  sqlite.prepare("INSERT INTO users (id, email, password_hash, is_admin) VALUES (?, ?, 'x', 0)").run(userId, email);
  sqlite.prepare("INSERT INTO ledgers (id, user_id, external_id, name, currency) VALUES (?, ?, ?, ?, 'CNY')").run(ledgerInternalId, userId, ledgerExtId, ledgerExtId);
  sqlite.prepare("INSERT INTO ledger_members (ledger_id, user_id, role, joined_at) VALUES (?, ?, 'owner', '2025-01-01T00:00:00Z')").run(ledgerInternalId, userId);
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:');
  insertTables();
  db = {
    prepare(sql: string) {
      let statement: ReturnType<DatabaseSync['prepare']>;
      try { statement = sqlite.prepare(sql); } catch (e) { console.error('[PREPARE FAIL]', sql, (e as Error).message); throw e; }
      let params: unknown[] = [];
      return {
        bind(...values: unknown[]) { params = values; return this; },
        async run() {
          try {
            const r = statement.run(...params as never[]);
            return { meta: { last_row_id: Number(r.lastInsertRowid), changes: r.changes } };
          } catch (e) {
            console.error('[RUN FAIL]', sql, JSON.stringify(params), (e as Error).message);
            throw e;
          }
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
  app.route('/api/v1/write', writeRouter);
  app.route('/api/v1/read', readRouter);
  app.route('/api/v1/sync', syncRouter);
});

afterEach(() => sqlite.close());

async function pushSnapshot(userId: string, deviceId: string, ledgerExtId: string, action: 'upsert' | 'delete' = 'upsert') {
  return app.request('/api/v1/sync/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Test-User': userId, 'X-Device-ID': deviceId },
    body: JSON.stringify({
      device_id: deviceId,
      changes: [{
        ledger_id: ledgerExtId,
        entity_type: 'ledger_snapshot',
        entity_sync_id: ledgerExtId,
        action,
        payload: action === 'upsert' ? { content: JSON.stringify({ ledgerName: ledgerExtId, currency: 'CNY', count: 0, items: [], accounts: [], categories: [], tags: [] }) } : {},
        updated_at: new Date().toISOString(),
      }],
    }),
  }, { DB: db });
}

async function syncLedgers(userId: string) {
  const res = await app.request('/api/v1/sync/ledgers', { headers: { 'X-Test-User': userId } }, { DB: db });
  return { status: res.status, body: await res.json() as any };
}

describe('账本软删除(移植上游 test_ledger_delete.py)', () => {
  it('push ledger_snapshot delete → sync/ledgers、read/ledgers 隐藏,detail 404,历史保留', async () => {
    insertUserAndLedger('user-1', 'o@example.com', 'L1', 'ledger-1');
    sqlite.prepare("INSERT INTO devices (id, user_id, name, platform, created_at) VALUES ('dev-1', 'user-1', 'd', 'app', '2025-01-01T00:00:00Z')").run();
    await pushSnapshot('user-1', 'dev-1', 'L1');

    // 删除前可见
    const before = await syncLedgers('user-1');
    expect(before.body.map((lg: any) => lg.ledger_id)).toEqual(['L1']);

    // 推 tombstone
    const del = await pushSnapshot('user-1', 'dev-1', 'L1', 'delete');
    expect(del.status).toBe(200);

    // 删除后隐藏
    const after = await syncLedgers('user-1');
    expect(after.body).toEqual([]);

    const readList = await app.request('/api/v1/read/ledgers', { headers: { 'X-Test-User': 'user-1' } }, { DB: db });
    expect(await readList.json()).toEqual([]);
    const readDetail = await app.request('/api/v1/read/ledgers/L1', { headers: { 'X-Test-User': 'user-1' } }, { DB: db });
    expect(readDetail.status).toBe(404);

    // 历史保留(upsert + delete 两条 ledger_snapshot)
    const count = sqlite.prepare("SELECT COUNT(*) as cnt FROM sync_changes WHERE entity_type = 'ledger_snapshot'").get() as { cnt: number };
    expect(count.cnt).toBe(2);
  });

  it('web DELETE /write/ledgers/:id → 隐藏 + owner 自己 pull 能拿到 tombstone(回归)', async () => {
    insertUserAndLedger('user-1', 'o@example.com', 'L1', 'ledger-1');
    sqlite.prepare("INSERT INTO devices (id, user_id, name, platform, created_at) VALUES ('dev-1', 'user-1', 'd', 'app', '2025-01-01T00:00:00Z')").run();
    await pushSnapshot('user-1', 'dev-1', 'L1');

    const res = await app.request('/api/v1/write/ledgers/L1', {
      method: 'DELETE',
      headers: { 'X-Test-User': 'user-1', 'X-Device-ID': 'web-console' },
    }, { DB: db });
    expect(res.status).toBe(200);
    const meta = await res.json() as any;
    expect(meta.ledger_id).toBe('L1');
    expect(meta.new_change_id).toBeGreaterThan(0);

    const list = await syncLedgers('user-1');
    expect(list.body).toEqual([]);

    // owner 自己 pull since=0 必须看到 tombstone(回归:不能因删了 owner member 而拉不到)
    const pull = await app.request('/api/v1/sync/pull?since=0&limit=2000', {
      headers: { 'X-Test-User': 'user-1', 'X-Device-ID': 'dev-1' },
    }, { DB: db });
    expect(pull.status).toBe(200);
    const changes = (await pull.json() as any).changes as any[];
    const tombstones = changes.filter((c: any) =>
      c.entity_type === 'ledger_snapshot' && c.action === 'delete' && c.entity_sync_id === 'L1');
    expect(tombstones.length).toBe(1);
    expect(tombstones[0].change_id).toBe(meta.new_change_id);
  });

  it('web DELETE 清 sync_changes 只剩 tombstone + attachment_files 行删干净', async () => {
    insertUserAndLedger('user-1', 'owner@delete.com', 'LDEL', 'ledger-del');
    sqlite.prepare("INSERT INTO devices (id, user_id, name, platform, created_at) VALUES ('dev-1', 'user-1', 'd', 'app', '2025-01-01T00:00:00Z')").run();
    await pushSnapshot('user-1', 'dev-1', 'LDEL');
    // 造一条交易 + 一条附件,确保 sync_changes 有多行
    await app.request('/api/v1/sync/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Test-User': 'user-1', 'X-Device-ID': 'dev-1' },
      body: JSON.stringify({
        device_id: 'dev-1',
        changes: [{
          ledger_id: 'LDEL', entity_type: 'transaction', entity_sync_id: 'tx1', action: 'upsert',
          payload: { syncId: 'tx1', type: 'expense', amount: 10, happenedAt: new Date().toISOString() },
          updated_at: new Date().toISOString(),
        }],
      }),
    }, { DB: db });
    sqlite.prepare(
      `INSERT INTO attachment_files (id, ledger_id, user_id, sha256, size_bytes, mime_type, file_name, storage_path, attachment_kind, created_at)
       VALUES ('att-1', 'ledger-del', 'user-1', ?, 15, 'image/png', 'att.bin', 'ledger-del/att.bin', 'transaction', ?)`
    ).run('a'.repeat(64), new Date().toISOString());

    const pre = sqlite.prepare('SELECT COUNT(*) as cnt FROM sync_changes WHERE ledger_id = ?').get('ledger-del') as { cnt: number };
    expect(pre.cnt).toBeGreaterThanOrEqual(2);

    const res = await app.request('/api/v1/write/ledgers/LDEL', {
      method: 'DELETE',
      headers: { 'X-Test-User': 'user-1', 'X-Device-ID': 'web-console' },
    }, { DB: db });
    expect(res.status).toBe(200);
    const newChangeId = (await res.json() as any).new_change_id as number;

    const remaining = sqlite.prepare(
      'SELECT change_id, action, entity_type FROM sync_changes WHERE ledger_id = ?').all('ledger-del') as any[];
    expect(remaining.length).toBe(1);
    expect(remaining[0].change_id).toBe(newChangeId);
    expect(remaining[0].action).toBe('delete');
    expect(remaining[0].entity_type).toBe('ledger_snapshot');

    // attachment_files 行删干净
    const att = sqlite.prepare('SELECT COUNT(*) as cnt FROM attachment_files WHERE ledger_id = ?').get('ledger-del') as { cnt: number };
    expect(att.cnt).toBe(0);
  });

  it('软删不影响其他用户同 external_id 的账本', async () => {
    insertUserAndLedger('user-a', 'a@example.com', 'shared-name', 'lg-a');
    insertUserAndLedger('user-b', 'b@example.com', 'shared-name', 'lg-b');
    sqlite.prepare("INSERT INTO devices (id, user_id, name, platform, created_at) VALUES ('dev-a', 'user-a', 'a', 'app', '2025-01-01T00:00:00Z'), ('dev-b', 'user-b', 'b', 'app', '2025-01-01T00:00:00Z')").run();
    await pushSnapshot('user-a', 'dev-a', 'shared-name');
    await pushSnapshot('user-b', 'dev-b', 'shared-name');

    // A 删除自己的
    await pushSnapshot('user-a', 'dev-a', 'shared-name', 'delete');

    const ra = await syncLedgers('user-a');
    const rb = await syncLedgers('user-b');
    expect(ra.body).toEqual([]);
    expect(rb.body.map((lg: any) => lg.ledger_id)).toEqual(['shared-name']);
  });
});