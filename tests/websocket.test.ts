/**
 * websocket 路由本地覆盖（此前既无上游对拍也无测试）。
 * 聚焦：与上游对齐的鉴权/对齐分支（缺 token/mock token/非 access type/缺 scope/用户不存在/缺 Upgrade 头）。
 * 真正的 WS 升级由 Durable Object 处理，这里用 stub 验证"走到 DO 转发"这一终点。
 */
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import wsRouter from '../src/routes/websocket';
import { createAccessToken } from '../src/auth';
import { createRouteDb, insertUser, ROUTE_JWT_SECRET } from './helpers/route-harness';

function makeApp(db: D1Database): Hono {
  const app = new Hono();
  app.route('/ws', wsRouter);
  return app;
}

const doStub = { fetch: async () => new Response('DO-REACHED', { status: 200 }) };

function envOf(db: D1Database) {
  return {
    DB: db,
    JWT_SECRET: ROUTE_JWT_SECRET,
    BEECOUNT_DO: { idFromName: () => ({}), get: () => doStub },
  } as any;
}

function request(token: string | undefined, upgrade = false): { path: string; headers: Record<string, string> } {
  return {
    path: `/ws${token ? `?token=${token}` : ''}`,
    headers: upgrade ? { Upgrade: 'websocket' } : {},
  };
}

describe('websocket 路由（本地覆盖，鉴权与对齐分支）', () => {
  it('缺少 token → 400', async () => {
    const { db } = createRouteDb();
    const app = makeApp(db);
    const { path, headers } = request(undefined);
    const res = await app.request(path, { headers }, envOf(db));
    expect(res.status).toBe(400);
  });

  it('无效 token → 401', async () => {
    const { db } = createRouteDb();
    const app = makeApp(db);
    const { path, headers } = request('not-a-jwt');
    const res = await app.request(path, { headers }, envOf(db));
    expect(res.status).toBe(401);
  });

  it('token type 非 access → 401', async () => {
    const { db } = createRouteDb();
    const app = makeApp(db);
    const token = await createAccessToken('u1', ROUTE_JWT_SECRET, ['app_write'], 3600, 'refresh');
    const { path, headers } = request(token);
    const res = await app.request(path, { headers }, envOf(db));
    expect(res.status).toBe(401);
  });

  it('access token 但无 app_write/web_write scope → 403', async () => {
    const { db } = createRouteDb();
    const app = makeApp(db);
    // 空 scopes → 不会写入 scopes claim → 与上游对齐的 scope 检查失败
    const token = await createAccessToken('u1', ROUTE_JWT_SECRET, []);
    const { path, headers } = request(token);
    const res = await app.request(path, { headers }, envOf(db));
    expect(res.status).toBe(403);
  });

  it('token 有效、scope 足够、但用户不存在 → 401', async () => {
    const { db } = createRouteDb();
    const app = makeApp(db);
    const token = await createAccessToken('ghost', ROUTE_JWT_SECRET, ['app_write']);
    const { path, headers } = request(token);
    const res = await app.request(path, { headers }, envOf(db));
    expect(res.status).toBe(401);
  });

  it('缺少 Upgrade 头 → 426', async () => {
    const { sqlite, db } = createRouteDb();
    insertUser(sqlite, 'u1');
    const app = makeApp(db);
    const token = await createAccessToken('u1', ROUTE_JWT_SECRET, ['app_write']);
    const { path } = request(token); // 不带 Upgrade
    const res = await app.request(path, { headers: {} }, envOf(db));
    expect(res.status).toBe(426);
  });

  it('access token + 正确 scope + 用户存在 + Upgrade 头 → 走到 DO 转发', async () => {
    const { sqlite, db } = createRouteDb();
    insertUser(sqlite, 'u1');
    const app = makeApp(db);
    const token = await createAccessToken('u1', ROUTE_JWT_SECRET, ['app_write']);
    const { path } = request(token, true);
    const res = await app.request(path, { headers: { Upgrade: 'websocket' } }, envOf(db));
    // 真正的 WS 升级由 Durable Object 接管；这里验证"所有鉴权/对齐守卫通过后已转发到 DO"。
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('DO-REACHED');
  });
});
