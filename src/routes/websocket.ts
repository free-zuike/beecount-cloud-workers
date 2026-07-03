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

    // 将请求转发给 DO 的 /ws 路径
    const doUrl = new URL(c.req.url);
    doUrl.pathname = '/ws';
    const doReq = new Request(doUrl.toString(), c.req);

    return doStub.fetch(doReq);
  } catch (error) {
    console.error('[WS] Connection error:', error);
    return c.json({ error: 'WebSocket connection failed' }, 500);
  }
});

export default wsRouter;
