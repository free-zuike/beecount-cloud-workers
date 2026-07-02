import { Hono } from 'hono';
import { validateAccessToken } from '../auth';
import { getWsManager } from '../lib/ws-manager';

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

    // Workers 无状态模式不支持 WebSocketPair 持久连接
    // APP 会自动回退到 HTTP 轮询（sync/pull），返回 503 让 APP 快速切换
    return c.json({ error: 'WebSocket not supported in stateless mode. Use HTTP polling.' }, 503);
  } catch (error) {
    console.error('[WS] Connection error:', error);
    return c.json({ error: 'WebSocket connection failed' }, 500);
  }
});

export default wsRouter;
