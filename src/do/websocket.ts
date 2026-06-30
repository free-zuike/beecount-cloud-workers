import { DurableObject } from 'cloudflare:workers';

export class WsSession extends DurableObject {
  private connections: WebSocket[] = [];

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/broadcast') {
      const body = await request.json<{ message: string }>();
      this.broadcast(body.message);
      return new Response('ok');
    }

    if (url.pathname === '/online') {
      return new Response(JSON.stringify({ count: this.connections.length }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.pathname === '/ws') {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);

      this.ctx.acceptWebSocket(server);

      return new Response(null, {
        status: 101,
        webSocket: client,
      });
    }

    return new Response('Not found', { status: 404 });
  }

  async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    const message = typeof data === 'string' ? data : new TextDecoder().decode(data);
    this.broadcast(message, ws);
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    this.connections = this.connections.filter((c) => c !== ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.connections = this.connections.filter((c) => c !== ws);
  }

  private broadcast(message: string, exclude?: WebSocket): void {
    const targets = this.ctx.getWebSockets();
    for (const ws of targets) {
      if (ws !== exclude && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(message);
        } catch {
          // Connection might have been closed
        }
      }
    }
  }

  async getOnlineCount(): Promise<number> {
    return this.ctx.getWebSockets().length;
  }

  async isOnline(): Promise<boolean> {
    return this.ctx.getWebSockets().length > 0;
  }
}
