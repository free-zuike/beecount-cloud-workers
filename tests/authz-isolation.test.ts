import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { createTestEnv, registerTestUser, loginTestUser } from './helpers/test-env';
import authRouter from '../src/routes/auth';

// 移植上游 tests/test_authz_isolation.py 的多用户隔离回归:
// B 看不到也碰不到 A 的账本;两用户可各自使用相同 external_id("default");
// REGISTRATION_ENABLED=false 时注册 403。
let env: Awaited<ReturnType<typeof createTestEnv>>;

beforeEach(async () => {
  env = await createTestEnv();
});

async function registerUser(email: string, deviceId: string) {
  await registerTestUser(env.app, email, 'password123', deviceId);
  const { body } = await loginTestUser(env.app, email, 'password123', deviceId);
  return { token: body.access_token, deviceId };
}

function pushHeaders(token: string, deviceId: string) {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    'X-Device-ID': deviceId,
  };
}

async function pushSnapshot(token: string, deviceId: string, ledgerId: string) {
  const snapshot = JSON.stringify({
    ledgerName: ledgerId, currency: 'CNY', count: 0,
    items: [], accounts: [], categories: [], tags: [],
  });
  return env.app.request('/api/v1/sync/push', {
    method: 'POST',
    headers: pushHeaders(token, deviceId),
    body: JSON.stringify({
      device_id: deviceId,
      changes: [{
        ledger_id: ledgerId,
        entity_type: 'ledger_snapshot',
        entity_sync_id: ledgerId,
        action: 'upsert',
        payload: { content: snapshot },
        updated_at: new Date().toISOString(),
      }],
    }),
  });
}

describe('多用户隔离(移植上游 test_authz_isolation.py)', () => {
  it('用户 B 不能看到/触碰用户 A 的账本', async () => {
    const a = await registerUser('a@example.com', 'dev-a');
    const b = await registerUser('b@example.com', 'dev-b');
    await pushSnapshot(a.token, a.deviceId, 'LA');
    // pushSnapshot 后 A 的账本已有 sync_changes,确保 /sync/ledgers 可见
    expect((await env.app.request('/api/v1/sync/ledgers', { headers: { Authorization: `Bearer ${a.token}` } })).status).toBe(200);

    // B 的 /sync/ledgers 为空
    const bLedgers = await env.app.request('/api/v1/sync/ledgers', {
      headers: { Authorization: `Bearer ${b.token}` },
    });
    expect(bLedgers.status).toBe(200);
    expect(await bLedgers.json()).toEqual([]);

    // B 不能 /sync/full A 的账本 → snapshot 为 null(有快照即泄漏)
    const bFull = await env.app.request('/api/v1/sync/full?ledger_id=LA', {
      headers: { Authorization: `Bearer ${b.token}` },
    });
    expect(bFull.status).toBe(200);
    const bFullBody = await bFull.json() as any;
    expect(bFullBody.snapshot).toBeNull();

    // B 读 A 的账本详情 → 404
    const bRead = await env.app.request('/api/v1/read/ledgers/LA', {
      headers: { Authorization: `Bearer ${b.token}` },
    });
    expect(bRead.status).toBe(404);

    // B push 到 ledger_id="LA" 建 B 自己的账本 — 不污染 A
    const push = await env.app.request('/api/v1/sync/push', {
      method: 'POST',
      headers: pushHeaders(b.token, b.deviceId),
      body: JSON.stringify({
        device_id: b.deviceId,
        changes: [{
          ledger_id: 'LA',
          entity_type: 'transaction',
          entity_sync_id: 'hack',
          action: 'upsert',
          payload: { amount: 9999, type: 'expense', happenedAt: new Date().toISOString() } as any,
          updated_at: new Date().toISOString(),
        }],
      }),
    });
    expect(push.status).toBe(200);

    // A 的账本仍然零交易
    const aDetail = await env.app.request('/api/v1/sync/full?ledger_id=LA', {
      headers: { Authorization: `Bearer ${a.token}` },
    });
    expect(aDetail.status).toBe(200);
    const aFullBody = await aDetail.json() as any;
    expect(aFullBody.snapshot).not.toBeNull();
    const content = JSON.parse(aFullBody.snapshot.payload?.content ?? '{}');
    expect(content.items ?? []).toEqual([]);

    // A 仍看到自己的账本
    const aLedgers = await env.app.request('/api/v1/sync/ledgers', {
      headers: { Authorization: `Bearer ${a.token}` },
    });
    const aLedgersBody = await aLedgers.json() as any;
    expect(aLedgersBody.map((lg: any) => lg.ledger_id)).toEqual(['LA']);
  });

  it('两个用户可各自使用相同 external_id default 互不冲突', async () => {
    const a = await registerUser('a@example.com', 'dev-a2');
    const b = await registerUser('b@example.com', 'dev-b2');
    await pushSnapshot(a.token, a.deviceId, 'default');
    await pushSnapshot(b.token, b.deviceId, 'default');

    const aLedgers = await (await env.app.request('/api/v1/sync/ledgers', {
      headers: { Authorization: `Bearer ${a.token}` },
    })).json() as any;
    const bLedgers = await (await env.app.request('/api/v1/sync/ledgers', {
      headers: { Authorization: `Bearer ${b.token}` },
    })).json() as any;
    expect(aLedgers.map((lg: any) => lg.ledger_id)).toEqual(['default']);
    expect(bLedgers.map((lg: any) => lg.ledger_id)).toEqual(['default']);
  });

  it('REGISTRATION_ENABLED=false 时注册拒绝 403', async () => {
    const { createMockDB } = await import('./helpers/mock-db');
    const db = createMockDB();
    const app = new Hono<{ Bindings: { DB: D1Database; JWT_SECRET: string; REGISTRATION_ENABLED?: string } }>();
    app.use('*', async (c, next) => {
      c.env = { DB: db, JWT_SECRET: 'test-secret', REGISTRATION_ENABLED: 'false' } as any;
      await next();
    });
    app.route('/api/v1/auth', authRouter);

    const res = await app.request('/api/v1/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'x@example.com', password: 'password123', device_id: 'dev-x', device_name: 'p', platform: 'app' }),
    });
    expect(res.status).toBe(403);
  });
});