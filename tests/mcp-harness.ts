/**
 * MCP 测试共享脚手架（对齐上游 test_mcp_attachments.py 的 ledger fixture 结构）。
 * 真实 SQLite + 真实 write 路由：工具经 selfCall 走生产事务/投影/幂等逻辑。
 */
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import writeRouter from '../src/routes/write';
import batchWriteRouter from '../src/routes/batch_write';
import readRouter from '../src/routes/read';
import summaryRouter from '../src/routes/summary';
import syncRouter from '../src/routes/sync';
import type { McpContext } from '../src/mcp/types';

/** 真实表结构（含 #133 三张新表，与 src/db/schema.ts 对齐） */
export const DDL = `
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
  CREATE TABLE user_account_projection (
    sync_id TEXT NOT NULL, user_id TEXT NOT NULL, name TEXT, account_type TEXT, currency TEXT,
    initial_balance REAL, note TEXT, credit_limit REAL, billing_day INTEGER, payment_due_day INTEGER,
    bank_name TEXT, card_last_four TEXT, hidden INTEGER NOT NULL DEFAULT 0, source_change_id INTEGER DEFAULT 0,
    PRIMARY KEY (user_id, sync_id)
  );
  CREATE TABLE user_category_projection (sync_id TEXT NOT NULL, user_id TEXT NOT NULL, name TEXT, kind TEXT, level INTEGER, sort_order INTEGER, icon TEXT, icon_type TEXT, custom_icon_path TEXT, icon_cloud_file_id TEXT, icon_cloud_sha256 TEXT, parent_name TEXT, parent_sync_id TEXT, source_change_id INTEGER DEFAULT 0, PRIMARY KEY (user_id, sync_id));
  CREATE TABLE user_tag_projection (sync_id TEXT NOT NULL, user_id TEXT NOT NULL, name TEXT, color TEXT, source_change_id INTEGER, PRIMARY KEY (user_id, sync_id));
  CREATE TABLE attachment_files (
    id TEXT PRIMARY KEY, ledger_id TEXT, user_id TEXT, sha256 TEXT, size_bytes INTEGER,
    mime_type TEXT, file_name TEXT, storage_path TEXT, attachment_kind TEXT, created_at TEXT
  );
  CREATE TABLE read_budget_projection (ledger_id TEXT, sync_id TEXT, user_id TEXT, budget_type TEXT, category_sync_id TEXT, amount REAL, period TEXT, start_day INTEGER, enabled INTEGER DEFAULT 1, source_change_id INTEGER DEFAULT 0);
  CREATE TABLE audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, ledger_id TEXT, action TEXT, metadata_json TEXT, created_at TEXT);
  CREATE TABLE sync_push_idempotency (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, device_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL, response_json TEXT NOT NULL,
    created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
    UNIQUE(user_id, device_id, idempotency_key)
  );
  CREATE TABLE mcp_write_operations (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, ledger_id TEXT NOT NULL,
    request_key TEXT NOT NULL, request_hash TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL,
    plan_json TEXT NOT NULL, results_json TEXT NOT NULL, error_json TEXT,
    lease_id TEXT, lease_until TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    CONSTRAINT uq_mcp_operation_key UNIQUE (user_id, request_key)
  );
  CREATE TABLE mcp_state_records (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, ledger_id TEXT NOT NULL, kind TEXT NOT NULL,
    revision INTEGER NOT NULL, status TEXT NOT NULL, data_json TEXT NOT NULL, next_due_at TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE mcp_source_references (
    id TEXT PRIMARY KEY, ledger_id TEXT NOT NULL, tx_sync_id TEXT NOT NULL,
    source_system TEXT NOT NULL, source_id TEXT NOT NULL, metadata_json TEXT NOT NULL,
    created_by_user_id TEXT NOT NULL, created_at TEXT NOT NULL,
    CONSTRAINT uq_mcp_source_identity UNIQUE (ledger_id, source_system, source_id)
  );
  CREATE TABLE mcp_call_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, pat_id TEXT, pat_prefix TEXT, pat_name TEXT,
    tool_name TEXT, status TEXT, error_message TEXT, args_summary TEXT, duration_ms INTEGER, client_ip TEXT, called_at TEXT
  );
  CREATE TABLE user_profiles (user_id TEXT PRIMARY KEY, primary_currency TEXT, display_name TEXT);
  CREATE TABLE user_exchange_rate_projection (user_id TEXT NOT NULL, sync_id TEXT NOT NULL, base_currency TEXT NOT NULL, quote_currency TEXT NOT NULL, rate TEXT NOT NULL, updated_at TEXT NOT NULL, source_change_id INTEGER DEFAULT 0 NOT NULL, PRIMARY KEY (user_id, sync_id));
  CREATE TABLE exchange_rate_cache (base_currency TEXT PRIMARY KEY, rate_date TEXT, source TEXT, payload_json TEXT, fetched_at TEXT);
  CREATE TABLE sync_cursors (user_id TEXT, device_id TEXT, ledger_external_id TEXT, last_cursor INTEGER, updated_at TEXT, PRIMARY KEY (user_id, device_id, ledger_external_id));
`;

export type TestApp = Hono<{ Bindings: { DB: D1Database; JWT_SECRET: string }; Variables: { userId: string } }>;

export interface Harness {
  sqlite: DatabaseSync;
  db: D1Database;
  app: TestApp;
}

/** 挂载真实 write 路由 + 简化 auth（直接设 userId，不走 JWT） */
export function buildApp(): TestApp {
  const a = new Hono<{ Bindings: { DB: D1Database; JWT_SECRET: string }; Variables: { userId: string } }>();
  a.use('/api/v1/write/*', async (c, next) => {
    const uid = c.req.header('X-Test-User') || 'u1';
    c.set('userId', uid);
    await next();
  });
  a.route('/api/v1/write', writeRouter as never);
  a.route('/api/v1/write', batchWriteRouter as never);
  return a;
}

export function makeD1(s: DatabaseSync): D1Database {
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

/** 全新内存库 + 路由（不预置任何数据） */
export function makeHarness(): Harness {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(DDL);
  return { sqlite, db: makeD1(sqlite), app: buildApp() };
}

/** 注册用户（唯一 email） */
export function registerUser(h: Harness, id: string, email: string): void {
  h.sqlite.prepare('INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)').run(id, email, 'h');
}

/** 创建账本 + owner 成员（internalId/externalId 分离） */
export function createLedger(
  h: Harness,
  userId: string,
  internalId: string,
  externalId: string,
  name: string,
  currency = 'CNY',
  monthStartDay = 1,
): void {
  h.sqlite.prepare(
    'INSERT INTO ledgers (id, user_id, external_id, name, currency, month_start_day, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(internalId, userId, externalId, name, currency, monthStartDay, '2026-01-01T00:00:00Z');
  h.sqlite.prepare('INSERT INTO ledger_members (ledger_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)')
    .run(internalId, userId, 'owner', '2026-01-01T00:00:00Z');
}

/** 添加账本成员（editor/viewer） */
export function addMember(h: Harness, ledgerInternalId: string, userId: string, role: string): void {
  h.sqlite.prepare('INSERT INTO ledger_members (ledger_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)')
    .run(ledgerInternalId, userId, role, '2026-01-01T00:00:00Z');
}

/** 按表结构插入（PRAGMA 过滤掉该表不存在的列），避免测试与 schema 漂移耦合。 */
export function insertRow(sqlite: DatabaseSync, table: string, row: Record<string, unknown>): void {
  const cols = (sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(c => c.name);
  const keys = Object.keys(row).filter(k => cols.includes(k));
  if (keys.length === 0) return;
  const sql = `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`;
  sqlite.prepare(sql).run(...keys.map(k => row[k] as never));
}

/** 导入预览的样本文件：上游用 utf-8-sig 写出，本地必须同字节同 sha256 */
export const IMPORT_BYTES = Buffer.from(
  '\uFEFF日期,金额,类型,分类,备注\n2026-05-16,12.5,支出,餐饮,午饭\n2026-05-17,3000,收入,工资,五月工资\n',
  'utf8',
);
export const IMPORT_SHA = createHash('sha256').update(IMPORT_BYTES).digest('hex');

/** 与 scripts/parity/upstream_dump.py 完全对应的夹具（MCP 与 REST 差分共用） */
export function seed(h: Harness): void {
  registerUser(h, 'u1', 'u1@example.com');
  registerUser(h, 'u2', 'u2@example.com');
  createLedger(h, 'u1', 'L1-i', 'L1', '主账本', 'CNY');
  // L2 属于 u2，u1 是 editor（共享账本可见性）
  insertRow(h.sqlite, 'ledgers', {
    id: 'L2-i', external_id: 'L2', user_id: 'u2', name: '共享账本', currency: 'USD',
    month_start_day: 1, created_at: '2026-05-20T04:00:00Z', deleted_at: null,
  });
  addMember(h, 'L1-i', 'u1', 'owner');
  addMember(h, 'L2-i', 'u1', 'editor');
  addMember(h, 'L2-i', 'u2', 'owner');
  // L3：空账本，验证空数组/0/null 的形状；month_start_day=25 走非 1 号起始的分支
  createLedger(h, 'u1', 'L3-i', 'L3', '空账本', 'JPY', 25);
  addMember(h, 'L3-i', 'u1', 'owner');

  insertRow(h.sqlite, 'attachment_files', {
    id: 'f1', ledger_id: 'L1-i', user_id: 'u1', attachment_kind: 'transaction',
    file_name: 'seed.csv', mime_type: 'text/csv', storage_path: 'attachments/L1-i/f1_seed.csv',
    sha256: IMPORT_SHA, size_bytes: IMPORT_BYTES.length, created_at: '2026-05-01T00:00:00Z',
  });

  for (const c of [
    { sync_id: 'c1', name: '餐饮', kind: 'expense', sort_order: 1, icon: '🍜' },
    { sync_id: 'c2', name: '工资', kind: 'income', sort_order: 2 },
  ]) {
    insertRow(h.sqlite, 'user_category_projection', {
      ...c, user_id: 'u1', ledger_id: 'L1-i', parent_sync_id: null, last_change_id: 1,
    });
  }
  for (const a of [
    { sync_id: 'a1', name: '现金', account_type: 'cash', currency: 'CNY', hidden: 0 },
    { sync_id: 'a2', name: '招行', account_type: 'bank', currency: 'CNY', hidden: 0 },
  ]) {
    insertRow(h.sqlite, 'user_account_projection', {
      ...a, user_id: 'u1', ledger_id: 'L1-i', note: null, last_change_id: 1,
    });
  }
  insertRow(h.sqlite, 'user_tag_projection', {
    sync_id: 'g1', user_id: 'u1', ledger_id: 'L1-i', name: '出差', color: '#00bcf2', last_change_id: 1,
  });
  insertRow(h.sqlite, 'user_tag_projection', {
    sync_id: 'g2', user_id: 'u1', ledger_id: 'L1-i', name: '客户', color: '#ff9800', last_change_id: 1,
  });

  const txs = [
    ['t1', 'expense', 38, '2026-05-02T03:30:00Z', 'c1', 'a1', '星巴克', null, 'CNY', null],
    ['t2', 'expense', 12.5, '2026-05-02T03:30:00Z', 'c1', 'a1', '同秒第二笔', null, 'CNY', null],
    ['t3', 'income', 8000, '2026-05-10T02:30:00Z', 'c2', 'a2', null, null, 'CNY', null],
    ['t4', 'expense', 100, '2026-05-11T02:30:00Z', 'c1', 'a1', null, null, 'CNY', null],
    ['t5', 'expense', 20, '2026-05-12T02:30:00Z', 'c1', 'a1', null, null, 'CNY', null],
    ['t6', 'expense', 7.5, '2026-05-13T02:30:00Z', null, 'a1', null, null, 'USD', 1.03],
    ['t7', 'expense', 30, '2026-05-14T02:30:00Z', 'c1', 'a1', null, '出差,客户', 'CNY', null],
  ] as const;
  for (const [sync, kind, amount, happened, cat, acc, note, tags, cur, native] of txs) {
    insertRow(h.sqlite, 'read_tx_projection', {
      sync_id: sync, user_id: 'u1', ledger_id: 'L1-i', tx_type: kind, amount,
      happened_at: happened, category_sync_id: cat, account_sync_id: acc,
      category_name: cat === 'c1' ? '餐饮' : cat === 'c2' ? '工资' : null,
      account_name: acc === 'a1' ? '现金' : acc === 'a2' ? '招行' : null,
      note, tags_csv: tags, currency_code: cur, native_amount: native,
      from_account_id: null, to_account_id: null, from_account_name: null, to_account_name: null,
      exclude_from_stats: sync === 't4' ? 1 : 0,
      exclude_from_budget: sync === 't5' ? 1 : 0,
      source_change_id: 1, created_by_user_id: 'u1', created_at: happened, updated_at: happened,
      tags_sync_ids_json: null, tag_sync_ids_json: null,
    });
  }
}

/** 挂载真实 read + summary 路由（用于 REST 只读计算的差分；跳过 scopeGuard，直接注入 userId）。 */
export function buildReadApp(): TestApp {
  const a = new Hono<{ Bindings: { DB: D1Database; JWT_SECRET: string }; Variables: { userId: string } }>();
  a.use('/api/v1/read/*', async (c, next) => {
    c.set('userId', c.req.header('X-Test-User') || 'u1');
    await next();
  });
  a.route('/api/v1/read', readRouter as never);
  a.route('/api/v1/read/summary', summaryRouter as never);
  return a;
}

/** 挂载真实 sync 路由（pull 等），注入 userId，用于 sync 差分；不传 device_id 以跳过设备校验。 */
export function buildSyncApp(): TestApp {
  const a = new Hono<{ Bindings: { DB: D1Database; JWT_SECRET: string }; Variables: { userId: string } }>();
  a.use('/api/v1/sync/*', async (c, next) => {
    c.set('userId', c.req.header('X-Test-User') || 'u1');
    await next();
  });
  a.route('/api/v1/sync', syncRouter as never);
  return a;
}

/** 往 sync_changes 插与上游 golden 同内容的一条 change（transaction + category），
 * 用于 sync/pull 响应比对（两侧同种子 → 比响应结构 + payload 原样透传）。 */
export function seedSync(h: Harness): void {
  const UPD = '2026-05-16T03:30:00Z';
  for (const r of [
    {
      change_id: 1, entity_type: 'transaction', entity_sync_id: 't-sync-1', action: 'create',
      payload: {
        sync_id: 't-sync-1', tx_type: 'expense', amount: 12.5, happened_at: UPD, note: '午饭',
        category_sync_id: 'c1', account_sync_id: 'a1', currency_code: 'CNY',
        tags: [], createdByUserId: 'u1', updatedByUserId: 'u1',
      },
    },
    {
      change_id: 2, entity_type: 'category', entity_sync_id: 'c-sync-1', action: 'create',
      payload: { sync_id: 'c-sync-1', name: '餐饮', kind: 'expense', sort_order: 1, icon: '🍜' },
    },
  ] as const) {
    insertRow(h.sqlite, 'sync_changes', {
      change_id: r.change_id, user_id: 'u1', ledger_id: 'L1-i', entity_type: r.entity_type,
      entity_sync_id: r.entity_sync_id, action: r.action,
      payload_json: JSON.stringify(r.payload), updated_at: UPD,
      updated_by_device_id: null, updated_by_user_id: 'u1', scope: 'ledger',
    });
  }
}
export function registerDevice(h: Harness, userId: string, deviceId = 'dev-1'): void {
  h.sqlite.prepare('INSERT INTO devices (id, user_id, name, platform, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(deviceId, userId, 'mcp', 'app', '2026-01-01T00:00:00Z');
}

/** 设置主币种 */
export function setPrimaryCurrency(h: Harness, userId: string, currency: string): void {
  h.sqlite.prepare('INSERT OR REPLACE INTO user_profiles (user_id, primary_currency) VALUES (?, ?)')
    .run(userId, currency);
}

/** 构造 MCP 工具上下文 */
export function mcpCtx(h: Harness, userId: string, jwtSecret = 'test-secret'): McpContext {
  return { db: h.db, userId, jwtSecret, baseUrl: 'https://beecount.example.com' };
}

/** 工具调用 Result 转宽松对象 */
export function asObj<T = Record<string, unknown>>(v: unknown): T {
  return v as T;
}

/** 生产 write 路由自调用默认值用于单测：直接打 app（对齐上游 ledger fixture 的 run）。返回注入的 fn 供测试包装。 */
export function bindSelfCall(h: Harness, setSelfCall: (fn: (method: string, path: string, userId: string, body: unknown, headers?: Record<string, string>) => Promise<Record<string, unknown>>) => void): (method: string, path: string, userId: string, body: unknown, headers?: Record<string, string>) => Promise<Record<string, unknown>> {
  const fn = async (method: string, path: string, userId: string, body: unknown, headers?: Record<string, string>) => {
    const res = await h.app.request(path, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Test-User': userId, ...headers },
      body: JSON.stringify(body),
    }, { DB: h.db, JWT_SECRET: 'test-secret' });
    const text = await res.text();
    if (!res.ok) {
      const parsed = (() => { try { return JSON.parse(text); } catch { return null; } })() as Record<string, unknown> | null;
      const err = new Error(`Write request failed: ${res.status} ${text.slice(0, 500)}`) as Error & { status_code?: number; error_code?: string };
      err.status_code = res.status;
      if (res.status === 409 && text.includes('REVISION_CONFLICT')) err.error_code = 'REVISION_CONFLICT';
      throw err;
    }
    return JSON.parse(text) as Record<string, unknown>;
  };
  setSelfCall(fn);
  return fn;
}