import { Context, Next } from 'hono';
import { validateAccessToken } from '../auth';

export const authMiddleware = async (c: any, next: Next) => {
  const url = new URL(c.req.url);
  console.log('[AUTH] pathname=', url.pathname);
  // 2FA 验证端点使用 challenge_token（在请求体中），不需要 Authorization header
  if (url.pathname.includes('/2fa/verify')) {
    console.log('[AUTH] skipping 2fa/verify');
    return next();
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
  } catch {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  if (!c.env?.JWT_SECRET) {
    return c.json({ error: 'Server configuration error' }, 500);
  }

  const validationResult = await validateAccessToken(token, c.env.JWT_SECRET);
  if (!validationResult) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  if ('expired' in validationResult && validationResult.expired) {
    return c.json({ error: 'Token expired' }, 401);
  }
  if (!('userId' in validationResult)) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const userId = validationResult.userId;
  const deviceId = c.req.header('X-Device-ID') || c.req.header('x-device-id');

  if (deviceId && c.executionCtx) {
    const now = new Date().toISOString();
    const clientIp = c.req.header('CF-Connecting-IP');
    c.executionCtx.waitUntil(
      c.env.DB
        .prepare('UPDATE devices SET last_seen_at = ?, last_ip = ? WHERE id = ?')
        .bind(now, clientIp ?? null, deviceId)
        .run()
    );
  }

  c.set('userId', userId);
  c.set('deviceId', deviceId ?? null);
  return next();
};
