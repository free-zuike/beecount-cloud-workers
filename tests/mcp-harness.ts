/**
 * MCP 测试共享脚手架（对齐上游 test_mcp_attachments.py 的 ledger fixture 结构）。
 * 真实 SQLite + 真实 write 路由：工具经 selfCall 走生产事务/投影/幂等逻辑。
 */
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import writeRouter from '../src/routes/write';
import batchWriteRouter from '../src/routes/batch_write';
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
  CREATE TABLE user_exchange_rate_projection (sync_id TEXT PRIMARY KEY, user_id TEXT, base_currency TEXT, quote_currency TEXT, rate REAL);
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

/** 注册默认设备（MCP 自调用需要 device 行） */
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