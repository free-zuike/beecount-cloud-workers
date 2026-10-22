// 移植上游 tests/test_mcp_call_log.py
// 覆盖:summarizeArgs 脱敏(k=v、跳过 note/text、截断)、execTool 落库(success/error),
// 列表 endpoint(倒序/过滤/分页/总数)、client_label 解析(LEFT JOIN PAT)、用户隔离。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { authMiddleware } from '../src/middleware/auth';
import authRouter from '../src/routes/auth';
import profileRouter from '../src/routes/profile';
import mcpCallsRouter from '../src/routes/mcp_calls';
import mcpRouter, { execTool, summarizeArgs } from '../src/routes/mcp';

const TEST_JWT_SECRET = 'test-secret-key-for-testing';
const TEST_PASSWORD = '12345678';

const DDL = `
  CREATE TABLE users (
    id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
    is_admin BOOLEAN DEFAULT 0 NOT NULL, is_enabled BOOLEAN DEFAULT 1 NOT NULL,
    created_at TEXT DEFAULT (datetime('now')) NOT NULL, totp_enabled BOOLEAN DEFAULT 0 NOT NULL
  );
  CREATE TABLE user_profiles (
    user_id TEXT UNIQUE NOT NULL, display_name TEXT, avatar_file_id TEXT,
    avatar_version INTEGER DEFAULT 0, appearance_json TEXT, ai_config_json TEXT, primary_currency TEXT
  );
  CREATE TABLE refresh_tokens (
    id TEXT PRIMARY KEY, user_id TEXT, device_id TEXT, token_hash TEXT UNIQUE NOT NULL,
    expires_at TEXT NOT NULL, revoked_at TEXT, created_at TEXT
  );
  CREATE TABLE devices (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT DEFAULT 'Unknown Device',
    platform TEXT DEFAULT 'unknown', app_version TEXT, os_version TEXT, device_model TEXT,
    last_ip TEXT, last_seen_at TEXT NOT NULL, revoked_at TEXT, created_at TEXT DEFAULT (datetime('now')) NOT NULL
  );
  CREATE TABLE personal_access_tokens (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL,
    prefix TEXT NOT NULL, scopes_json TEXT DEFAULT '[]' NOT NULL, expires_at TEXT,
    last_used_at TEXT, last_used_ip TEXT, revoked_at TEXT, created_at TEXT
  );
  CREATE TABLE mcp_call_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, pat_id TEXT, pat_prefix TEXT, pat_name TEXT,
    tool_name TEXT NOT NULL, status TEXT NOT NULL, error_message TEXT, args_summary TEXT,
    duration_ms INTEGER DEFAULT 0, client_ip TEXT, called_at TEXT
  );
  CREATE TABLE ledgers (
    id TEXT PRIMARY KEY, user_id TEXT, external_id TEXT, name TEXT, currency TEXT, created_at TEXT
  );
  CREATE TABLE ledger_members (ledger_id TEXT, user_id TEXT, role TEXT, joined_at TEXT);
  CREATE TABLE sync_changes (
    change_id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, ledger_id TEXT, entity_type TEXT,
    entity_sync_id TEXT, action TEXT, payload_json TEXT, updated_at TEXT,
    updated_by_user_id TEXT, updated_by_device_id TEXT, scope TEXT
  );
  CREATE TABLE attachment_files (
    id TEXT PRIMARY KEY, ledger_id TEXT, user_id TEXT, sha256 TEXT, size_bytes INTEGER,
    mime_type TEXT, file_name TEXT, storage_path TEXT, attachment_kind TEXT, created_at TEXT
  );
`;

let sqlite: DatabaseSync;
let db: D1Database;
let app: Hono<{ Bindings: any }>;
let env: { DB: D1Database; JWT_SECRET: string };

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

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:');
  sqlite.exec(DDL);
  db = makeD1(sqlite);
  env = { DB: db, JWT_SECRET: TEST_JWT_SECRET };
  app = new Hono<{ Bindings: any }>();
  app.use('/api/v1/*', authMiddleware as any);
  app.route('/api/v1/auth', authRouter);
  app.route('/api/v1/profile', profileRouter);
  app.route('/api/v1/profile/mcp-calls', mcpCallsRouter);
  app.route('/api/v1/mcp', mcpRouter);
});

afterEach(() => sqlite.close());

async function api(method: string, path: string, body?: unknown, token?: string): Promise<Response> {
  const headers: Record<string, string> = {};
  headers['CF-Connecting-IP'] = '127.0.0.1';
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  return app.request(path, init, env);
}

async function register(email: string = 'owner@example.com'): Promise<any> {
  const res = await api('POST', '/api/v1/auth/register', {
    email,
    password: TEST_PASSWORD,
    client_type: 'web',
    device_name: 'pytest-web',
    platform: 'web',
  });
  expect(res.status).toBe(200);
  return res.json();
}

function seedLog(
  userId: string,
  overrides: Partial<{
    pat_id: string | null;
    pat_prefix: string | null;
    pat_name: string | null;
    tool_name: string;
    status: string;
    error_message: string | null;
    args_summary: string | null;
    duration_ms: number;
    client_ip: string | null;
    called_at: string;
  }> = {},
): number {
  const row = {
    pat_id: null as string | null,
    pat_prefix: 'bcmcp_xxxxxxxx' as string | null,
    pat_name: null as string | null,
    tool_name: 'list_ledgers',
    status: 'ok',
    error_message: null as string | null,
    args_summary: '' as string | null,
    duration_ms: 1,
    client_ip: '127.0.0.1' as string | null,
    called_at: new Date().toISOString(),
    ...overrides,
  };
  const r = sqlite.prepare(
    `INSERT INTO mcp_call_logs (user_id, pat_id, pat_prefix, pat_name, tool_name, status, error_message, args_summary, duration_ms, client_ip, called_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(userId, row.pat_id, row.pat_prefix, row.pat_name, row.tool_name, row.status, row.error_message, row.args_summary, row.duration_ms, row.client_ip, row.called_at);
  return Number(r.lastInsertRowid);
}

describe('summarizeArgs(对齐上游 _summarize_args)', () => {
  it('跳过敏感字段 note/text,保留结构化字段', () => {
    const s = summarizeArgs({
      amount: 38.5,
      tx_type: 'expense',
      category: '咖啡',
      note: '今天心情不好,在咖啡店待了一下午',
      text: '我今天在 xxx 花了 38',
    });
    expect(s).not.toBeNull();
    expect(s).toContain('amount=38.5');
    expect(s).toContain('tx_type=expense');
    expect(s).toContain('category=咖啡');
    expect(s).not.toContain('note');
    expect(s).not.toContain('心情');
    expect(s).not.toContain('text');
  });

  it('长字符串截断,总长 ≤200', () => {
    const s = summarizeArgs({ category: 'x'.repeat(100) });
    expect(s).not.toBeNull();
    expect(s!.length).toBeLessThanOrEqual(200);
    expect(s).toContain('category=');
  });

  it('空对象 / 全 None → null', () => {
    expect(summarizeArgs({})).toBeNull();
    expect(summarizeArgs({ x: null })).toBeNull();
    expect(summarizeArgs(undefined)).toBeNull();
  });
});

describe('execTool 调用日志落库', () => {
  let userId: string;

  beforeEach(async () => {
    await register();
    // 注册返回体不含用户 id,从 DB 反查
    const row = sqlite.prepare('SELECT id FROM users WHERE email = ?').get('owner@example.com') as { id: string };
    userId = row.id;
    // 种一个账本让 list_ledgers 有输出
    sqlite.prepare(`INSERT INTO ledgers (id, user_id, external_id, name, currency, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run('led-1', userId, 'ledger-1', '主账本', 'CNY', '2026-01-01T00:00:00Z');
    sqlite.prepare(`INSERT INTO ledger_members (ledger_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)`)
      .run('led-1', userId, '2026-01-01T00:00:00Z');
  });

  it('成功调用落一行:tool_name/status/args_summary/pat 信息/client_ip', async () => {
    await execTool(db, env as any, 'https://beecount.example.com', userId, ['mcp:read'], 'list_ledgers', { kind: 'expense' }, 'pat-1', 'bcmcp_abc123', 'Claude Desktop', '127.0.0.1');
    const rows = sqlite.prepare('SELECT * FROM mcp_call_logs').all() as any[];
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.tool_name).toBe('list_ledgers');
    expect(r.status).toBe('ok');
    expect(r.error_message).toBeNull();
    expect(r.args_summary).toBe('kind=expense');
    expect(r.duration_ms).toBeGreaterThanOrEqual(0);
    expect(r.client_ip).toBe('127.0.0.1');
    expect(r.pat_prefix).toBe('bcmcp_abc123');
    expect(r.pat_name).toBe('Claude Desktop');
  });

  it('失败调用落一行 error + error_message', async () => {
    await expect(
      execTool(db, env as any, 'https://beecount.example.com', userId, ['mcp:read'], 'no_such_tool', {}, 'pat-1', 'bcmcp_abc123', 'Claude Desktop', '127.0.0.1')
    ).rejects.toThrow(/Unknown tool/);
    const rows = sqlite.prepare('SELECT * FROM mcp_call_logs').all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('error');
    expect(rows[0].error_message).toContain('Unknown tool');
  });
});

describe('GET /profile/mcp-calls 列表', () => {
  it('按 called_at 倒序 + total + 过滤 + 分页', async () => {
    const user = await register('api@example.com');
    const token = user.access_token as string;
    const uid = (sqlite.prepare('SELECT id FROM users WHERE email = ?').get('api@example.com') as { id: string }).id;

    for (let i = 0; i < 5; i++) {
      seedLog(uid, {
        pat_prefix: 'bcmcp_xxxxxxxx',
        tool_name: i % 2 === 0 ? 'list_ledgers' : 'create_transaction',
        status: i < 4 ? 'ok' : 'error',
        error_message: i === 4 ? 'ValueError: x' : null,
        args_summary: `i=${i}`,
        duration_ms: 10 + i,
        called_at: new Date(Date.parse('2026-01-01T00:00:00Z') + i * 60_000).toISOString(),
      });
    }

    const res = await api('GET', '/api/v1/profile/mcp-calls', undefined, token);
    expect(res.status).toBe(200);
    const body = await res.json() as { total: number; items: any[] };
    expect(body.total).toBe(5);
    expect(body.items).toHaveLength(5);
    // called_at 倒序
    for (let i = 1; i < body.items.length; i++) {
      expect(body.items[i - 1].called_at >= body.items[i].called_at).toBe(true);
    }
    for (const item of body.items) {
      expect(typeof item.called_at).toBe('string');
      expect(item.client_active).toBe(false);
      expect(item.client_label).toBe('bcmcp_xxxxxxxx');
    }

    const res2 = await api('GET', '/api/v1/profile/mcp-calls?tool_name=list_ledgers', undefined, token);
    expect(res2.status).toBe(200);
    const items2 = (await res2.json() as any).items;
    expect(items2.length).toBe(3);
    expect(items2.every((it: any) => it.tool_name === 'list_ledgers')).toBe(true);

    const res3 = await api('GET', '/api/v1/profile/mcp-calls?status=error', undefined, token);
    const items3 = (await res3.json() as any).items;
    expect(items3).toHaveLength(1);
    expect(items3[0].status).toBe('error');

    const res4 = await api('GET', '/api/v1/profile/mcp-calls?limit=2&offset=2', undefined, token);
    const body4 = await res4.json() as any;
    expect(body4.total).toBe(5);
    expect(body4.items).toHaveLength(2);

    // 非法 status → 422
    const res5 = await api('GET', '/api/v1/profile/mcp-calls?status=partial', undefined, token);
    expect(res5.status).toBe(422);
  });

  it('client_label 解析:PAT 在 → 当前 name;PAT 已删 → 缓存 name;都没有 → prefix', async () => {
    const user = await register('label@example.com');
    const token = user.access_token as string;
    const uid = (sqlite.prepare('SELECT id FROM users WHERE email = ?').get('label@example.com') as { id: string }).id;

    sqlite.prepare(
      `INSERT INTO personal_access_tokens (id, user_id, name, token_hash, prefix, scopes_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run('pat-live', uid, 'Renamed Live', 'x'.repeat(64), 'bcmcp_live_xxxx', '["mcp:read"]', new Date().toISOString());
    seedLog(uid, { pat_id: 'pat-live', pat_prefix: 'bcmcp_live_xxxx', pat_name: 'Original Name' });
    seedLog(uid, { pat_id: null, pat_prefix: 'bcmcp_deld_xxxx', pat_name: 'Cached Name' });

    const res = await api('GET', '/api/v1/profile/mcp-calls', undefined, token);
    const items = (await res.json() as any).items as any[];
    const byPrefix: Record<string, any> = {};
    for (const it of items) byPrefix[it.pat_prefix] = it;
    expect(byPrefix['bcmcp_live_xxxx'].client_label).toBe('Renamed Live');
    expect(byPrefix['bcmcp_live_xxxx'].client_active).toBe(true);
    expect(byPrefix['bcmcp_deld_xxxx'].client_label).toBe('Cached Name');
    expect(byPrefix['bcmcp_deld_xxxx'].client_active).toBe(false);
  });

  it('用户隔离:A 看不到 B 的日志', async () => {
    await register('alice@example.com');
    await register('bob@example.com');
    const loginA = await api('POST', '/api/v1/auth/login', { email: 'alice@example.com', password: TEST_PASSWORD, device_id: 'd-a', client_type: 'web', device_name: 'web', platform: 'web' });
    const loginB = await api('POST', '/api/v1/auth/login', { email: 'bob@example.com', password: TEST_PASSWORD, device_id: 'd-b', client_type: 'web', device_name: 'web', platform: 'web' });
    const tokenA2 = (await loginA.json() as any).access_token;
    const tokenB = (await loginB.json() as any).access_token;
    const uidA = (sqlite.prepare('SELECT id FROM users WHERE email = ?').get('alice@example.com') as { id: string }).id;

    seedLog(uidA, { args_summary: 'alice secret' });

    const resB = await api('GET', '/api/v1/profile/mcp-calls', undefined, tokenB);
    expect(resB.status).toBe(200);
    expect(await resB.json()).toEqual({ total: 0, items: [] });

    const resA = await api('GET', '/api/v1/profile/mcp-calls', undefined, tokenA2);
    expect((await resA.json() as any).total).toBe(1);
  });
});