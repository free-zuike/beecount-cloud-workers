import { DurableObject } from 'cloudflare:workers';

interface LogEntry {
  level: string;
  source: string;
  message: string;
  timestamp: string;
}

export class LogBuffer extends DurableObject {
  private buffer: LogEntry[] = [];
  private maxSize = 1000;
  private alarmInterval = 5 * 60 * 1000; // 5 minutes

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/add') {
      const entry = await request.json<LogEntry>();
      this.addLog(entry.level, entry.source, entry.message);
      return new Response('ok');
    }

    if (url.pathname === '/logs') {
      const limit = parseInt(url.searchParams.get('limit') ?? '100');
      const offset = parseInt(url.searchParams.get('offset') ?? '0');
      const level = url.searchParams.get('level') ?? undefined;
      const source = url.searchParams.get('source') ?? undefined;
      const logs = this.getLogs(limit, offset, level, source);
      return Response.json({ logs, total: this.buffer.length });
    }

    if (url.pathname === '/clear') {
      this.clearLogs();
      return new Response('ok');
    }

    if (url.pathname === '/alarm') {
      await this.alarm();
      return new Response('ok');
    }

    return new Response('Not found', { status: 404 });
  }

  async addLog(level: string, source: string, message: string): Promise<void> {
    const entry: LogEntry = {
      level,
      source,
      message,
      timestamp: new Date().toISOString(),
    };

    this.buffer.push(entry);

    // Ring buffer: trim oldest when exceeding max
    if (this.buffer.length > this.maxSize) {
      this.buffer = this.buffer.slice(-this.maxSize);
    }

    // Set alarm if not already set
    const currentAlarm = await this.ctx.storage.getAlarm();
    if (!currentAlarm) {
      await this.ctx.storage.setAlarm(Date.now() + this.alarmInterval);
    }
  }

  getLogs(limit: number, offset: number, level?: string, source?: string): LogEntry[] {
    let filtered = this.buffer;

    if (level) {
      filtered = filtered.filter((l) => l.level === level);
    }
    if (source) {
      filtered = filtered.filter((l) => l.source === source);
    }

    return filtered.slice(offset, offset + limit);
  }

  clearLogs(): void {
    this.buffer = [];
  }

  async alarm(): Promise<void> {
    try {
      // Flush logs to D1 (if any)
      if (this.buffer.length > 0) {
        const db = (this.env as any).DB as D1Database;
        if (db) {
          const userId = this.ctx.id.toString();
          const now = new Date().toISOString();

          // Insert recent logs into audit_logs
          const recentLogs = this.buffer.slice(-100); // Last 100 for D1
          for (const log of recentLogs) {
            try {
              await db.prepare(
                `INSERT INTO audit_logs (user_id, action, details_json, created_at) VALUES (?, ?, ?, ?)`
              )
                .bind(
                  userId,
                  'system_log',
                  JSON.stringify({ level: log.level, source: log.source, message: log.message }),
                  log.timestamp || now
                )
                .run();
            } catch {
              // Silently fail individual log inserts
            }
          }
        }
      }

      // Reset alarm
      await this.ctx.storage.setAlarm(Date.now() + this.alarmInterval);
    } catch (err) {
      console.error('[LogBuffer] Alarm error:', err);
      await this.ctx.storage.setAlarm(Date.now() + this.alarmInterval);
    }
  }
}
