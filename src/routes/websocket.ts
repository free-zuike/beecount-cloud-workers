import { Hono } from 'hono';
import { validateAccessToken, base64urlDecode } from '../auth';

type Bindings = {
  JWT_SECRET: string;
  BEECOUNT_DO: DurableObjectNamespace;
  DB: D1Database;
};

const wsRouter = new Hono<{ Bindings: Bindings }>();

wsRouter.get('/', async (c) => {
  const token = c.req.query('token');
  if (!token) {
    return c.json({ error: 'Missing token' }, 400);
  }

  try {
    const validationResult = await validateAccessToken(token, c.env.JWT_SECRET);
    if (!validationResult || !('userId' in validationResult)) {
      return c.json({ error: 'Invalid token' }, 401);
    }

    // 与原版对齐：校验 token type 必须是 access
    const parts = token.split('.');
    if (parts.length === 3) {
      try {
        const payloadStr = base64urlDecode(parts[1]);
        if (payloadStr) {
          const payload = JSON.parse(payloadStr);
          if (payload.type !== 'access') {
            return c.json({ error: 'Invalid token type' }, 401);
          }
          // 与原版对齐：校验 scope
          const scopes: string[] = payload.scopes || [];
          const hasScope = scopes.includes('app:write') || scopes.includes('web:write');
          if (!hasScope) {
            return c.json({ error: 'Insufficient scope' }, 403);
          }
        }
      } catch { /* token 解析失败由 validateAccessToken 处理 */ }
    }

    // 与原版对齐：检查用户是否存在
    const userId = validationResult.userId;
    const db = c.env.DB;
    const user = await db.prepare('SELECT id FROM users WHERE id = ?').bind(userId).first<{ id: string }>();
    if (!user) {
      return c.json({ error: 'User not found' }, 401);
    }

    const upgradeHeader = c.req.header('Upgrade');
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
      return c.json({ error: 'Expected WebSocket upgrade' }, 426);
    }

    // 通过 Durable Object 处理 WebSocket 连接
    const doId = c.env.BEECOUNT_DO.idFromName(`ws-${userId}`);
    const doStub = c.env.BEECOUNT_DO.get(doId);

    // 转发原始请求（保留所有头，包括 Upgrade）
    return doStub.fetch(c.req.raw);
  } catch (error) {
    console.error('[WS] Connection error:', error);
    return c.json({ error: 'WebSocket connection failed' }, 500);
  }
});

export default wsRouter;
