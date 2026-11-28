import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import syncRouter from '../src/routes/sync';
import recurringRouter from '../src/routes/recurring';

// #148 周期规则 REST 路由挂载回归：上游挂在 api_prefix 根下
// （/api/v1/ledgers/{id}/recurring-rules，App 端与前端均按此路径请求），
// 曾因误挂 /api/v1/write 导致前端「新建周期账单」404。
let sqlite: DatabaseSync;
let db: D1Database;
let app: Hono<{ Bindings: { DB: D1Database; JWT_SECRET: string }; Variables: { userId: string; scopes?: string[] } }>;

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, is_admin BOOLEAN DEFAULT 0);
    CREATE TABLE ledgers (id TEXT PRIMARY KEY, user_id TEXT, external_id TEXT, name TEXT, currency TEXT, month_start_day INTEGER DEFAULT 1, created_at TEXT);
    CREATE TABLE ledger_members (ledger_id TEXT, user_id TEXT, role TEXT, joined_at TEXT);
    CREATE TABLE devices (id TEXT PRIMARY KEY, user_id TEXT, name TEXT, platform TEXT, app_version TEXT, os_version TEXT, device_model TEXT, last_ip TEXT, last_seen_at TEXT, revoked_at TEXT, created_at TEXT);
    CREATE TABLE mcp_state_records (
      id TEXT PRIMARY KEY, user_id TEXT, ledger_id TEXT, kind TEXT, status TEXT,
      data_json TEXT, next_due_at TEXT, revision INTEGER DEFAULT 1, created_at TEXT, updated_at TEXT
    );
    CREATE TABLE mcp_source_references (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, ledger_id TEXT, source_system TEXT,
      entity_type TEXT, entity_sync_id TEXT, metadata_json TEXT, created_at TEXT
    );
    CREATE TABLE sync_changes (
      change_id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, ledger_id TEXT, entity_type TEXT,
      entity_sync_id TEXT, action TEXT, payload_json TEXT, updated_at TEXT,
      updated_by_user_id TEXT, updated_by_device_id TEXT, scope TEXT
    );
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
      const out = [];
      for (const s of stmts) out.push(await s.run());
      return out;
    },
  } as unknown as D1Database;

  sqlite.prepare("INSERT INTO users (id, email, password_hash, is_admin) VALUES ('user-1', 'rr@x.com', 'x', 0)").run();
  sqlite.prepare("INSERT INTO devices (id, user_id, name, platform, app_version, created_at) VALUES ('d1', 'user-1', 'p', 'ios', '4.1.0', '2025-01-01')").run();
  sqlite.prepare("INSERT INTO ledgers (id, user_id, external_id, name, currency, created_at) VALUES ('ledger-1', 'user-1', 'lg1', 'L', 'CNY', '2025-01-01')").run();
  sqlite.prepare("INSERT INTO ledger_members (ledger_id, user_id, role, joined_at) VALUES ('ledger-1', 'user-1', 'owner', '2025-01-01')").run();

  app = new Hono<{ Bindings: { DB: D1Database; JWT_SECRET: string }; Variables: { userId: string } }>();
  app.use('*', async (c, next) => {
    c.set('userId', 'user-1');
    c.set('scopes', ['app_write']);
    await next();
  });
  // 复刻 index.ts 的挂载结构：根下 + /write 下
  app.route('/api/v1', recurringRouter);
});

afterEach(() => sqlite.close());

describe('周期规则 REST 挂载路径（对齐上游 api_prefix 根）', () => {
  it('GET /api/v1/ledgers/:ledgerId/recurring-rules 可达（空列表 200）', async () => {
    const res = await app.request('/api/v1/ledgers/lg1/recurring-rules', {}, { DB: db, JWT_SECRET: 'x' });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.items).toEqual([]);
    expect(body.can_create).toBe(true);
  });

  it('未知账本 → 404 Ledger not found（而非路由缺失）', async () => {
    const res = await app.request('/api/v1/ledgers/nope/recurring-rules', {}, { DB: db, JWT_SECRET: 'x' });
    expect(res.status).toBe(404);
    const body = await res.json() as Record<string, unknown>;
    expect(body.detail).toBe('Ledger not found');
  });

  it('旧规则行时间字段无效 → 列表仍 200（Invalid time value 生产回归）', async () => {
    // 生产实况：早期 MCP 写入的规则行存在空串/非 ISO 时间，recordOut 曾
    // 无条件 toISOString → RangeError → 整个列表 500
    sqlite.prepare(
      `INSERT INTO mcp_state_records (id, user_id, ledger_id, kind, revision, status, data_json, next_due_at, created_at, updated_at)
       VALUES ('r1', 'user-1', 'ledger-1', 'recurring_rule', 1, 'active', ?, NULL, '', 'not-a-date')`
    ).run(JSON.stringify({ rule: { name: '旧规则', frequency: 'monthly', time_zone: 'Asia/Shanghai' }, anchor_local: '2025-06-01T00:00:00+08:00' }));

    const res = await app.request('/api/v1/ledgers/lg1/recurring-rules', {}, { DB: db, JWT_SECRET: 'x' });
    expect(res.status).toBe(200);
    const body = await res.json() as { items: Array<Record<string, unknown>> };
    expect(body.items).toHaveLength(1);
    expect(body.items[0].created_at).toBeNull();        // 空串 → null
    expect(body.items[0].updated_at).toBe('not-a-date'); // 无效格式原样透传
    expect(body.items[0].next_due_at).toBeNull();
    // 生产回归：SELECT 必须带 revision —— 前端变更需要 expected_revision，
    // 漏列会导致列表项无 revision → 关闭/停用 422
    expect(body.items[0].revision).toBe(1);
  });

  it('旧 MCP 规则（非 UUID id）pause 不被 zod 误拦（生产回归）', async () => {
    sqlite.prepare(
      `INSERT INTO mcp_state_records (id, user_id, ledger_id, kind, revision, status, data_json, created_at, updated_at)
       VALUES ('old-rule-20240101', 'user-1', 'ledger-1', 'recurring_rule', 3, 'active', ?, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z')`
    ).run(JSON.stringify({
      rule: { name: '旧规则', frequency: 'monthly', starts_at: '2024-01-01', time_zone: 'Asia/Shanghai', day_of_month: 1 },
      anchor_local: '2024-01-01T00:00:00+08:00',
      execution_owner: 'cloud',
      next_index: 2,
    }));

    const res = await app.request('/api/v1/ledgers/lg1/recurring-rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'pause', record_id: 'old-rule-20240101', expected_revision: 3, confirm: true }),
    }, { DB: db, JWT_SECRET: 'x' });
    const body = await res.json() as { status?: string };
    expect(res.status).toBe(200);
    expect(body.status).toBe('paused');
  });
});
