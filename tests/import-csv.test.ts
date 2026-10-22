// 移植上游 tests/test_import_csv.py:
// - parser 单元:beecount/generic sniff、支付宝/微信别名、apply_mapping 转换
//   (必填缺失、tz offset、显式格式、负数支出、货币符号、用户手填映射);
// - e2e:upload happy path、tz offset 本地化、preview 重算(目标账本变化)、
//   413 过大、400 无行、410 token 过期、二次上传驱逐、execute 走通(SSE)、
//   cancel token。
// 注:本地 import session 缓存在 Durable Object(BEECOUNT_DO),测试用内存 mock。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { parseCsvText } from '../src/services/import_data/parser';
import { applyMapping } from '../src/services/import_data/transformer';
import { makeDefaultMapping } from '../src/services/import_data/schema';
import importRouter from '../src/routes/import_data';
import writeRouter from '../src/routes/write';
import syncRouter from '../src/routes/sync';

let sqlite: DatabaseSync;
let db: D1Database;
let app: Hono<{ Bindings: { DB: D1Database }; Variables: { userId: string } }>;
let doStorage: Map<string, { data: unknown; createdAt: number; expiresAt: number }>;

const USER = 'user-1';

/** 模拟 Durable Object:import session 存内存 map */
function makeDo(store: Map<string, { data: unknown; createdAt: number; expiresAt: number }>) {
  return {
    idFromName: () => 'do-import',
    get: () => ({
      fetch: async (url: string | URL, init?: RequestInit) => {
        const u = new URL(url);
        if (u.pathname.endsWith('/import/save')) {
          const body = JSON.parse(String(init?.body));
          // 单 user 一个 active token:新上传驱逐旧 token(对齐真实 DO 实现)
          const uid = body.data?.userId;
          if (uid) {
            const prev = store.get(`active:${uid}`);
            const prevToken = prev ? (prev.data as { token?: string }).token : undefined;
            if (prevToken && prevToken !== body.token) store.delete(`import:${prevToken}`);
            store.set(`active:${uid}`, { data: body.data, createdAt: Date.now(), expiresAt: Date.now() + 30 * 60 * 1000 });
          }
          store.set(`import:${body.token}`, { data: body.data, createdAt: Date.now(), expiresAt: Date.now() + 30 * 60 * 1000 });
          return Response.json({ ok: true });
        }
        if (u.pathname.endsWith('/import/get')) {
          const token = u.searchParams.get('token') || '';
          const entry = store.get(`import:${token}`);
          if (!entry) return Response.json({ data: null });
          if (Date.now() > entry.expiresAt) { store.delete(`import:${token}`); return Response.json({ data: null }); }
          return Response.json({ data: entry.data });
        }
        if (u.pathname.endsWith('/import/delete')) {
          const body = JSON.parse(String(init?.body));
          store.delete(`import:${body.token}`);
          return new Response('ok');
        }
        return new Response('Not found', { status: 404 });
      },
    }),
  } as unknown as DurableObjectNamespace;
}

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
  CREATE TABLE ledgers (id TEXT PRIMARY KEY, user_id TEXT, external_id TEXT, name TEXT, currency TEXT, month_start_day INTEGER DEFAULT 1, created_at TEXT);
  CREATE TABLE ledger_members (ledger_id TEXT, user_id TEXT, role TEXT, joined_at TEXT);
  CREATE TABLE devices (id TEXT PRIMARY KEY, user_id TEXT, name TEXT, platform TEXT, last_seen_at TEXT, last_ip TEXT, revoked_at TEXT, created_at TEXT);
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
  CREATE TABLE read_budget_projection (ledger_id TEXT, sync_id TEXT, user_id TEXT, budget_type TEXT, category_sync_id TEXT, amount REAL, period TEXT, start_day INTEGER, enabled INTEGER DEFAULT 1, source_change_id INTEGER DEFAULT 0, PRIMARY KEY (ledger_id, sync_id));
  CREATE TABLE user_account_projection (
    sync_id TEXT PRIMARY KEY, user_id TEXT, name TEXT, account_type TEXT, currency TEXT,
    initial_balance REAL DEFAULT 0, note TEXT, credit_limit REAL, billing_day INTEGER, payment_due_day INTEGER,
    bank_name TEXT, card_last_four TEXT, hidden INTEGER DEFAULT 0, source_change_id INTEGER DEFAULT 0
  );
  CREATE TABLE user_category_projection (sync_id TEXT PRIMARY KEY, user_id TEXT, name TEXT, kind TEXT, level INTEGER, sort_order INTEGER, icon TEXT, icon_type TEXT, custom_icon_path TEXT, icon_cloud_file_id TEXT, icon_cloud_sha256 TEXT, parent_name TEXT, parent_sync_id TEXT, source_change_id INTEGER DEFAULT 0);
  CREATE TABLE user_tag_projection (sync_id TEXT PRIMARY KEY, user_id TEXT, name TEXT, color TEXT, source_change_id INTEGER);
  CREATE TABLE audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, ledger_id TEXT, action TEXT, metadata_json TEXT, created_at TEXT);
  CREATE TABLE sync_push_idempotency (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, device_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL, response_json TEXT NOT NULL,
    created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
    UNIQUE(user_id, device_id, idempotency_key)
  );
  CREATE TABLE sync_cursors (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, device_id TEXT NOT NULL,
    ledger_external_id TEXT NOT NULL, last_cursor INTEGER DEFAULT 0 NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(user_id, device_id, ledger_external_id)
  );
`;

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:');
  sqlite.exec(DDL);
  db = makeD1(sqlite);
  doStorage = new Map();
  sqlite.prepare("INSERT INTO users (id, email, password_hash) VALUES (?, 'imp@x.com', 'x')").run(USER);
  sqlite.prepare("INSERT INTO devices (id, user_id, name, platform, created_at) VALUES ('d1', ?, 'd1', 'test', '2025-01-01T00:00:00Z')").run(USER);
  sqlite.prepare("INSERT INTO ledgers (id, user_id, external_id, name, currency, created_at) VALUES ('lg1', ?, 'L1', 'imp', 'CNY', '2025-01-01T00:00:00Z')").run(USER);
  sqlite.prepare("INSERT INTO ledger_members (ledger_id, user_id, role, joined_at) VALUES ('lg1', ?, 'owner', '2025-01-01T00:00:00Z')").run(USER);

  app = new Hono<{ Bindings: { DB: D1Database }; Variables: { userId: string } }>();
  app.use('*', async (c, next) => { c.set('userId', USER); await next(); });
  app.route('/api/v1/import', importRouter);
  app.route('/api/v1/write', writeRouter);
  app.route('/api/v1/sync', syncRouter);
});

afterEach(() => sqlite.close());

function mapping(overrides: Partial<ReturnType<typeof makeDefaultMapping>> = {}) {
  return { ...makeDefaultMapping(), ...overrides };
}

describe('parser 单元(移植上游 test_import_csv.py)', () => {
  it('beecount parser sniff + 映射完整', () => {
    const csv = 'Type,Category,Subcategory,Amount,Account,From Account,To Account,Note,Time,Tags,Attachments\n' +
      'Expense,餐饮,午餐,35.00,招行,,,星巴克,2024-05-01 12:30:00,商务,\n';
    const data = parseCsvText(csv);
    expect(data.sourceFormat).toBe('beecount');
    expect(data.suggestedMapping.txType).toBeTruthy();
    expect(data.suggestedMapping.amount).toBeTruthy();
  });

  it('generic parser 模糊列识别', () => {
    const csv = '类型,金额,时间,备注\n支出,35.00,2024-05-01 12:30,星巴克\n';
    const data = parseCsvText(csv);
    expect(data.sourceFormat).toBe('generic');
    expect(data.suggestedMapping.txType).toBe('类型');
    expect(data.suggestedMapping.amount).toBe('金额');
    expect(data.suggestedMapping.happenedAt).toBe('时间');
    expect(data.suggestedMapping.note).toBe('备注');
  });

  it('支付宝列名经 generic 识别(全集 alias)', () => {
    const csv = '交易时间,商品说明,金额(元),收/支,类别,收/付款方式\n2024-05-01,星巴克,35,支出,餐饮,招行\n';
    const data = parseCsvText(csv);
    expect(data.sourceFormat).toBe('generic');
    const m = data.suggestedMapping;
    expect(m.txType).toBe('收/支');
    expect(m.amount).toBe('金额(元)');
    expect(m.happenedAt).toBe('交易时间');
    expect(m.categoryName).toBe('类别');
    expect(m.note).toBe('商品说明');
  });

  it('微信列名经 generic 识别', () => {
    const csv = '交易时间,交易类型,商品,金额(元),收/支\n2024-05-01,商品消费,星巴克,35,支出\n';
    const data = parseCsvText(csv);
    expect(data.sourceFormat).toBe('generic');
    const m = data.suggestedMapping;
    expect(m.txType).toBe('收/支');
    expect(m.happenedAt).toBe('交易时间');
    expect(m.categoryName).toBe('交易类型');
  });

  it('apply_mapping happy path', () => {
    const csv = '类型,金额,时间,分类,备注\n支出,35.00,2024-05-01 12:30,餐饮,星巴克\n';
    const data = parseCsvText(csv);
    const txs = applyMapping(data.rows, data.suggestedMapping);
    expect(txs).toHaveLength(1);
    expect(txs[0].txType).toBe('expense');
    expect(txs[0].amount).toBe(35);
    expect(txs[0].note).toBe('星巴克');
    expect(txs[0].categoryName).toBe('餐饮');
  });

  it('必填映射缺失 → 返回空(本地 applyMapping 无错误数组)', () => {
    const csv = '金额,时间\n35,2024-05-01\n';
    const data = parseCsvText(csv);
    expect(data.suggestedMapping.txType).toBeNull();
    const txs = applyMapping(data.rows, data.suggestedMapping);
    expect(txs).toHaveLength(0);
  });

  it('tz offset 本地时间换算 UTC(issue #314)', () => {
    const csv = '类型,金额,时间,分类\n支出,35.00,2024-08-29 23:16,餐饮\n';
    const data = parseCsvText(csv);
    const m = { ...data.suggestedMapping, tzOffsetMinutes: 480 };
    const txs = applyMapping(data.rows, m);
    expect(txs).toHaveLength(1);
    expect(txs[0].happenedAt).toBe('2024-08-29T15:16:00.000Z');
  });

  it('tz offset None → 保持旧行为(naive 当 UTC)', () => {
    const csv = '类型,金额,时间,分类\n支出,35.00,2024-08-29 23:16,餐饮\n';
    const data = parseCsvText(csv);
    expect(data.suggestedMapping.tzOffsetMinutes).toBeNull();
    const txs = applyMapping(data.rows, data.suggestedMapping);
    expect(txs[0].happenedAt).toBe('2024-08-29T23:16:00.000Z');
  });

  it('用户手填映射覆盖 generic 未识别列', () => {
    const csv = '状态,金额,时间,分类\n支出,35,2024-05-01,餐饮\n';
    const data = parseCsvText(csv);
    expect(data.suggestedMapping.txType).toBeNull();
    const m = mapping({ txType: '状态', amount: '金额', happenedAt: '时间', categoryName: '分类' });
    const txs = applyMapping(data.rows, m);
    expect(txs).toHaveLength(1);
    expect(txs[0].txType).toBe('expense');
  });

  it('显式 datetime_format 消歧(1/2/2024)', () => {
    const csv = '类型,金额,时间,分类\n支出,35,1/2/2024,餐饮\n';
    const data = parseCsvText(csv);
    const mUs = mapping({ txType: '类型', amount: '金额', happenedAt: '时间', categoryName: '分类', datetimeFormat: 'MM/DD/YYYY' });
    const us = applyMapping(data.rows, mUs);
    expect(us[0].happenedAt).toBe('2024-01-02T00:00:00.000Z');
    const mEu = mapping({ txType: '类型', amount: '金额', happenedAt: '时间', categoryName: '分类', datetimeFormat: 'DD/MM/YYYY' });
    const eu = applyMapping(data.rows, mEu);
    expect(eu[0].happenedAt).toBe('2024-02-01T00:00:00.000Z');
  });

  it('负数支出(expenseIsNegative)→ expense + 正金额', () => {
    const csv = '类型,金额,时间,分类\n,−35.00,2024-05-01,餐饮\n';
    const data = parseCsvText(csv);
    const m = mapping({ txType: '类型', amount: '金额', happenedAt: '时间', categoryName: '分类', expenseIsNegative: true, stripCurrencySymbols: true });
    const txs = applyMapping(data.rows, m);
    expect(txs).toHaveLength(1);
    expect(txs[0].txType).toBe('expense');
    expect(txs[0].amount).toBe(35);
  });

  it('货币符号 + 千分位剥离', () => {
    const csv = '类型,金额,时间,分类\n支出,"¥1,234.50",2024-05-01,餐饮\n';
    const data = parseCsvText(csv);
    const txs = applyMapping(data.rows, data.suggestedMapping);
    expect(txs[0].amount).toBe(1234.5);
  });
});

describe('e2e:upload / preview / execute(移植上游 test_import_csv.py)', () => {
  function beecountCsv(): string {
    return 'Type,Category,Subcategory,Amount,Account,From Account,To Account,Note,Time,Tags,Attachments\n' +
      'Expense,Food,Lunch,35.00,招行,,,星巴克,2024-05-01 12:30:00,,\n' +
      'Expense,Food,Coffee,28.00,微信,,,瑞幸,2024-05-02 09:15:00,,\n' +
      'Income,Salary,,8000.00,招行,,,5月工资,2024-05-05 18:00:00,,\n';
  }

  async function upload(csv: string, extraForm: Record<string, string> = {}): Promise<Response> {
    const form = new FormData();
    form.append('file', new Blob([csv], { type: 'text/csv' }), 'test.csv');
    for (const [k, v] of Object.entries(extraForm)) form.append(k, v);
    return app.request('/api/v1/import/upload', {
      method: 'POST',
      headers: { 'X-Device-ID': 'd1', 'CF-Connecting-IP': '127.0.0.1' },
      body: form,
    }, { DB: db, BEECOUNT_DO: makeDo(doStorage) } as any);
  }

  const env = () => ({ DB: db, BEECOUNT_DO: makeDo(doStorage) } as any);

  it('upload happy path:beecount 3 行,统计正确', async () => {
    const res = await upload(beecountCsv(), { target_ledger_id: 'L1' });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.source_format).toBe('beecount');
    expect(body.stats.total_rows).toBe(3);
    expect(body.stats.by_type.expense_count).toBe(2);
    expect(body.stats.by_type.income_count).toBe(1);
    expect(body.import_token).toBeTruthy();
    expect(body.sample_rows).toHaveLength(3);
  });

  it('upload 带 tz_offset → sample_transactions 为换算后 UTC', async () => {
    const csv = '类型,分类,金额,账户,时间\n支出,彩票,819.19,工行,2026-05-23 21:28:52\n';
    const res = await upload(csv, { target_ledger_id: 'L1', tz_offset_minutes: '480' });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    const ts = body.sample_transactions[0].happened_at;
    expect(new Date(ts).toISOString()).toBe('2026-05-23T13:28:52.000Z');
  });

  it('preview 目标账本变化时重算账户匹配', async () => {
    const res = await upload(beecountCsv(), { target_ledger_id: 'L1' });
    const body = await res.json() as any;
    const tokenId = body.import_token as string;
    const acc = await app.request('/api/v1/write/ledgers/L1/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Device-ID': 'd1' },
      body: JSON.stringify({ name: '招行', currency: 'CNY', base_change_id: 0 }),
    }, env());
    expect(acc.status).toBe(200);

    const pv = await app.request(`/api/v1/import/${tokenId}/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Device-ID': 'd1' },
      body: JSON.stringify({ target_ledger_id: 'L1' }),
    }, env());
    expect(pv.status).toBe(200);
    const pvBody = await pv.json() as any;
    const accounts = pvBody.stats.accounts;
    expect(accounts.matched_names).toContain('招行');
    expect(accounts.new_names).not.toContain('招行');
  });

  it('文件过大 → 413', async () => {
    const big = 'x'.repeat(11 * 1024 * 1024);
    const res = await upload(big);
    expect(res.status).toBe(413);
  });

  it('无数据行 → 400', async () => {
    const res = await upload('header_only\n');
    expect(res.status).toBe(400);
  });

  it('无效 token → 410', async () => {
    const res = await app.request('/api/v1/import/imp_does_not_exist/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }, env());
    expect(res.status).toBe(410);
  });

  it('二次上传驱逐第一个 token', async () => {
    const r1 = await upload(beecountCsv(), { target_ledger_id: 'L1' });
    const firstToken = (await r1.json() as any).import_token as string;
    const r2 = await upload(beecountCsv(), { target_ledger_id: 'L1' });
    const secondToken = (await r2.json() as any).import_token as string;
    expect(firstToken).not.toBe(secondToken);

    const stale = await app.request(`/api/v1/import/${firstToken}/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }, env());
    expect(stale.status).toBe(410);
  });

  it('execute 走通:3 笔落投影(SSE complete)', async () => {
    const r = await upload(beecountCsv(), { target_ledger_id: 'L1' });
    const tokenId = (await r.json() as any).import_token as string;
    const ex = await app.request(`/api/v1/import/${tokenId}/execute`, {
      method: 'POST',
      headers: { 'X-Device-ID': 'd1', 'CF-Connecting-IP': '127.0.0.1' },
    }, env());
    expect(ex.status).toBe(200);
    const text = await ex.text();
    expect(text).toContain('event: complete');
    expect(text).toContain('"created_tx_count":3');

    const cnt = sqlite.prepare('SELECT COUNT(*) AS c FROM read_tx_projection WHERE ledger_id = ?').get('lg1') as { c: number };
    expect(cnt.c).toBe(3);
  });

  it('cancel token → 200 cancelled,再 preview 410', async () => {
    const r = await upload(beecountCsv(), { target_ledger_id: 'L1' });
    const tokenId = (await r.json() as any).import_token as string;
    const rd = await app.request(`/api/v1/import/${tokenId}`, {
      method: 'DELETE',
      headers: { 'X-Device-ID': 'd1' },
    }, env());
    expect(rd.status).toBe(200);
    const rdBody = await rd.json() as any;
    expect(rdBody.cancelled).toBe(true);

    const stale = await app.request(`/api/v1/import/${tokenId}/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }, env());
    expect(stale.status).toBe(410);
  });
});