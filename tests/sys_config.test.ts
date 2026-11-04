/**
 * sys_config 路由本地覆盖（此前既无上游对拍也无测试）。
 * 聚焦：admin 中间件（非 admin → 403）、默认空 s3 结构、S3 渠道 CRUD。
 */
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import sysConfigRouter from '../src/routes/sys_config';
import { createAccessToken } from '../src/auth';
import { createRouteDb, insertUser, withAuth, ROUTE_JWT_SECRET } from './helpers/route-harness';

function makeApp(db: D1Database): Hono {
  const app = new Hono<{ Bindings: any; Variables: { userId: string } }>();
  withAuth(app);
  app.route('/api/v1/sys-config', sysConfigRouter);
  return app;
}

async function auth(userId: string): Promise<Record<string, string>> {
  return { Authorization: `Bearer ${await createAccessToken(userId, ROUTE_JWT_SECRET, ['app_write'])}` };
}

function envOf(db: D1Database) {
  return { DB: db, JWT_SECRET: ROUTE_JWT_SECRET } as any;
}

const S3_BODY = JSON.stringify({
  name: 'R2', endpoint: 'https://s3.example.com', bucket_name: 'b',
  access_key_id: 'ak', secret_access_key: 'sk', region: 'auto',
});

describe('sys_config 路由（本地覆盖）', () => {
  it('非 admin → 403', async () => {
    const { sqlite, db } = createRouteDb();
    insertUser(sqlite, 'u2', { is_admin: false });
    const app = makeApp(db);
    const res = await app.request('/api/v1/sys-config/get', { headers: await auth('u2') }, envOf(db));
    expect(res.status).toBe(403);
  });

  it('admin 访问 GET /get 返回默认空 s3 结构', async () => {
    const { sqlite, db } = createRouteDb();
    insertUser(sqlite, 'u1', { is_admin: true });
    const app = makeApp(db);
    const res = await app.request('/api/v1/sys-config/get', { headers: await auth('u1') }, envOf(db));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(Array.isArray(body.s3.channels)).toBe(true);
    expect(body.s3.channels.length).toBe(0);
  });

  it('POST /s3 创建渠道，GET /s3 能列出', async () => {
    const { sqlite, db } = createRouteDb();
    insertUser(sqlite, 'u1', { is_admin: true });
    const app = makeApp(db);
    const created = await app.request('/api/v1/sys-config/s3', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...await auth('u1') }, body: S3_BODY,
    }, envOf(db));
    expect(created.status).toBe(200);
    const cfg = await created.json() as any;
    expect(cfg.id).toBe(1);
    expect(cfg.name).toBe('R2');
    const listed = await app.request('/api/v1/sys-config/s3', { headers: await auth('u1') }, envOf(db));
    const channels = await listed.json() as any;
    expect(channels.length).toBe(1);
    expect(channels[0].id).toBe(1);
  });

  it('PUT /s3/:id 更新渠道', async () => {
    const { sqlite, db } = createRouteDb();
    insertUser(sqlite, 'u1', { is_admin: true });
    const app = makeApp(db);
    const created = await app.request('/api/v1/sys-config/s3', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...await auth('u1') }, body: S3_BODY,
    }, envOf(db));
    const cfg = await created.json() as any;
    const updated = await app.request(`/api/v1/sys-config/s3/${cfg.id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', ...await auth('u1') },
      body: JSON.stringify({ name: 'R2-renamed' }),
    }, envOf(db));
    expect(updated.status).toBe(200);
    const u = await updated.json() as any;
    expect(u.name).toBe('R2-renamed');
  });

  it('DELETE /s3/:id 删除渠道', async () => {
    const { sqlite, db } = createRouteDb();
    insertUser(sqlite, 'u1', { is_admin: true });
    const app = makeApp(db);
    const created = await app.request('/api/v1/sys-config/s3', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...await auth('u1') }, body: S3_BODY,
    }, envOf(db));
    const cfg = await created.json() as any;
    const del = await app.request(`/api/v1/sys-config/s3/${cfg.id}`, { method: 'DELETE', headers: await auth('u1') }, envOf(db));
    expect(del.status).toBe(200);
    const listed = await app.request('/api/v1/sys-config/s3', { headers: await auth('u1') }, envOf(db));
    const channels = await listed.json() as any;
    expect(channels.length).toBe(0);
  });
});
