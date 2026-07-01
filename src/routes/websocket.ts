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
      if (validationResult && 'expired' in validationResult && validationResult.expired) {
        return c.json({ error: 'Token expired' }, 401);
      }
      return c.json({ error: 'Invalid token' }, 401);
    }
    const userId = validationResult.userId;

    const upgradeHeader = c.req.header('Upgrade');
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
      return c.json({ error: 'Expected WebSocket upgrade' }, 426);
    }

    // 直接创建 WebSocket pair（绕过 DO，简化实现）
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];

    const wsManager = getWsManager();
    wsManager.addConnection(server, userId, c.req.query('device_id') || undefined);

    server.accept();
    server.send(JSON.stringify({ type: 'connected', userId }));

    return new Response(null, { status: 101, webSocket: client });
  } catch (error) {
    console.error('[WS] Connection error:', error);
    return c.json({ error: 'WebSocket connection failed' }, 500);
  }
});

export default wsRouter;
