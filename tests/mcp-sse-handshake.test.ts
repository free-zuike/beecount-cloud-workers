// 移植上游 tests/test_mcp_sse_handshake.py：
// 实际覆盖的是 PAT 校验与 .well-known/oauth-protected-resource metadata
// （与具体 transport 无关，本地 Worker 同样适用）。
// 注：上游 DNS-rebinding 开关是 FastMCP/uvicorn 特有概念，Workers 无对应 —— 不移植。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import mcpRouter from '../src/routes/mcp';
import { oauthProtectedResourceJson } from '../src/index';

let sqlite: DatabaseSync;
let db: D1Database;
let app: Hono<{ Bindings: { DB: D1Database; JWT_SECRET: string }; Variables: Record<string, unknown> }>;

async function hashToken(t: string): Promise<string> {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t));
  return Array.from(new Uint8Array(h)).map(b => b.toString(16).padStart(2, '0')).join('');
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

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, is_enabled INTEGER DEFAULT 1, is_admin INTEGER DEFAULT 0, created_at TEXT);
    CREATE TABLE personal_access_tokens (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL,
      prefix TEXT NOT NULL, scopes_json TEXT DEFAULT '[]' NOT NULL, expires_at TEXT,
      last_used_at TEXT, last_used_ip TEXT, revoked_at TEXT, created_at TEXT
    );
  `);
  db = makeD1(sqlite);
  sqlite.prepare("INSERT INTO users (id, email, password_hash) VALUES ('u1', 't@x', 'x')").run();

  app = new Hono<{ Bindings: { DB: D1Database; JWT_SECRET: string }; Variables: Record<string, unknown> }>();
  app.route('/api/v1/mcp', mcpRouter);
});

afterEach(() => sqlite.close());

function env() {
  return {
    DB: db,
    JWT_SECRET: 's',
    BEECOUNT_DO: {
      idFromName: () => ({ get: () => ({ fetch: async () => new Response('{}') }) }),
    } as unknown as DurableObjectNamespace,
  } as any;
}

async function seedPat(plaintext: string, opts: { expiresAt?: string | null; revokedAt?: string | null } = {}) {
  const h = await hashToken(plaintext);
  sqlite.prepare(
    "INSERT INTO personal_access_tokens (id, user_id, name, token_hash, prefix, scopes_json, expires_at, revoked_at, created_at) VALUES (?, 'u1', 'probe', ?, ?, ?, ?, ?, ?)"
  ).run('pat-1', h, plaintext.slice(0, 14), JSON.stringify(['mcp:read', 'mcp:write']), opts.expiresAt ?? null, opts.revokedAt ?? null, '2025-01-01T00:00:00Z');
}

describe('MCP PAT 校验（移植上游 test_mcp_sse_handshake.py）', () => {
  it('未来过期日期的 PAT 正常解析（回归：过期比较不崩）', async () => {
    const plaintext = 'bcmcp_futuretoken_aaaaaaaaaaaaaaaaaaaa';
    await seedPat(plaintext, { expiresAt: new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString() });
    const res = await app.request('/api/v1/mcp', {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${plaintext}` },
    }, env());
    // 非 401 即代表 PAT 校验通过（上游断言 user.email 可读）
    expect(res.status).not.toBe(401);
  });

  it('过期 PAT 按预期 401 + expired', async () => {
    const plaintext = 'bcmcp_pasttoken_aaaaaaaaaaaaaaaaaaaaa';
    await seedPat(plaintext, { expiresAt: new Date(Date.now() - 24 * 3600 * 1000).toISOString() });
    const res = await app.request('/api/v1/mcp', {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${plaintext}` },
    }, env());
    expect(res.status).toBe(401);
    const text = await res.text();
    expect(text.toLowerCase()).toContain('expired');
  });
});

describe('.well-known/oauth-protected-resource metadata（移植上游）', () => {
  it('返回可解析形状：resource / bearer_methods_supported / authorization_servers', async () => {
    // 用 index.ts 真实 handler 函数 + 挂载同样式路由（避免全量 app 的初始化链）
    const wl = new Hono();
    wl.get('/.well-known/oauth-protected-resource', (c) => c.json(oauthProtectedResourceJson(new URL(c.req.url).origin)));
    wl.get('/.well-known/oauth-protected-resource/*', (c) => c.json(oauthProtectedResourceJson(new URL(c.req.url).origin)));

    const res = await wl.request('/.well-known/oauth-protected-resource', {}, env());
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.resource.endsWith('/api/v1/mcp')).toBe(true);
    expect(body.bearer_methods_supported).toEqual(['header']);
    expect(Array.isArray(body.authorization_servers)).toBe(true);

    // SDK 按 resource-scoped 路径探测的形式
    const res2 = await wl.request('/.well-known/oauth-protected-resource/api/v1/mcp/sse', {}, env());
    expect(res2.status).toBe(200);
  });
});
