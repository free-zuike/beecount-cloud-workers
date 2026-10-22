import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import importRouter from '../../src/routes/import_data';
import { makeDefaultMapping } from '../../src/services/import_data/schema';
import { createRealDb, WRITE_PATH_TABLES } from '../helpers/realsql-db';

// ImportSession 定义在路由文件内部（未导出），测试本地声明同构类型。
interface ImportSession {
  token: string;
  userId: string;
  fileName: string;
  data: { sourceFormat: string; headers: string[]; rows: { rowNumber: number; cells: Record<string, string>; rawLine: string }[]; suggestedMapping: unknown; parseWarnings: unknown[] };
  mapping: {
    txType: string | null;
    amount: string | null;
    happenedAt: string | null;
    categoryName: string | null;
    subcategoryName: string | null;
    accountName: string | null;
    fromAccountName: string | null;
    toAccountName: string | null;
    note: string | null;
    currency: string | null;
    tags: string[];
    datetimeFormat: string | null;
    stripCurrencySymbols: boolean;
    expenseIsNegative: boolean;
    tzOffsetMinutes: number | null;
  };
  targetLedgerId: string | null;
  dedupStrategy: string;
  autoTagNames: string[];
  status: 'pending' | 'previewed' | 'executing' | 'done' | 'cancelled';
  createdAt: string;
  expiresAt: string;
}

// 真实 SQLite 验证导入执行路径（POST /import/:token/execute）的交易账户字段规范化。
// session 存储在 BEECOUNT_DO（KV），测试用 stub DO 提供会话数据。
let sqlite: DatabaseSync;
let db: D1Database;
let sessions = new Map<string, ImportSession>();
let app: Hono<{ Bindings: never; Variables: { userId: string } }>;

const fakeDo = {
  idFromName: (name: string) => ({ toString: () => name }),
  get: () => ({
    async fetch(input: RequestInfo | URL, init?: RequestInit) {
      const url = new URL(typeof input === 'string' ? input : String(input));
      if (url.pathname === '/import/get') {
        const token = url.searchParams.get('token') as string;
        return new Response(JSON.stringify({ data: sessions.get(token) ?? null }), { status: 200 });
      }
      if (url.pathname === '/import/save') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { token: string; data: ImportSession };
        sessions.set(body.token, body.data);
        return new Response('{}', { status: 200 });
      }
      return new Response('{}', { status: 404 });
    },
  }),
};

beforeEach(() => {
  const real = createRealDb();
  sqlite = real.sqlite;
  db = real.db;
  sessions = new Map();
  sqlite.exec(WRITE_PATH_TABLES);
  sqlite.prepare("INSERT INTO users (id, email, password_hash) VALUES ('user-1', 'i@x.com', 'x')").run();
  sqlite.prepare("INSERT INTO ledgers (id, user_id, external_id, name, currency) VALUES ('ledger-1', 'user-1', 'ledger-1', 'I', 'CNY')").run();
  sqlite.prepare("INSERT INTO ledger_members (ledger_id, user_id, role, joined_at) VALUES ('ledger-1', 'user-1', 'owner', '2025-01-01T00:00:00Z')").run();
  sqlite.prepare("INSERT INTO user_account_projection (sync_id, user_id, name, account_type, currency) VALUES ('acc-cash', 'user-1', '现金', 'cash', 'CNY')").run();
  sqlite.prepare("INSERT INTO user_category_projection (sync_id, user_id, name, kind, level) VALUES ('cat-food', 'user-1', '餐饮', 'expense', 1)").run();

  const session: ImportSession = {
    token: 'imp-1', userId: 'user-1', fileName: 't.csv',
    data: {
      sourceFormat: 'generic',
      headers: ['type', 'amount', 'date', 'account', 'from', 'to', 'category'],
      rows: [
        { rowNumber: 1, cells: { type: 'transfer', amount: '500', date: '2025-01-15', from: 'A 户', to: 'B 户', category: '转账' }, rawLine: 'a' },
        { rowNumber: 2, cells: { type: 'expense', amount: '66', date: '2025-01-16', account: '现金', category: '餐饮' }, rawLine: 'b' },
      ],
      suggestedMapping: makeDefaultMapping(),
      parseWarnings: [],
    },
    mapping: {
      ...makeDefaultMapping(),
      txType: 'type', amount: 'amount', happenedAt: 'date',
      fromAccountName: 'from', toAccountName: 'to', accountName: 'account',
      categoryName: 'category',
    },
    targetLedgerId: 'ledger-1', dedupStrategy: 'insert_all', autoTagNames: [],
    status: 'previewed', createdAt: '2025-01-01T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z',
  };
  sessions.set('imp-1', session);

  app = new Hono<{ Bindings: never; Variables: { userId: string } }>();
  app.use('*', async (c, next) => {
    c.set('userId', 'user-1');
    await next();
  });
  app.route('/api/v1/import', importRouter);
});

afterEach(() => sqlite.close());

describe('import execute 交易账户字段规范化（真实 SQLite）', () => {
  it('transfer 只用 from/to；expense 只用单账户——投影落库正确', async () => {
    const res = await app.request('/api/v1/import/imp-1/execute', { method: 'POST' }, { DB: db, BEECOUNT_DO: fakeDo } as never);
    expect(res.status).toBe(200);
    const sseText = await res.text();
    expect(sseText).not.toContain('event: error');
    expect(sseText).toContain('event: complete');

    const rows = sqlite.prepare(
      'SELECT tx_type, account_sync_id, account_name, from_account_sync_id, from_account_name, to_account_sync_id, to_account_name FROM read_tx_projection ORDER BY amount DESC'
    ).all() as Record<string, unknown>[];
    expect(rows.length).toBe(2);

    const transfer = rows[0];
    expect(transfer.tx_type).toBe('transfer');
    expect(transfer.account_sync_id).toBeNull();
    expect(transfer.account_name).toBeNull();
    expect(transfer.from_account_name).toBe('A 户');
    expect(transfer.from_account_sync_id).toBeNull(); // 导入路径按名称落库（不解析 sync_id）
    expect(transfer.to_account_name).toBe('B 户');
    expect(transfer.to_account_sync_id).toBeNull();

    const expense = rows[1];
    expect(expense.tx_type).toBe('expense');
    expect(expense.account_name).toBe('现金');
    expect(expense.from_account_name).toBeNull();
    expect(expense.to_account_name).toBeNull();
  });
});