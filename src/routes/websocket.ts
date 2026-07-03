import { Hono } from 'hono';
import { validateAccessToken } from '../auth';

type Bindings = {
  JWT_SECRET: string;
  BEECOUNT_DO: DurableObjectNamespace;
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

    const upgradeHeader = c.req.header('Upgrade');
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
      return c.json({ error: 'Expected WebSocket upgrade' }, 426);
    }

    // 通过 Durable Object 处理 WebSocket 连接
    const userId = validationResult.userId;
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
