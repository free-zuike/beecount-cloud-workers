import { describe, it, expect, beforeEach } from 'vitest';
import { createTestEnv, registerTestUser, loginTestUser } from './helpers/test-env';

// 移植上游 tests/test_profile_primary_currency.py:
// PATCH 大小写归一("usd"→"USD")、部分更新不清空、非法币种 422。
let env: Awaited<ReturnType<typeof createTestEnv>>;
let token: string;

beforeEach(async () => {
  env = await createTestEnv();
  await registerTestUser(env.app, 'pc@example.com');
  token = (await loginTestUser(env.app, 'pc@example.com')).body.access_token;
});

function patch(body: Record<string, unknown>) {
  return env.app.request('/api/v1/profile/me', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

describe('profile 主币种(移植上游 test_profile_primary_currency.py)', () => {
  it('PATCH primary_currency=usd → 200 且返回 USD;GET 读回 USD', async () => {
    const r = await patch({ primary_currency: 'usd' });
    expect(r.status).toBe(200);
    const body = await r.json() as any;
    expect(body.primary_currency).toBe('USD');
    const g = await env.app.request('/api/v1/profile/me', { headers: { Authorization: `Bearer ${token}` } });
    expect((await g.json() as any).primary_currency).toBe('USD');
  });

  it('部分更新 display_name 不清空 primary_currency', async () => {
    await patch({ primary_currency: 'JPY' });
    await patch({ display_name: 'nick' });
    const body = await (await env.app.request('/api/v1/profile/me', { headers: { Authorization: `Bearer ${token}` } })).json() as any;
    expect(body.primary_currency).toBe('JPY');
    expect(body.display_name).toBe('nick');
  });

  it('非法币种 → 422', async () => {
    const r = await patch({ primary_currency: 'US-1' });
    expect(r.status).toBe(422);
  });
});