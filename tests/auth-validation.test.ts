import { describe, it, expect, beforeEach } from 'vitest';
import { createTestEnv, registerTestUser } from './helpers/test-env';

// 移植上游 tests/test_auth_validation.py:
// 1) login 校验失败:本地 zValidator 返回 400(上游 422+VALIDATION_ERROR,variance);
// 2) refresh 旋转:连续两次 refresh 都成功且 token 每次不同(不撞唯一冲突)。
let env: Awaited<ReturnType<typeof createTestEnv>>;

beforeEach(async () => {
  env = await createTestEnv();
});

describe('auth 校验与 refresh 旋转(移植上游 test_auth_validation.py)', () => {
  it('login 空 email → 422 VALIDATION_ERROR(对齐上游)', async () => {
    const res = await env.app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: '', password: '123456', client_type: 'web', device_name: 'web', platform: 'web' }),
    });
    expect(res.status).toBe(422);
    const body = await res.json() as any;
    expect(body.error_code || body.error?.code || body.detail).toBeDefined();
  });

  it('refresh 连续两次旋转成功,新 token 与旧不同', async () => {
    await registerTestUser(env.app, 'refresh@example.com', 'password123');
    const login = await env.app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'refresh@example.com', password: 'password123', device_id: 'dev-r', device_name: 'd', platform: 'web' }),
    });
    expect(login.status).toBe(200);
    const loginBody = await login.json() as any;
    const firstRefresh = loginBody.refresh_token as string;

    const r1 = await env.app.request('/api/v1/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: firstRefresh }),
    });
    expect(r1.status).toBe(200);
    const secondRefresh = (await r1.json() as any).refresh_token as string;
    expect(secondRefresh).not.toBe(firstRefresh);

    const r2 = await env.app.request('/api/v1/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: secondRefresh }),
    });
    expect(r2.status).toBe(200);
  });
});