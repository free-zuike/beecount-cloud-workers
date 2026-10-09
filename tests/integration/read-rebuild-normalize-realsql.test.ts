import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import readRouter from '../../src/routes/read';
import { createRealDb, WRITE_PATH_TABLES } from '../helpers/realsql-db';

// 真实 SQLite 验证投影重建路径（GET /read/workspace/transactions 在投影为空时
// 从 sync_changes 重放）同样应用账户字段规范化——历史脏 payload（transfer 带
// account / expense 带 from+to）重放后必须被清。
let sqlite: DatabaseSync;
let db: D1Database;
let app: Hono<{ Bindings: { DB: D1Database }; Variables: { userId: string } }>;

beforeEach(() => {
  const real = createRealDb();
  sqlite = real.sqlite;
  db = real.db;
  sqlite.exec(WRITE_PATH_TABLES);
  sqlite.prepare("INSERT INTO users (id, email, password_hash) VALUES ('user-1', 'r@x.com', 'x')").run();
  sqlite.prepare("INSERT INTO ledgers (id, user_id, external_id, name, currency) VALUES ('ledger-1', 'user-1', 'ledger-1', 'R', 'CNY')").run();
  sqlite.prepare("INSERT INTO ledger_members (ledger_id, user_id, role, joined_at) VALUES ('ledger-1', 'user-1', 'owner', '2025-01-01T00:00:00Z')").run();

  app = new Hono<{ Bindings: { DB: D1Database }; Variables: { userId: string } }>();
  app.use('*', async (c, next) => {
    c.set('userId', 'user-1');
    await next();
  });
  app.route('/api/v1/read', readRouter);
});

afterEach(() => sqlite.close());

let changeSeq = 0;
function seedChange(syncId: string, payload: Record<string, unknown>) {
  changeSeq++;
  sqlite.prepare(
    `INSERT INTO sync_changes (change_id, user_id, ledger_id, entity_type, entity_sync_id, action, payload_json, updated_at, updated_by_user_id, updated_by_device_id, scope)
     VALUES (?, 'user-1', 'ledger-1', 'transaction', ?, 'upsert', ?, '2025-01-15T10:00:00.000Z', 'user-1', 'dev-1', 'ledger')`
  ).run(changeSeq, syncId, JSON.stringify(payload));
}

describe('read 投影重建账户字段规范化（真实 SQLite）', () => {
  it('transfer 带单账户 + expense 带转账字段的历史脏 payload 重放后被清', async () => {
    seedChange('tx-transfer', {
      tx_type: 'transfer', amount: 1000, happened_at: '2025-01-15T10:00:00.000Z',
      accountId: 'acc-cash', accountName: '现金',
      fromAccountId: 'f1', toAccountId: 't1',
    });
    seedChange('tx-expense', {
      tx_type: 'expense', amount: 66, happened_at: '2025-01-15T11:00:00.000Z',
      fromAccountId: 'f1', fromAccountName: '旧A', toAccountId: 't1', toAccountName: '旧B',
    });

    const res = await app.request('/api/v1/read/workspace/transactions?ledger_id=ledger-1', {}, { DB: db });
    expect(res.status).toBe(200);

    const t = sqlite.prepare('SELECT tx_type, account_sync_id, from_account_sync_id, to_account_sync_id FROM read_tx_projection WHERE sync_id = ?').get('tx-transfer') as Record<string, unknown>;
    expect(t.tx_type).toBe('transfer');
    expect(t.account_sync_id).toBeNull();
    expect(t.from_account_sync_id).toBe('f1');
    expect(t.to_account_sync_id).toBe('t1');

    const e = sqlite.prepare('SELECT tx_type, from_account_sync_id, from_account_name, to_account_sync_id, to_account_name FROM read_tx_projection WHERE sync_id = ?').get('tx-expense') as Record<string, unknown>;
    expect(e.tx_type).toBe('expense');
    expect(e.from_account_sync_id).toBeNull();
    expect(e.from_account_name).toBeNull();
    expect(e.to_account_sync_id).toBeNull();
    expect(e.to_account_name).toBeNull();
  });
  it('account_sync_id 精确筛选同时返回账户自身的 transfer 流水', async () => {
    seedChange('tx-transfer-filter', {
      tx_type: 'transfer', amount: 200, happened_at: '2025-01-15T12:00:00.000Z',
      fromAccountId: 'bitget', fromAccountName: 'Bitget',
      toAccountId: 'wallet', toAccountName: 'BitgetWallet',
    });
    seedChange('tx-unrelated', {
      tx_type: 'expense', amount: 5, happened_at: '2025-01-15T13:00:00.000Z',
      accountId: 'wallet', accountName: 'BitgetWallet',
    });

    const res = await app.request('/api/v1/read/workspace/transactions?ledger_id=ledger-1&account_sync_id=bitget', {}, { DB: db });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      items: Array<{
        sync_id: string;
        from_account_id: string | null;
        from_account_name: string | null;
        to_account_id: string | null;
        to_account_name: string | null;
      }>;
    };
    expect(body.items.map((item) => item.sync_id)).toEqual(['tx-transfer-filter']);
    expect(body.items[0]).toMatchObject({
      from_account_id: 'bitget',
      from_account_name: 'Bitget',
      to_account_id: 'wallet',
      to_account_name: 'BitgetWallet',
    });
  });

});
