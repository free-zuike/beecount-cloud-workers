import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { validateAccessToken, base64urlDecode } from '../../src/auth';
import { createAccessToken, createRefreshToken } from '../../src/auth';

import authRouter from '../../src/routes/auth';
import syncRouter from '../../src/routes/sync';
import writeRouter from '../../src/routes/write';
import readRouter from '../../src/routes/read';
import profileRouter from '../../src/routes/profile';
import devicesRouter from '../../src/routes/devices';
import batchWriteRouter from '../../src/routes/batch_write';

type Bindings = {
  DB: D1Database;
  JWT_SECRET: string;
  CORS_ORIGINS?: string;
};

type Variables = {
  userId: string;
  deviceId: string | null;
};

export function createTestApp(db: D1Database, jwtSecret: string = 'test-secret-key-for-testing') {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

  app.use('*', async (c, next) => {
    c.env = { DB: db, JWT_SECRET: jwtSecret, CORS_ORIGINS: '*' } as any;
    return next();
  });

  app.use('*', async (c, next) => {
    return cors({ origin: '*' })(c, next);
  });

  const authMiddleware = async (c: any, next: () => Promise<void>, skipPaths: string[] = []) => {
    const requestPath = c.req.path;
    for (const skipPath of skipPaths) {
      if (requestPath.startsWith(skipPath)) {
        return next();
      }
    }

    const authHeader = c.req.header('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const token = authHeader.slice(7);
    try {
      const parts = token.split('.');
      if (parts.length !== 3) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const payloadStr = base64urlDecode(parts[1]);
      if (!payloadStr) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const payload = JSON.parse(payloadStr);
      if (payload.type !== 'access') {
        return c.json({ error: 'Invalid token type' }, 401);
      }
    } catch {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const validationResult = await validateAccessToken(token, jwtSecret);
    if (!validationResult) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    if ('expired' in validationResult && validationResult.expired) {
      return c.json({ error: 'TokenExpired' }, 401);
    }
    if (!('userId' in validationResult)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    c.set('userId', validationResult.userId);
    c.set('deviceId', c.req.header('X-Device-ID') || null);
    return next();
  };

  app.use('/api/v1/*', async (c, next) => {
    return authMiddleware(c, next, [
      '/api/v1/auth',
      '/api/v1/profile/avatar',
    ]);
  });

  app.use('/sync/*', async (c, next) => authMiddleware(c, next));
  app.use('/read/*', async (c, next) => authMiddleware(c, next));
  app.use('/write/*', async (c, next) => authMiddleware(c, next));
  app.use('/devices/*', async (c, next) => authMiddleware(c, next));
  app.use('/profile/*', async (c, next) => authMiddleware(c, next, ['/profile/avatar']));

  app.route('/api/v1/auth', authRouter);
  app.route('/api/v1/sync', syncRouter);
  app.route('/api/v1/write', writeRouter);
  app.route('/api/v1/write', batchWriteRouter);
  app.route('/api/v1/read', readRouter);
  app.route('/api/v1/devices', devicesRouter);
  app.route('/api/v1/profile', profileRouter);

  app.route('/sync', syncRouter);
  app.route('/write', writeRouter);
  app.route('/read', readRouter);
  app.route('/devices', devicesRouter);
  app.route('/profile', profileRouter);

  return app;
}
