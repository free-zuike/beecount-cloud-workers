import { describe, it, expect } from 'vitest';
import { createTestEnv, registerTestUser, loginTestUser } from '../helpers/test-env';

describe('Debug', () => {
  it('check token validation flow', async () => {
    const env = await createTestEnv();
    await registerTestUser(env.app, 'dbg@example.com');
    const { body } = await loginTestUser(env.app, 'dbg@example.com');
    console.log('login body:', JSON.stringify(body));
    const token = body.access_token;
    console.log('token:', token?.substring(0, 30) + '...');

    const res = await env.app.request('/api/v1/sync/ledgers', {
      headers: { Authorization: `Bearer ${token}` },
    });
    console.log('ledgers status:', res.status);
    const text = await res.text();
    console.log('ledgers body:', text);
  });

  it('check mock DB JOIN query', async () => {
    const env = await createTestEnv();
    await registerTestUser(env.app, 'join@example.com');
    const { body } = await loginTestUser(env.app, 'join@example.com');

    const res = await env.app.request('/api/v1/sync/pull?cursor=0', {
      headers: { Authorization: `Bearer ${body.access_token}` },
    });
    console.log('pull status:', res.status);
    const text = await res.text();
    console.log('pull body:', text);
  });
});
