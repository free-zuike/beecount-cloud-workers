import { Hono } from 'hono';
import { validateAccessToken } from '../auth';

type Bindings = {
  JWT_SECRET: string;
};

const wsRouter = new Hono<{ Bindings: Bindings }>();

const wsConnections = new Map<string, Set<WebSocket>>();

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

    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);

    server.accept();

    if (!wsConnections.has(userId)) {
      wsConnections.set(userId, new Set());
    }
    wsConnections.get(userId)!.add(server);

    server.addEventListener('message', async (event) => {
      try {
        const message = JSON.parse(event.data);
        console.log('[WS] Received message:', message);
        
        const connections = wsConnections.get(userId);
        if (connections) {
          connections.forEach((conn) => {
            if (conn !== server && conn.readyState === WebSocket.OPEN) {
              conn.send(event.data);
            }
          });
        }
      } catch (error) {
        console.error('[WS] Error processing message:', error);
      }
    });

    server.addEventListener('close', () => {
      const connections = wsConnections.get(userId);
      if (connections) {
        connections.delete(server);
        if (connections.size === 0) {
          wsConnections.delete(userId);
        }
      }
    });

    server.addEventListener('error', (error) => {
      console.error('[WS] Error:', error);
    });

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  } catch (error) {
    console.error('[WS] Connection error:', error);
    return c.json({ error: 'WebSocket connection failed' }, 500);
  }
});

export default wsRouter;
