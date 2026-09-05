import { Context, Next } from 'hono';
import { validateAccessToken } from '../auth';

export const authMiddleware = async (c: any, next: Next) => {
  const path = c.req.path;
  // auth 路由、MCP 路由、setup 路由和头像下载公开端点自己处理认证，跳过中间件
  // oauth2 回调/token 是公共端点（OAuth 提供商直接回调 / 用户换 token，无法先登录）
  if (path.startsWith('/api/v1/auth') || path.startsWith('/api/v1/mcp') || path.startsWith('/api/v1/setup') || path.startsWith('/api/v1/profile/avatar') || path.includes('/remotes/oauth2/')) {
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
    const user = await (c.env.DB as D1Database).prepare('SELECT id FROM users WHERE id = ?').bind(userId).first<{ id: string }>();
    if (!user) {
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
        .prepare('UPDATE devices SET last_seen_at = ?, last_ip = ? WHERE id = ?')
        .bind(now, clientIp ?? null, deviceId)
        .run()
    );
  }

  c.set('userId', userId);
  c.set('deviceId', deviceId ?? null);
  return next();
};
