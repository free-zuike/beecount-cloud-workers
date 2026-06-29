import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { createMockDB } from '../helpers/mock-db';
import { createAccessToken, validateAccessToken } from '../../src/auth';

describe('Debug env', () => {
  it('c.env from middleware works', async () => {
    const JWT_SECRET = 'test-secret';
    const db = createMockDB();
    const app = new Hono();

    app.use('*', async (c, next) => {
      c.env = { DB: db, JWT_SECRET } as any;
      return next();
    });

    app.get('/test', async (c) => {
      const secret = c.env?.JWT_SECRET;
      return c.json({ secret });
    });

    const res = await app.request('/test');
    const body = await res.json();
    console.log('env from middleware:', JSON.stringify(body));
    expect(body.secret).toBe(JWT_SECRET);
  });

  it('validateAccessToken works in Node', async () => {
    const JWT_SECRET = 'test-secret';
    const token = await createAccessToken('user-1', JWT_SECRET);
    console.log('token:', token.substring(0, 40));
    const result = await validateAccessToken(token, JWT_SECRET);
    console.log('validate result:', JSON.stringify(result));
    expect(result).toEqual({ userId: 'user-1' });
  });

  it('env via app.request third arg', async () => {
    const JWT_SECRET = 'test-secret';
    const db = createMockDB();
    const app = new Hono();

    app.get('/test', async (c) => {
      const secret = c.env?.JWT_SECRET;
      return c.json({ secret });
    });

    const res = await app.request('/test', undefined, { DB: db, JWT_SECRET } as any);
    const body = await res.json();
    console.log('env from 3rd arg:', JSON.stringify(body));
    expect(body.secret).toBe(JWT_SECRET);
  });

  it('full auth middleware chain', async () => {
    const JWT_SECRET = 'test-secret';
    const db = createMockDB();
    const app = new Hono();

    app.use('*', async (c, next) => {
      c.env = { DB: db, JWT_SECRET } as any;
      return next();
    });

    app.use('*', async (c, next) => {
      const authHeader = c.req.header('Authorization');
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return c.json({ error: 'No auth' }, 401);
      }
      const token = authHeader.slice(7);
      const result = await validateAccessToken(token, c.env.JWT_SECRET);
      if (!result || !('userId' in result)) {
        return c.json({ error: 'Invalid token' }, 401);
      }
      c.set('userId', result.userId);
      return next();
    });

    app.get('/protected', async (c) => {
      return c.json({ userId: c.get('userId') });
    });

    const token = await createAccessToken('test-user', JWT_SECRET);
    const res = await app.request('/protected', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await res.json();
    console.log('auth chain result:', JSON.stringify(body));
    expect(res.status).toBe(200);
    expect(body.userId).toBe('test-user');
  });
});
