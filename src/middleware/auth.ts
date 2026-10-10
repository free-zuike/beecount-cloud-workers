import { Context, Next } from 'hono';
import { validateAccessToken } from '../auth';

function isPathOrChild(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

export const authMiddleware = async (c: any, next: Next) => {
  const path = c.req.path;
  // Only these exact route trees are self-authenticating/public. Bare startsWith
  // would also exempt siblings such as /api/v1/mcp-calls.
  if (
    isPathOrChild(path, '/api/v1/auth') ||
    isPathOrChild(path, '/api/v1/mcp') ||
    isPathOrChild(path, '/api/v1/setup') ||
    isPathOrChild(path, '/api/v1/profile/avatar')
  ) {
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
      console.log(`[AUTH-MW] Invalid token format: parts=${parts.length}`);
      return c.json({ error: 'Unauthorized' }, 401);
    }
  } catch {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  if (!c.env?.JWT_SECRET) {
    return c.json({ 
      error: 'Server configuration: JWT_SECRET not configured',
      hint: 'Please set JWT_SECRET in your Cloudflare Worker environment variables'
    }, 500);
  }

  const validationResult = await validateAccessToken(token, c.env.JWT_SECRET);
  if (!validationResult) {
    console.log(`[AUTH-MW] Token rejected for ${path}: validation failed`);
    return c.json({ error: 'Unauthorized' }, 401);
  }
  if ('expired' in validationResult && validationResult.expired) {
    console.log(`[AUTH-MW] Token expired for ${path}`);
    return c.json({ error: 'Token expired' }, 401);
  }
  if (!('userId' in validationResult) || !validationResult.userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const userId = validationResult.userId;

  // 检查用户是否存在于数据库中（数据库被删后旧 token 不能继续使用）
  try {
    const user = await (c.env.DB as D1Database).prepare('SELECT id, is_enabled FROM users WHERE id = ?').bind(userId).first<{ id: string; is_enabled: number }>();
    if (!user || !user.is_enabled) {
      console.log(`[AUTH-MW] User ${userId} not found in database, rejecting token`);
      return c.json({ error: 'Unauthorized' }, 401);
    }
  } catch {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const deviceId = c.req.header('X-Device-ID') || c.req.header('x-device-id');

  if (deviceId && c.executionCtx) {
    const now = new Date().toISOString();
    const clientIp = c.req.header('CF-Connecting-IP');
    c.executionCtx.waitUntil(
      c.env.DB
        .prepare('UPDATE devices SET last_seen_at = ?, last_ip = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL')
        .bind(now, clientIp ?? null, deviceId, userId)
        .run()
    );
  }

  c.set('userId', userId);
  c.set('deviceId', deviceId ?? null);
  return next();
};
