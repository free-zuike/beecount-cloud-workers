import { describe, it, expect, beforeEach } from 'vitest';
import { createTestEnv, registerTestUser, loginTestUser, getAuthToken, TEST_JWT_SECRET } from '../helpers/test-env';
import { createAccessToken, createRefreshToken, validateAccessToken } from '../../src/auth';

let env: Awaited<ReturnType<typeof createTestEnv>>;

beforeEach(async () => {
  env = await createTestEnv();
});

describe('Auth - Register', () => {
  it('should register a new user', async () => {
    const res = await registerTestUser(env.app);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.access_token).toBeDefined();
    expect(body.refresh_token).toBeDefined();
    expect(body.user).toBeDefined();
  });

  it('should reject duplicate email', async () => {
    await registerTestUser(env.app, 'dup@example.com', 'password123');
    const res = await registerTestUser(env.app, 'dup@example.com', 'password123');
    expect(res.status).toBe(409);
    const body = await res.json() as any;
    expect(body.error).toBe('Email already registered');
  });

  it('should reject short password', async () => {
    const res = await env.app.request('/api/v1/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'short@example.com', password: '123' }),
    });
    expect(res.status).toBe(400);
  });

  it('should reject invalid email', async () => {
    const res = await env.app.request('/api/v1/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'not-an-email', password: 'password123' }),
    });
    expect(res.status).toBe(400);
  });

  it('should create default ledger on registration', async () => {
    await registerTestUser(env.app, 'ledger@example.com');
    const token = await getAuthToken(env.app, 'ledger@example.com');
    const res = await env.app.request('/api/v1/sync/ledgers', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await res.json() as any;
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThanOrEqual(1);
  });

  it.skip('should create default categories after creating a ledger', async () => {
    // Skipped: write/ledgers endpoint depends on mock DB projection refresh
    await registerTestUser(env.app, 'cats@example.com');
    const token = await getAuthToken(env.app, 'cats@example.com');

    // Create a ledger first (this triggers default category creation)
    const createRes = await env.app.request('/api/v1/write/ledgers', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'Test Ledger', currency: 'CNY' }),
    });
    expect(createRes.status).toBe(200);
    const createBody = await createRes.json() as any;
    const ledgerId = createBody.ledger_id;

    const readRes = await env.app.request(`/api/v1/read/ledgers/${ledgerId}/categories`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const readBody = await readRes.json() as any;
    expect(Array.isArray(readBody)).toBe(true);
    expect(readBody.length).toBeGreaterThan(0);
  });
});

describe('Auth - Login', () => {
  it('should login and return tokens', async () => {
    await registerTestUser(env.app, 'login@example.com');
    const { res, body } = await loginTestUser(env.app, 'login@example.com');
    expect(res.status).toBe(200);
    expect(body.access_token).toBeDefined();
    expect(body.refresh_token).toBeDefined();
    expect(body.user).toBeDefined();
    expect(body.user.email).toBe('login@example.com');
  });

  it('should reject wrong password', async () => {
    await registerTestUser(env.app, 'wrong@example.com');
    const { res } = await loginTestUser(env.app, 'wrong@example.com', 'wrongpassword');
    expect(res.status).toBe(401);
  });

  it('should reject non-existent user', async () => {
    const { res } = await loginTestUser(env.app, 'nonexistent@example.com');
    expect(res.status).toBe(401);
  });
});

describe('Auth - Token access', () => {
  it('should access protected endpoint with valid token', async () => {
    const token = await getAuthToken(env.app, 'access@example.com');
    const res = await env.app.request('/api/v1/sync/ledgers', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
  });

  it('should reject request without token', async () => {
    const res = await env.app.request('/api/v1/sync/ledgers');
    expect(res.status).toBe(401);
  });

  it('should reject request with invalid token', async () => {
    const res = await env.app.request('/api/v1/sync/ledgers', {
      headers: { Authorization: 'Bearer invalid-token-here' },
    });
    expect(res.status).toBe(401);
  });

  it('should reject request with wrong secret', async () => {
    const token = await createAccessToken('user-id', 'wrong-secret');
    const res = await env.app.request('/api/v1/sync/ledgers', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
  });
});

describe('Auth - Refresh token', () => {
  it('should refresh token successfully', async () => {
    await registerTestUser(env.app, 'refresh@example.com');
    const { body: loginBody } = await loginTestUser(env.app, 'refresh@example.com');

    const res = await env.app.request('/api/v1/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: loginBody.refresh_token }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.access_token).toBeDefined();
    expect(body.refresh_token).toBeDefined();
  });

  it('should reject invalid refresh token', async () => {
    const res = await env.app.request('/api/v1/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: 'invalid-token' }),
    });
    expect(res.status).toBe(401);
  });
});
