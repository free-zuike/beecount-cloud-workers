import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { Hono } from 'hono';
import readRouter from '../../src/routes/read';
import workspaceRouter from '../../src/routes/workspace';

// Exercise the actual route SQL: the in-memory mock does not evaluate SUM/CASE.
// Seed existing projections directly so these tests also cover historical data.
let sqlite: DatabaseSync;
let db: D1Database;
let app: Hono<{ Bindings: { DB: D1Database }; Variables: { userId: string } }>;

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT);
    CREATE TABLE ledgers (id TEXT PRIMARY KEY, user_id TEXT, external_id TEXT, name TEXT, currency TEXT, month_start_day INTEGER DEFAULT 1);
    CREATE TABLE ledger_members (ledger_id TEXT, user_id TEXT, role TEXT);
    CREATE TABLE sync_changes (change_id INTEGER PRIMARY KEY, ledger_id TEXT, entity_type TEXT, action TEXT);
    CREATE TABLE user_account_projection (
      sync_id TEXT PRIMARY KEY, user_id TEXT, name TEXT, account_type TEXT, currency TEXT, initial_balance REAL,
      note TEXT, credit_limit REAL, billing_day INTEGER, payment_due_day INTEGER, bank_name TEXT, card_last_four TEXT,
      hidden INTEGER DEFAULT 0, source_change_id INTEGER DEFAULT 0
    );
    CREATE TABLE read_tx_projection (
      sync_id TEXT PRIMARY KEY, ledger_id TEXT, tx_type TEXT, amount REAL, currency_code TEXT, native_amount REAL, transfer_to_amount REAL,
      happened_at TEXT, account_sync_id TEXT, from_account_sync_id TEXT, to_account_sync_id TEXT, exclude_from_stats INTEGER DEFAULT 0
    );
    CREATE TABLE user_profiles (user_id TEXT PRIMARY KEY, primary_currency TEXT);
    CREATE TABLE exchange_rate_cache (base_currency TEXT PRIMARY KEY, payload_json TEXT);
    CREATE TABLE user_exchange_rate_projection (user_id TEXT, base_currency TEXT, quote_currency TEXT, rate TEXT);
    INSERT INTO users VALUES ('user-1', 'currency@example.com');
    INSERT INTO ledgers (id, user_id, external_id, name, currency) VALUES ('ledger-1', 'user-1', 'cny-ledger', 'CNY ledger', 'CNY');
  `);

  db = {
    prepare(sql: string) {
      const statement = sqlite.prepare(sql);
      let params: SQLInputValue[] = [];
      return {
        bind(...values: SQLInputValue[]) { params = values; return this; },
        async first() { return statement.get(...params) ?? null; },
        async all() { return { results: statement.all(...params) }; },
      };
    },
  } as unknown as D1Database;

  app = new Hono<{ Bindings: { DB: D1Database }; Variables: { userId: string } }>();
  app.use('*', async (c, next) => { c.set('userId', 'user-1'); await next(); });
  app.route('/api/v1/read', readRouter);
  app.route('/api/v1', workspaceRouter);
});

afterEach(() => sqlite.close());

function addAccount(id = 'usd-account', currency = 'USD', initialBalance = 1000) {
  sqlite.prepare(`INSERT INTO user_account_projection
    (sync_id, user_id, name, account_type, currency, initial_balance) VALUES (?, 'user-1', ?, 'debit', ?, ?)`)
    .run(id, id, currency, initialBalance);
}

function addTransaction(overrides: Record<string, SQLInputValue> = {}) {
  const row = {
    sync_id: 'tx-1', ledger_id: 'ledger-1', tx_type: 'expense', amount: 100, currency_code: 'USD', native_amount: 720,
    happened_at: '2026-01-15T12:00:00.000Z', account_sync_id: 'usd-account',
    from_account_sync_id: null, to_account_sync_id: null, exclude_from_stats: 0,
    ...overrides,
  };
  const columns = Object.keys(row);
  sqlite.prepare(`INSERT INTO read_tx_projection (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
    .run(...Object.values(row));
}

async function get<T>(path: string): Promise<T> {
  const response = await app.request(path, undefined, { DB: db });
  expect(response.status).toBe(200);
  return response.json() as Promise<T>;
}

type Account = { id: string; currency: string; balance: number; income_total: number; expense_total: number; tx_count: number };
type Ledger = { currency: string; income_total: number; expense_total: number; balance: number };

async function expectBalances(expected: Record<string, number>, ledger = 'cny-ledger', scoped = false) {
  const workspace = await get<Account[]>(`/api/v1/accounts${scoped ? `?ledger_id=${ledger}` : ''}`);
  const read = await get<Account[]>(`/api/v1/read/ledgers/${ledger}/accounts`);
  expect(workspace).toHaveLength(Object.keys(expected).length);
  expect(read).toHaveLength(Object.keys(expected).length);
  for (const [id, balance] of Object.entries(expected)) {
    expect(workspace.find(a => a.id === id)?.balance).toBeCloseTo(balance);
    expect(read.find(a => a.id === id)?.balance).toBeCloseTo(balance);
  }
  return workspace;
}

describe('Account balances use account-currency amounts', () => {
  it('deducts USD 100 rather than the CNY 720 snapshot from a USD account', async () => {
    addAccount();
    addTransaction();
    const accounts = await expectBalances({ 'usd-account': 900 });
    expect(accounts[0]).toMatchObject({ currency: 'USD', expense_total: 100, income_total: 0, tx_count: 1 });
  });

  it('credits foreign-currency income using the original amount', async () => {
    addAccount();
    addTransaction({ tx_type: 'income' });
    const accounts = await expectBalances({ 'usd-account': 1100 });
    expect(accounts[0]).toMatchObject({ income_total: 100, expense_total: 0, tx_count: 1 });
  });

  it.each([
    { currency: 'CNY', nativeAmount: null },
    { currency: 'CNY', nativeAmount: 100 },
    { currency: 'USD', nativeAmount: null },
  ])('keeps $currency balances correct with native_amount=$nativeAmount', async ({ currency, nativeAmount }) => {
    addAccount('account', currency);
    addTransaction({ account_sync_id: 'account', currency_code: currency, native_amount: nativeAmount });
    await expectBalances({ account: 900 });
  });

  it.each([
    { currency: 'USD', nativeAmount: 720 },
    { currency: 'CNY', nativeAmount: 100 },
  ])('moves $currency 100 between accounts without using the ledger snapshot', async ({ currency, nativeAmount }) => {
    addAccount('sender', currency, 1000);
    addAccount('recipient', currency, 200);
    addTransaction({
      tx_type: 'transfer', currency_code: currency, native_amount: nativeAmount, account_sync_id: null,
      from_account_sync_id: 'sender', to_account_sync_id: 'recipient',
    });
    const accounts = await expectBalances({ sender: 900, recipient: 300 });
    expect(accounts.find(a => a.id === 'sender')).toMatchObject({ expense_total: 100, income_total: 0, tx_count: 1 });
    expect(accounts.find(a => a.id === 'recipient')).toMatchObject({ income_total: 100, expense_total: 0, tx_count: 1 });
  });

  it('preserves initial balances when there are no transactions', async () => {
    addAccount();
    const accounts = await expectBalances({ 'usd-account': 1000 });
    expect(accounts[0]).toMatchObject({ income_total: 0, expense_total: 0, tx_count: 0 });
  });

  it('sums one account across ledger currencies and respects the ledger filter', async () => {
    addAccount();
    addTransaction();
    sqlite.prepare(`INSERT INTO ledgers (id, user_id, external_id, name, currency)
      VALUES ('ledger-2', 'user-1', 'eur-ledger', 'EUR ledger', 'EUR')`).run();
    addTransaction({ sync_id: 'tx-2', ledger_id: 'ledger-2', amount: 40, native_amount: 36 });
    const accounts = await get<Account[]>('/api/v1/accounts');
    expect(accounts[0]).toMatchObject({ balance: 860, expense_total: 140, tx_count: 2 });
    await expectBalances({ 'usd-account': 900 }, 'cny-ledger', true);
    await expectBalances({ 'usd-account': 960 }, 'eur-ledger', true);
  });

  it('still counts transactions excluded from ledger statistics in the account balance', async () => {
    addAccount();
    addTransaction({ exclude_from_stats: 1 });
    await expectBalances({ 'usd-account': 900 });
    const ledger = await get<Ledger>('/api/v1/read/ledgers/cny-ledger');
    expect(ledger.expense_total).toBe(0);
  });
});

describe('Ledger and net-worth currency semantics remain unchanged', () => {
  it('uses native_amount for ledger income and expense, falling back for legacy rows', async () => {
    addAccount();
    addAccount('cny-account', 'CNY');
    addTransaction();
    addTransaction({ sync_id: 'tx-income', tx_type: 'income', amount: 50, native_amount: 360 });
    addTransaction({ sync_id: 'tx-legacy', account_sync_id: 'cny-account', currency_code: 'CNY', amount: 25, native_amount: null });
    const ledger = await get<Ledger>('/api/v1/read/ledgers/cny-ledger');
    expect(ledger).toMatchObject({ currency: 'CNY', expense_total: 745, income_total: 360, balance: -385 });
  });

  it('converts account-currency amounts exactly once in net-worth history', async () => {
    addAccount();
    addTransaction();
    addTransaction({
      sync_id: 'tx-income', tx_type: 'income', amount: 50, native_amount: 360, happened_at: '2026-02-15T12:00:00.000Z',
    });
    sqlite.exec(`INSERT INTO user_profiles VALUES ('user-1', 'CNY');
      INSERT INTO user_exchange_rate_projection VALUES ('user-1', 'CNY', 'USD', '7.2');`);
    const history = await get<{ series: { bucket: string; net_worth: number }[] }>('/api/v1/net-worth-history');
    expect(history.series).toHaveLength(2);
    expect(history.series[0].bucket).toBe('2026-01');
    expect(history.series[0].net_worth).toBeCloseTo(6480); // (1000 - 100) USD * 7.2
    expect(history.series[1].bucket).toBe('2026-02');
    expect(history.series[1].net_worth).toBeCloseTo(6840); // (1000 - 100 + 50) USD * 7.2
  });
});
