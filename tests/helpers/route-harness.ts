/**
 * 三个"既无上游对拍也无测试"的 REST 路由（sys_config / websocket / mcp_calls）共用的最小基座。
 *
 * 用真实 SQLite（node:sqlite）驱动 D1 兼容包装，能跑真实 SQL；只建这些路由用到的表，
 * 避免拉入整套 schema 初始化。鉴权走真实 JWT（与生产 authMiddleware 同 secret 语义），
 * 仅注入 userId，从而把测试焦点放在路由自身的逻辑上。
 */
import { Hono } from 'hono';
import { createRealDb } from './realsql-db';
import { validateAccessToken } from '../../src/auth';

export const ROUTE_JWT_SECRET = 'test-secret-key-for-route-testing';

export function createRouteDb(): { sqlite: any; db: D1Database } {
  const { sqlite, db } = createRealDb();
  sqlite.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
      is_admin BOOLEAN DEFAULT 0, is_enabled BOOLEAN DEFAULT 1
    );
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
    CREATE TABLE personal_access_tokens (id TEXT PRIMARY KEY, user_id TEXT, name TEXT, prefix TEXT);
    CREATE TABLE mcp_call_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, pat_id TEXT, pat_prefix TEXT,
      pat_name TEXT, tool_name TEXT, status TEXT, error_message TEXT, args_summary TEXT,
      duration_ms INTEGER, client_ip TEXT, called_at TEXT
    );
  `);
  return { sqlite, db };
}

export function insertUser(sqlite: any, id: string, opts: { is_admin?: boolean; is_enabled?: boolean } = {}): void {
  const { is_admin = false, is_enabled = true } = opts;
  sqlite
    .prepare('INSERT INTO users (id, email, password_hash, is_admin, is_enabled) VALUES (?, ?, ?, ?, ?)')
    .run(id, `${id}@example.com`, 'hash', is_admin ? 1 : 0, is_enabled ? 1 : 0);
}

export function insertPat(sqlite: any, id: string, name: string): void {
  sqlite
    .prepare('INSERT INTO personal_access_tokens (id, user_id, name, prefix) VALUES (?, ?, ?, ?)')
    .run(id, 'u1', name, 'pat_');
}

export function insertCallLog(sqlite: any, fields: Record<string, unknown>): void {
  const cols = [
    'user_id', 'pat_id', 'pat_prefix', 'pat_name', 'tool_name', 'status',
    'error_message', 'args_summary', 'duration_ms', 'client_ip', 'called_at',
  ];
  const present = cols.filter((c) => fields[c] !== undefined);
  const sql = `INSERT INTO mcp_call_logs (${present.join(',')}) VALUES (${present.map(() => '?').join(',')})`;
  sqlite.prepare(sql).run(...present.map((c) => fields[c]));
}

/** 全局鉴权中间件：真实 JWT 校验并注入 userId（与生产 authMiddleware 同 secret 语义）。 */
export function withAuth(app: Hono): void {
  app.use('*', async (c, next) => {
    const env = (c.env as any) || {};
    (c as any).env = { ...env, JWT_SECRET: ROUTE_JWT_SECRET };
    const auth = c.req.header('Authorization');
    if (!auth || !auth.startsWith('Bearer ')) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    const res = await validateAccessToken(auth.slice(7), ROUTE_JWT_SECRET);
    if (!res || 'expired' in res) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    (c as any).set('userId', res.userId);
    await next();
  });
}
