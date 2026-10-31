import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import adminRouter from '../../src/routes/admin';
import { createRealDb, WRITE_PATH_TABLES } from '../helpers/realsql-db';

// 真实 SQLite 验证 admin 恢复（backup restore 快照回填投影）同样应用账户字段规范化。
let sqlite: DatabaseSync;
let db: D1Database;
let app: Hono<{ Bindings: { DB: D1Database }; Variables: { userId: string } }>;

function txRecord(syncId: string, over: Record<string, unknown>) {
  return {
    sync_id: syncId, tx_type: 'expense', amount: 10, happened_at: '2025-01-15T10:00:00.000Z',
    note: null, category_sync_id: null, category_name: null, category_kind: null,
    account_sync_id: null, account_name: null,
    from_account_sync_id: null, from_account_name: null,
    to_account_sync_id: null, to_account_name: null,
    tags_csv: null, tag_sync_ids_json: null, attachments_json: null,
    tx_index: 0, source_change_id: 0,
    exclude_from_stats: 0, exclude_from_budget: 0,
    created_by_user_id: 'user-1', last_edited_by_user_id: 'user-1',
    currency_code: null, native_amount: null,
    ...over,
  };
}

beforeEach(() => {
  const real = createRealDb();
  sqlite = real.sqlite;
  db = real.db;
  sqlite.exec(WRITE_PATH_TABLES);
  sqlite.exec(`CREATE TABLE backup_snapshots (
    id TEXT PRIMARY KEY, user_id TEXT, ledger_id TEXT, snapshot_json TEXT NOT NULL,
    note TEXT, created_at TEXT DEFAULT (datetime('now')) NOT NULL
  )`);
  // 还原会整体回写预算投影表；镜像生产 schema 补建 read_budget_projection
  // （WRITE_PATH_TABLES 已含 read_tx_projection / user_account_projection / user_category_projection / user_tag_projection）
  sqlite.exec(`CREATE TABLE read_budget_projection (ledger_id TEXT, sync_id TEXT, user_id TEXT, budget_type TEXT, category_sync_id TEXT, amount REAL, period TEXT, start_day INTEGER, enabled INTEGER DEFAULT 1, source_change_id INTEGER DEFAULT 0)`);
  sqlite.prepare("INSERT INTO users (id, email, password_hash, is_admin) VALUES ('user-1', 'a@x.com', 'x', 1)").run();
  sqlite.prepare("INSERT INTO ledgers (id, user_id, external_id, name, currency) VALUES ('ledger-1', 'user-1', 'ledger-1', 'A', 'CNY')").run();

  const snapshot = {
    ledger_external_id: 'ledger-1',
    transactions: [
      txRecord('tx-transfer', {
        tx_type: 'transfer', amount: 1000,
        account_sync_id: 'acc-cash', account_name: '现金',
        from_account_sync_id: 'f1', from_account_name: 'A 户',
        to_account_sync_id: 't1', to_account_name: 'B 户',
      }),
      txRecord('tx-expense', {
        from_account_sync_id: 'f1', from_account_name: '旧A',
        to_account_sync_id: 't1', to_account_name: '旧B',
      }),
    ],
  };
  sqlite.prepare("INSERT INTO backup_snapshots (id, user_id, ledger_id, snapshot_json) VALUES ('snap-1', 'user-1', 'ledger-1', ?)")
    .run(JSON.stringify(snapshot));

  app = new Hono<{ Bindings: { DB: D1Database }; Variables: { userId: string } }>();
  app.use('*', async (c, next) => {
    c.set('userId', 'user-1');
    await next();
  });
  app.route('/api/v1/admin', adminRouter);
});

afterEach(() => sqlite.close());

describe('admin 恢复投影账户字段规范化（真实 SQLite）', () => {
  it('快照中 transfer 带单账户 / expense 带转账字段 → 恢复后真实清空', async () => {
    const res = await app.request('/api/v1/admin/backups/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ snapshot_id: 'snap-1', device_id: 'dev-1' }),
    }, { DB: db });
    expect(res.status).toBe(200);

    const t = sqlite.prepare('SELECT tx_type, account_sync_id, account_name, from_account_sync_id, to_account_sync_id FROM read_tx_projection WHERE sync_id = ?').get('tx-transfer') as Record<string, unknown>;
    expect(t.tx_type).toBe('transfer');
    expect(t.account_sync_id).toBeNull();
    expect(t.account_name).toBeNull();
    expect(t.from_account_sync_id).toBe('f1');
    expect(t.to_account_sync_id).toBe('t1');

    const e = sqlite.prepare('SELECT tx_type, from_account_sync_id, from_account_name, to_account_sync_id, to_account_name FROM read_tx_projection WHERE sync_id = ?').get('tx-expense') as Record<string, unknown>;
    expect(e.tx_type).toBe('expense');
    expect(e.from_account_sync_id).toBeNull();
    expect(e.from_account_name).toBeNull();
    expect(e.to_account_sync_id).toBeNull();
    expect(e.to_account_name).toBeNull();
  });
});