import { DurableObject } from 'cloudflare:workers';

/**
 * BeeCount 统一 Durable Object
 *
 * 一个 class，三种用途，通过 instance name 区分：
 * - ws-{userId}   → WebSocket 连接管理
 * - log-{userId}  → 环形日志缓冲
 * - lock-{taskId} → 分布式任务锁
 */
export class BeeCountDO extends DurableObject {
  private buffer: Array<{ level: string; source: string; message: string; timestamp: string }> = [];
  private maxLogSize = 1000;
  private alarmInterval = 5 * 60 * 1000;

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // ===== WebSocket 模式 =====
    if (path.endsWith('/ws')) {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    if (path.endsWith('/broadcast')) {
      const { message } = await request.json<{ message: string }>();
      for (const ws of this.ctx.getWebSockets()) {
        if (ws.readyState === WebSocket.OPEN) ws.send(message);
      }
      return new Response('ok');
    }

    // ===== 日志缓冲模式 =====
    if (path.endsWith('/log/add')) {
      const { level, source, message } = await request.json<{ level: string; source: string; message: string }>();
      this.buffer.push({ level, source, message, timestamp: new Date().toISOString() });
      if (this.buffer.length > this.maxLogSize) this.buffer = this.buffer.slice(-this.maxLogSize);
      if (!(await this.ctx.storage.getAlarm())) {
        await this.ctx.storage.setAlarm(Date.now() + this.alarmInterval);
      }
      return new Response('ok');
    }

    if (path.endsWith('/log/get')) {
      const limit = parseInt(url.searchParams.get('limit') ?? '100');
      const level = url.searchParams.get('level') ?? undefined;
      const source = url.searchParams.get('source') ?? undefined;
      let logs = this.buffer;
      if (level) logs = logs.filter((l) => l.level === level);
      if (source) logs = logs.filter((l) => l.source === source);
      return Response.json({ logs: logs.slice(-limit), total: this.buffer.length });
    }

    if (path.endsWith('/log/clear')) {
      this.buffer = [];
      return new Response('ok');
    }

    // ===== 分布式锁模式 =====
    if (path.endsWith('/lock')) {
      const { holder, ttlMs } = await request.json<{ holder?: string; ttlMs?: number }>();
      const now = Date.now();
      const lock = await this.ctx.storage.get<{ holder: string | null; at: number; ttl: number }>('lock');
      if (!lock || !lock.holder || now - lock.at >= lock.ttl) {
        await this.ctx.storage.put('lock', { holder: holder || 'default', at: now, ttl: ttlMs || 1800000 });
        return Response.json({ acquired: true });
      }
      return Response.json({ acquired: false, holder: lock.holder });
    }

    if (path.endsWith('/unlock')) {
      await this.ctx.storage.put('lock', { holder: null, at: 0, ttl: 0 });
      return new Response('ok');
    }

    return new Response('Not found', { status: 404 });
  }

  // WebSocket 事件
  async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    const msg = typeof data === 'string' ? data : new TextDecoder().decode(data);
    // 广播给所有连接的客户端
    for (const socket of this.ctx.getWebSockets()) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(msg);
      }
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {}

  // Alarm 回调：刷盘到 D1
  async alarm(): Promise<void> {
    try {
      if (this.buffer.length > 0) {
        const db = (this.env as any).DB as D1Database;
        if (db) {
          for (const log of this.buffer.slice(-50)) {
            try {
              await db.prepare(
                'INSERT INTO audit_logs (user_id, action, details_json, created_at) VALUES (?, ?, ?, ?)'
              ).bind(this.ctx.id.toString(), 'system_log',
                JSON.stringify({ level: log.level, source: log.source, message: log.message }),
                log.timestamp).run();
            } catch { /* skip */ }
          }
        }
      }
      await this.ctx.storage.setAlarm(Date.now() + this.alarmInterval);
    } catch {
      await this.ctx.storage.setAlarm(Date.now() + this.alarmInterval);
    }
  }
}
