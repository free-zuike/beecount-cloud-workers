import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import writeRouter from '../../src/routes/write';
import readRouter from '../../src/routes/read';
import { createRealDb, WRITE_PATH_TABLES } from '../helpers/realsql-db';

// 真实 SQLite 全链路验证 writeRouter（App/Web/MCP 写路径）的交易账户字段规范化。
let sqlite: DatabaseSync;
let db: D1Database;
let app: Hono<{ Bindings: { DB: D1Database }; Variables: { userId: string } }>;

beforeEach(() => {
  const real = createRealDb();
  sqlite = real.sqlite;
  db = real.db;
  sqlite.exec(WRITE_PATH_TABLES);
  sqlite.prepare("INSERT INTO users (id, email, password_hash) VALUES ('user-1', 'w@x.com', 'x')").run();
  sqlite.prepare("INSERT INTO ledgers (id, user_id, external_id, name, currency) VALUES ('ledger-1', 'user-1', 'ledger-1', 'W', 'CNY')").run();
  sqlite.prepare("INSERT INTO ledger_members (ledger_id, user_id, role, joined_at) VALUES ('ledger-1', 'user-1', 'owner', '2025-01-01T00:00:00Z')").run();
  sqlite.prepare("INSERT INTO user_account_projection (sync_id, user_id, name, account_type, currency) VALUES ('acc-cash', 'user-1', '现金', 'cash', 'CNY')").run();
  sqlite.prepare("INSERT INTO user_category_projection (sync_id, user_id, name, kind, level) VALUES ('cat-food', 'user-1', '餐饮', 'expense', 1)").run();
  sqlite.prepare("INSERT INTO user_category_projection (sync_id, user_id, name, kind, level) VALUES ('cat-transfer', 'user-1', '转账', 'transfer', 1)").run();

  app = new Hono<{ Bindings: { DB: D1Database }; Variables: { userId: string } }>();
  app.use('*', async (c, next) => {
    c.set('userId', 'user-1');
    await next();
  });
  app.route('/api/v1/write', writeRouter);
  app.route('/api/v1/read', readRouter);
});

afterEach(() => sqlite.close());

async function createTx(body: Record<string, unknown>) {
  const res = await app.request('/api/v1/write/ledgers/ledger-1/transactions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Device-ID': 'test-device' },
    body: JSON.stringify(body),
  }, { DB: db });
  const json = await res.json() as { entity_id?: string; error?: string };
  expect(res.status).toBe(200);
  expect(json.entity_id).toBeTruthy();
  return json.entity_id as string;
}

function projection(syncId: string) {
  return sqlite.prepare(
    'SELECT tx_type, amount, transfer_to_amount, category_sync_id, category_name, category_kind, account_sync_id, account_name, from_account_sync_id, from_account_name, to_account_sync_id, to_account_name FROM read_tx_projection WHERE sync_id = ?'
  ).get(syncId) as Record<string, unknown>;
}

describe('writeRouter 交易账户字段规范化（真实 SQLite）', () => {
  it('expense 带转账字段 → from/to 真实清空、单账户保留', async () => {
    const syncId = await createTx({
      tx_type: 'expense', amount: 15, happened_at: '2025-01-15T10:00:00.000Z',
      account_name: '现金',
      from_account_id: 'from-1', from_account_name: '旧A',
      to_account_id: 'to-1', to_account_name: '旧B',
    });
    const row = projection(syncId);
    expect(row.tx_type).toBe('expense');
    expect(row.account_name).toBe('现金');
    expect(row.from_account_sync_id).toBeNull();
    expect(row.from_account_name).toBeNull();
    expect(row.to_account_sync_id).toBeNull();
    expect(row.to_account_name).toBeNull();
  });

  it('cross-currency transfer stores a user-entered destination amount and balances each side independently', async () => {
    sqlite.prepare("INSERT INTO user_account_projection (sync_id, user_id, name, account_type, currency, initial_balance) VALUES ('acc-eur', 'user-1', 'EUR卡', 'bank_card', 'EUR', 500)").run();
    sqlite.prepare("INSERT INTO user_account_projection (sync_id, user_id, name, account_type, currency, initial_balance) VALUES ('acc-cny', 'user-1', 'CNY卡', 'bank_card', 'CNY', 1000)").run();

    const syncId = await createTx({
      tx_type: 'transfer', amount: 100, transfer_to_amount: 850, happened_at: '2025-01-15T10:00:00.000Z',
      from_account_id: 'acc-eur', from_account_name: 'EUR卡',
      to_account_id: 'acc-cny', to_account_name: 'CNY卡',
    });
    const row = projection(syncId);
    expect(row.amount).toBe(100);
    expect(row.transfer_to_amount).toBe(850);
    expect(row.category_sync_id).toBe('cat-transfer');
    expect(row.category_name).toBe('转账');
    expect(row.category_kind).toBe('transfer');

    const txRes = await app.request('/api/v1/read/workspace/transactions?ledger_id=ledger-1&tx_sync_id=' + syncId, {}, { DB: db });
    expect(txRes.status).toBe(200);
    const txBody = await txRes.json() as { items: Array<{ from_account_currency: string | null; to_account_currency: string | null; transfer_to_amount: number | null }> };
    expect(txBody.items[0]).toMatchObject({ from_account_currency: 'EUR', to_account_currency: 'CNY', transfer_to_amount: 850 });

    const res = await app.request('/api/v1/read/ledgers/ledger-1/accounts', {}, { DB: db });
    expect(res.status).toBe(200);
    const accounts = await res.json() as Array<{ id: string; balance: number }>;
    expect(accounts.find((a) => a.id === 'acc-eur')?.balance).toBe(400);
    expect(accounts.find((a) => a.id === 'acc-cny')?.balance).toBe(1850);
  });

  it('transfer 带单账户字段 → account 真实清空（只用 from/to）', async () => {
    const syncId = await createTx({
      tx_type: 'transfer', amount: 500, happened_at: '2025-01-15T10:00:00.000Z',
      account_id: 'acc-cash', account_name: '现金',
      from_account_id: 'from-1', from_account_name: 'A',
      to_account_id: 'to-1', to_account_name: 'B',
    });
    const row = projection(syncId);
    expect(row.tx_type).toBe('transfer');
    expect(row.account_sync_id).toBeNull();
    expect(row.account_name).toBeNull();
    expect(row.from_account_sync_id).toBe('from-1');
    expect(row.from_account_name).toBe('A');
    expect(row.to_account_sync_id).toBe('to-1');
    expect(row.to_account_name).toBe('B');
  });
});