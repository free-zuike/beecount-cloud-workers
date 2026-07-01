/**
 * WebSocket 广播管理器 - 与原版 WSConnectionManager 对齐
 *
 * 跟踪每个用户的所有 WebSocket 连接，提供向单用户广播的能力。
 * 在 Workers 环境中，每个 isolate 独立维护连接列表。
 * 跨 isolate 广播依赖 Durable Object 的 WebSocket API。
 */

type WsConnection = {
  ws: WebSocket;
  userId: string;
  deviceId?: string;
};

class WSConnectionManager {
  private connections = new Map<string, Set<WsConnection>>();

  addConnection(ws: WebSocket, userId: string, deviceId?: string): void {
    const conn: WsConnection = { ws, userId, deviceId };
    if (!this.connections.has(userId)) {
      this.connections.set(userId, new Set());
    }
    this.connections.get(userId)!.add(conn);

    ws.addEventListener('close', () => {
      this.connections.get(userId)?.delete(conn);
      if (this.connections.get(userId)?.size === 0) {
        this.connections.delete(userId);
      }
    });
  }

  async broadcastToUser(userId: string, message: Record<string, unknown>): Promise<void> {
    const conns = this.connections.get(userId);
    if (!conns || conns.size === 0) return;

    const data = JSON.stringify(message);
    const dead: WsConnection[] = [];

    for (const conn of conns) {
      try {
        if (conn.ws.readyState === 1) {
          conn.ws.send(data);
        } else {
          dead.push(conn);
        }
      } catch {
        dead.push(conn);
      }
    }

    for (const conn of dead) {
      conns.delete(conn);
    }
  }

  getOnlineUsers(): string[] {
    return [...this.connections.keys()];
  }
}

// 全局单例
let _instance: WSConnectionManager | null = null;

export function getWsManager(): WSConnectionManager {
  if (!_instance) {
    _instance = new WSConnectionManager();
  }
  return _instance;
}
