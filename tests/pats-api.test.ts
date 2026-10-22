// 移植上游 tests/test_pats_api.py
// PAT 生命周期 + 严格分流:创建/列表/更新/硬删,列表不返明文,
// PAT 不能调常规 API,MCP 端点拒绝 JWT/伪 PAT/已删 PAT,hash 一致性。
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { authMiddleware } from '../src/middleware/auth';
import authRouter from '../src/routes/auth';
import profileRouter from '../src/routes/profile';
import patsRouter from '../src/routes/pats';
import mcpRouter from '../src/routes/mcp';

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
    duration_ms INTEGER DEFAULT 0, called_at TEXT
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
  app.route('/api/v1/profile/pats', patsRouter);
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

describe('PAT 生命周期', () => {
  it('创建 PAT 明文仅返回一次,列表只含 prefix 不含明文', async () => {
    const user = await register();
    const token = user.access_token as string;

    const created = await api('POST', '/api/v1/profile/pats', {
      name: 'Claude Desktop',
      scopes: ['mcp:read'],
      expires_in_days: 30,
    }, token);
    expect(created.status).toBe(201);
    const body = await created.json() as any;
    expect(body.token.startsWith('bcmcp_')).toBe(true);
    expect(body.name).toBe('Claude Desktop');
    expect(Array.isArray(body.scopes)).toBe(true);
    expect(body.scopes).toEqual(['mcp:read']);
    expect(body.expires_at).not.toBeNull();

    const listed = await api('GET', '/api/v1/profile/pats', undefined, token);
    expect(listed.status).toBe(200);
    const items = await listed.json() as any[];
    expect(items.length).toBe(1);
    expect(items[0].id).toBe(body.id);
    expect(items[0].prefix).toBe('bcmcp_' + body.token.slice('bcmcp_'.length, 'bcmcp_'.length + 16));
    expect('token' in items[0]).toBe(false);
  });

  it('创建不设过期时间的 PAT,expires_at 为 null', async () => {
    const user = await register();
    const token = user.access_token as string;
    const created = await api('POST', '/api/v1/profile/pats', {
      name: 'Long-lived',
      scopes: ['mcp:read'],
      expires_in_days: null,
    }, token);
    expect(created.status).toBe(201);
    const body = await created.json() as any;
    expect(body.expires_at).toBeNull();
  });

  it('非法 scope 创建被拒 400', async () => {
    const user = await register();
    const token = user.access_token as string;
    const res = await api('POST', '/api/v1/profile/pats', {
      name: 'Bad',
      scopes: ['app_write'],
    }, token);
    expect(res.status).toBe(400);
    await res.json();
  });

  it('DELETE 一击硬删:PAT 消失、列表为空、二次删除 404', async () => {
    const user = await register();
    const token = user.access_token as string;
    const created = await api('POST', '/api/v1/profile/pats', {
      name: 'ToDelete',
      scopes: ['mcp:read'],
    }, token);
    const body = await created.json() as any;
    const patId = body.id as string;

    const deleted = await api('DELETE', `/api/v1/profile/pats/${patId}`, undefined, token);
    expect(deleted.status).toBe(200);
    await deleted.json();

    const listed = await api('GET', '/api/v1/profile/pats', undefined, token);
    const items = await listed.json() as any[];
    expect(items).toEqual([]);

    const again = await api('DELETE', `/api/v1/profile/pats/${patId}`, undefined, token);
    expect(again.status).toBe(404);
    await again.json();
  });

  it('PATCH 更新 name 与 scopes,列表同步反映', async () => {
    const user = await register();
    const token = user.access_token as string;
    const created = await api('POST', '/api/v1/profile/pats', {
      name: 'old',
      scopes: ['mcp:read'],
    }, token);
    const body = await created.json() as any;
    const patId = body.id as string;

    const patched = await api('PATCH', `/api/v1/profile/pats/${patId}`, {
      name: 'new',
      scopes: ['mcp:read', 'mcp:write'],
    }, token);
    expect(patched.status).toBe(200);
    const patchedBody = await patched.json() as any;
    expect(patchedBody.name).toBe('new');
    expect(new Set(patchedBody.scopes)).toEqual(new Set(['mcp:read', 'mcp:write']));

    const listed = await api('GET', '/api/v1/profile/pats', undefined, token);
    const items = await listed.json() as any[];
    expect(items[0].name).toBe('new');
    expect(new Set(items[0].scopes)).toEqual(new Set(['mcp:read', 'mcp:write']));
  });

  it('列表与创建响应的时间戳均带 UTC 标记', async () => {
    const user = await register();
    const token = user.access_token as string;
    const created = await api('POST', '/api/v1/profile/pats', {
      name: 'tz',
      scopes: ['mcp:read'],
      expires_in_days: 30,
    }, token);
    expect(created.status).toBe(201);
    const body = await created.json() as any;
    for (const field of ['expires_at', 'created_at']) {
      expect(body[field]).not.toBeNull();
      expect(body[field].includes('+00:00') || body[field].endsWith('Z')).toBe(true);
    }

    const listed = await api('GET', '/api/v1/profile/pats', undefined, token);
    const items = await listed.json() as any[];
    for (const field of ['expires_at', 'created_at']) {
      const v = items[0][field];
      expect(v).not.toBeNull();
      expect(v.includes('+00:00') || v.endsWith('Z')).toBe(true);
    }
  });

  it('用户 A 的 PAT 用户 B 不可见也不可撤销', async () => {
    const userA = await register('alice@example.com');
    const userB = await register('bob@example.com');
    const tokenA = userA.access_token as string;
    const tokenB = userB.access_token as string;

    const aRes = await api('POST', '/api/v1/profile/pats', {
      name: 'A 的 PAT',
      scopes: ['mcp:read'],
    }, tokenA);
    const aBody = await aRes.json() as any;
    const aPatId = aBody.id as string;

    const bList = await api('GET', '/api/v1/profile/pats', undefined, tokenB);
    expect(bList.status).toBe(200);
    expect(await bList.json()).toEqual([]);

    const bRevoke = await api('DELETE', `/api/v1/profile/pats/${aPatId}`, undefined, tokenB);
    expect(bRevoke.status).toBe(404);
    await bRevoke.json();
  });

  it('PAT 调常规 API /profile/me 被拒', async () => {
    const user = await register();
    const token = user.access_token as string;
    const created = await api('POST', '/api/v1/profile/pats', {
      name: 'MCP only',
      scopes: ['mcp:read', 'mcp:write'],
    }, token);
    const body = await created.json() as any;
    const patPlaintext = body.token as string;

    const res = await api('GET', '/api/v1/profile/me', undefined, patPlaintext);
    expect(res.status).toBe(401);
    await res.json();
  });

  it('PAT 不能创建新 PAT', async () => {
    const user = await register();
    const token = user.access_token as string;
    const created = await api('POST', '/api/v1/profile/pats', {
      name: 'Seed',
      scopes: ['mcp:read', 'mcp:write'],
    }, token);
    const body = await created.json() as any;
    const patPlaintext = body.token as string;

    const res = await api('POST', '/api/v1/profile/pats', {
      name: 'Escalated',
      scopes: ['mcp:read', 'mcp:write'],
    }, patPlaintext);
    expect(res.status).toBe(401);
    await res.json();
  });
});

describe('MCP 端点严格分流', () => {
  it('无 Authorization 调 MCP 返回 401', async () => {
    const res = await api('GET', '/api/v1/mcp');
    expect(res.status).toBe(401);
  });

  it('JWT access token 调 MCP 被拒', async () => {
    const user = await register();
    const token = user.access_token as string;
    const res = await api('GET', '/api/v1/mcp', undefined, token);
    expect(res.status).toBe(401);
  });

  it('乱写的 bcmcp token 调 MCP 返回 401', async () => {
    const res = await api('GET', '/api/v1/mcp', undefined, 'bcmcp_garbage_token_xxxxxxxxxxxxxxxxxx');
    expect(res.status).toBe(401);
  });

  it('已删除的 PAT 调 MCP 返回 401', async () => {
    const user = await register();
    const token = user.access_token as string;
    const created = await api('POST', '/api/v1/profile/pats', {
      name: 'Will be revoked',
      scopes: ['mcp:read'],
    }, token);
    const body = await created.json() as any;
    const patPlaintext = body.token as string;
    const patId = body.id as string;

    await api('DELETE', `/api/v1/profile/pats/${patId}`, undefined, token);

    const res = await api('GET', '/api/v1/mcp', undefined, patPlaintext);
    expect(res.status).toBe(401);
  });

  it('落库 token_hash 与 sha256(明文) 一致', async () => {
    const user = await register();
    const token = user.access_token as string;
    const created = await api('POST', '/api/v1/profile/pats', {
      name: 'HashCheck',
      scopes: ['mcp:read'],
    }, token);
    const body = await created.json() as any;
    const plaintext = body.token as string;
    const expectedHash = createHash('sha256').update(plaintext, 'utf-8').digest('hex');

    const row = sqlite.prepare('SELECT token_hash FROM personal_access_tokens WHERE id = ?').get(body.id as string) as any;
    expect(row).toBeDefined();
    expect(row.token_hash).toBe(expectedHash);
  });
});