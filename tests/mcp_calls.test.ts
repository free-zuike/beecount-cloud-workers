/**
 * mcp_calls 路由本地覆盖（此前既无上游对拍也无测试）。
 * 聚焦：鉴权、空结果形状、client_label/client_active 解析、按 status 过滤、非法 status 校验、limit 夹紧。
 */
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import mcpCallsRouter from '../src/routes/mcp_calls';
import { createAccessToken } from '../src/auth';
import { createRouteDb, insertUser, insertPat, insertCallLog, withAuth, ROUTE_JWT_SECRET } from './helpers/route-harness';

function makeApp(db: D1Database): Hono {
  const app = new Hono<{ Bindings: any; Variables: { userId: string } }>();
  withAuth(app);
  app.route('/api/v1/mcp-calls', mcpCallsRouter);
  return app;
}

async function auth(userId = 'u1'): Promise<Record<string, string>> {
  return { Authorization: `Bearer ${await createAccessToken(userId, ROUTE_JWT_SECRET, ['app_write'])}` };
}

function envOf(db: D1Database) {
  return { DB: db, JWT_SECRET: ROUTE_JWT_SECRET } as any;
}

describe('mcp_calls 路由（本地覆盖）', () => {
  it('无 token → 401', async () => {
    const { db } = createRouteDb();
    const app = makeApp(db);
    const res = await app.request('/api/v1/mcp-calls', {}, envOf(db));
    expect(res.status).toBe(401);
  });

  it('空日志 → items=[], total=0', async () => {
    const { sqlite, db } = createRouteDb();
    insertUser(sqlite, 'u1');
    const app = makeApp(db);
    const res = await app.request('/api/v1/mcp-calls', { headers: await auth() }, envOf(db));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body).toEqual({ items: [], total: 0 });
  });

  it('PAT 存在 → client_active=true，label 取当前名', async () => {
    const { sqlite, db } = createRouteDb();
    insertUser(sqlite, 'u1');
    insertPat(sqlite, 'pat-1', 'My Client');
    insertCallLog(sqlite, {
      user_id: 'u1', pat_id: 'pat-1', pat_prefix: 'pat_', pat_name: 'Old', tool_name: 'search_transactions',
      status: 'ok', error_message: null, args_summary: '{}', duration_ms: 12, client_ip: '1.2.3.4',
      called_at: '2026-05-20T04:00:00Z',
    });
    const app = makeApp(db);
    const res = await app.request('/api/v1/mcp-calls', { headers: await auth() }, envOf(db));
    const body = await res.json() as any;
    expect(body.total).toBe(1);
    const item = body.items[0];
    expect(item.client_active).toBe(true);
    expect(item.client_label).toBe('My Client');
    expect(item.tool_name).toBe('search_transactions');
    expect(item.status).toBe('ok');
  });

  it('PAT 已删 → client_active=false，降级到 pat_name', async () => {
    const { sqlite, db } = createRouteDb();
    insertUser(sqlite, 'u1');
    insertCallLog(sqlite, {
      user_id: 'u1', pat_id: 'pat-1', pat_prefix: 'pat_', pat_name: 'Old Name', tool_name: 'get_transaction',
      status: 'error', error_message: 'boom', args_summary: '{}', duration_ms: 5, client_ip: '1.2.3.4',
      called_at: '2026-05-20T04:00:00Z',
    });
    const app = makeApp(db);
    const res = await app.request('/api/v1/mcp-calls', { headers: await auth() }, envOf(db));
    const body = await res.json() as any;
    expect(body.items[0].client_active).toBe(false);
    expect(body.items[0].client_label).toBe('Old Name');
    expect(body.items[0].status).toBe('error');
  });

  it('按 status=error 过滤只返回 error 条目', async () => {
    const { sqlite, db } = createRouteDb();
    insertUser(sqlite, 'u1');
    insertCallLog(sqlite, {
      user_id: 'u1', pat_id: null, pat_prefix: null, pat_name: null, tool_name: 't1',
      status: 'ok', error_message: null, args_summary: '{}', duration_ms: 1, client_ip: '1.2.3.4',
      called_at: '2026-05-20T04:00:00Z',
    });
    insertCallLog(sqlite, {
      user_id: 'u1', pat_id: null, pat_prefix: null, pat_name: null, tool_name: 't2',
      status: 'error', error_message: 'x', args_summary: '{}', duration_ms: 1, client_ip: '1.2.3.4',
      called_at: '2026-05-20T04:00:00Z',
    });
    const app = makeApp(db);
    const res = await app.request('/api/v1/mcp-calls?status=error', { headers: await auth() }, envOf(db));
    const body = await res.json() as any;
    expect(body.total).toBe(1);
    expect(body.items[0].tool_name).toBe('t2');
  });

  it('status 非法值 → 422', async () => {
    const { sqlite, db } = createRouteDb();
    insertUser(sqlite, 'u1');
    const app = makeApp(db);
    const res = await app.request('/api/v1/mcp-calls?status=bogus', { headers: await auth() }, envOf(db));
    expect(res.status).toBe(422);
  });

  it('limit 超出上限被夹紧为 200 且不报错', async () => {
    const { sqlite, db } = createRouteDb();
    insertUser(sqlite, 'u1');
    const app = makeApp(db);
    const res = await app.request('/api/v1/mcp-calls?limit=9999', { headers: await auth() }, envOf(db));
    expect(res.status).toBe(200);
  });
});
