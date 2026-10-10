import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { authMiddleware } from '../src/middleware/auth';
import { createAccessToken } from '../src/auth';

// 构造最小 D1：users 查询可控（is_enabled），记录设备心跳 UPDATE 的 SQL
function mockDb(users: Record<string, { is_enabled: number }>) {
  let lastDeviceUpdateSql = '';
  const db = {
    prepare(sql: string) {
      let params: unknown[] = [];
      return {
        bind(...args: unknown[]) { params = args; return this; },
        async first<T = unknown>() {
          if (/SELECT id, is_enabled FROM users WHERE id = \?/.test(sql)) {
            const u = users[params[0] as string];
            return (u ? { id: params[0], is_enabled: u.is_enabled } : null) as T;
          }
          return null as T;
        },
        async run() { return { meta: { changes: 0 } }; },
        async all() { return { results: [] as unknown[] }; },
      };
    },
  } as unknown as D1Database;
  return { db, getLastDeviceUpdateSql: () => lastDeviceUpdateSql };
}

function buildApp(db: D1Database, secret = 'test-secret') {
  const app = new Hono<{ Bindings: { DB: D1Database; JWT_SECRET: string }; Variables: { userId: string } }>();
  // 先注册 oauth2 回调（模拟 index.ts 顺序：handler 先于 authMiddleware 挂载）
  app.get('/api/v1/admin/backup/remotes/oauth2/callback', (c) => c.text('CALLBACK-OK'));
  app.use('/api/v1/*', async (c, next) => {
    (c as any).env = { DB: db, JWT_SECRET: secret };
    return authMiddleware(c as any, next);
  });
  app.get('/api/v1/protected', (c) => c.json({ ok: true, userId: c.get('userId') }));
  app.get('/api/v1/mcp', (c) => c.text('MCP-OK'));
  return app;
}

async function makeToken(secret = 'test-secret', userId = 'user-1'): Promise<string> {
  return createAccessToken(userId, secret, ['app_write']);
}

describe('authMiddleware 安全边界（#16 回归）', () => {
  it('oauth2 回调先注册 → 保持公开（OAuth 提供商直接调用，不经过鉴权中间件）', async () => {
    const { db } = mockDb({});
    const app = buildApp(db);
    const res = await app.request('/api/v1/admin/backup/remotes/oauth2/callback');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('CALLBACK-OK');
  });

  it('mcp-calls 兄弟路径不再被裸 startsWith(\'/api/v1/mcp\') 豁免（无 token → 401）', async () => {
    const { db } = mockDb({});
    const app = buildApp(db);
    const res = await app.request('/api/v1/mcp-calls');
    expect(res.status).toBe(401);
  });

  it('/api/v1/mcp 本身仍豁免（无 token 可到达处理器）', async () => {
    const { db } = mockDb({});
    const app = buildApp(db);
    const res = await app.request('/api/v1/mcp');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('MCP-OK');
  });

  it('is_enabled=0 的用户即使 token 有效也拒绝（401）', async () => {
    const { db } = mockDb({ 'user-1': { is_enabled: 0 } });
    const app = buildApp(db);
    const token = await makeToken();
    const res = await app.request('/api/v1/protected', { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(401);
  });

  it('is_enabled=1 的用户正常通过并注入 userId', async () => {
    const { db } = mockDb({ 'user-1': { is_enabled: 1 } });
    const app = buildApp(db);
    const token = await makeToken();
    const res = await app.request('/api/v1/protected', { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; userId: string };
    expect(body.ok).toBe(true);
    expect(body.userId).toBe('user-1');
  });

  it('数据库中不存在的用户拒绝（401）', async () => {
    const { db } = mockDb({});
    const app = buildApp(db);
    const token = await makeToken();
    const res = await app.request('/api/v1/protected', { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(401);
  });

  it('无 Authorization 的受保护路径返回 401', async () => {
    const { db } = mockDb({});
    const app = buildApp(db);
    const res = await app.request('/api/v1/protected');
    expect(res.status).toBe(401);
  });
});
