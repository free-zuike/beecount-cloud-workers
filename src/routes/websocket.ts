import { Hono } from 'hono';
import { validateAccessToken } from '../auth';

type Bindings = {
  JWT_SECRET: string;
  BEECOUNT_WS: DurableObjectNamespace;
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

    // Use Durable Object for persistent WebSocket management
    const doId = c.env.BEECOUNT_WS.idFromName(userId);
    const doStub = c.env.BEECOUNT_WS.get(doId);

    // Forward the WebSocket upgrade request to the DO
    const doRequest = new Request(
      new URL('/ws', c.req.url),
      c.req.raw
    );
    const response = await doStub.fetch(doRequest);

    // If the DO returns a WebSocket upgrade response, forward it
    if (response.status === 101) {
      const ws = (response as any).webSocket;
      if (ws) {
        return new Response(null, { status: 101, webSocket: ws });
      }
    }

    return response;
  } catch (error) {
    console.error('[WS] Connection error:', error);
    return c.json({ error: 'WebSocket connection failed' }, 500);
  }
});

export default wsRouter;
