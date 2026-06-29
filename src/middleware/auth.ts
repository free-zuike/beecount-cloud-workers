import { Context, Next } from 'hono';
import { validateAccessToken, base64urlDecode } from '../auth';

export const authMiddleware = async (c: any, next: Next, skipPaths: string[] = []) => {
  const requestPath = c.req.path;
  for (const skipPath of skipPaths) {
    if (requestPath === skipPath || requestPath === '/api/v1' + skipPath) {
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
  
  if (!c.env?.JWT_SECRET) {
    console.error('[AUTH] JWT_SECRET is not set');
    return c.json({ error: 'Internal Server Error' }, 500);
  }
  
  const validationResult = await validateAccessToken(token, c.env.JWT_SECRET);
  if (!validationResult) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  if ('expired' in validationResult && validationResult.expired) {
    return c.json({ error: 'TokenExpired' }, 401);
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
