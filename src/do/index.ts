import { DurableObject } from 'cloudflare:workers';
import { generateBackupBytes } from '../services/backup-executor';
import { createEncryptedZip } from '../lib/zip-lib';

type BackupPackEnv = {
  DB: D1Database;
  R2: R2Bucket;
  BEECOUNT_DO: DurableObjectNamespace;
};

/**
 * BeeCount 统一 Durable Object
 *
 * 一个 class，四种用途，通过 instance name 区分：
 * - ws-{userId}   → WebSocket 连接管理
 * - log-{userId}  → 环形日志缓冲
 * - lock-{taskId} → 分布式任务锁
 * - pack-{runId}  → 备份打包（DO 有 30s CPU 预算，绕开免费版 10ms 限制）
 */
export class BeeCountDO extends DurableObject<BackupPackEnv> {
  private buffer: Array<{ id: number; level: string; source: string; message: string; timestamp: string }> = [];
  private maxLogSize = 1000;
  private nextSeq = 0;

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
      this.buffer.push({ id: ++this.nextSeq, level, source, message, timestamp: new Date().toISOString() });
      if (this.buffer.length > this.maxLogSize) this.buffer = this.buffer.slice(-this.maxLogSize);
      return new Response('ok');
    }

    if (path.endsWith('/log/get')) {
      const limit = parseInt(url.searchParams.get('limit') ?? '500');
      const level = url.searchParams.get('level') ?? undefined;
      const source = url.searchParams.get('source') ?? undefined;
      const sinceSeq = parseInt(url.searchParams.get('since_seq') ?? '0', 10);
      let logs = this.buffer;
      if (level && level !== 'ALL') {
        const LEVEL_RANK: Record<string, number> = { DEBUG: 0, INFO: 1, WARNING: 2, ERROR: 3, CRITICAL: 4 };
        const minRank = LEVEL_RANK[level.toUpperCase()] ?? 0;
        logs = logs.filter((l) => (LEVEL_RANK[l.level.toUpperCase()] ?? 1) >= minRank);
      }
      if (source) {
        // 逗号分隔多个 logger 前缀，前缀匹配（对齐原版 /admin/logs 来源过滤）
        const prefixes = source.split(',').map(s => s.trim()).filter(Boolean);
        if (prefixes.length > 0) {
          logs = logs.filter((l) => prefixes.some((p) => l.source.includes(p)));
        }
      }
      if (sinceSeq > 0) logs = logs.filter((l) => l.id > sinceSeq);
      return Response.json({ logs: logs.slice(-limit), total: this.buffer.length });
    }

    if (path.endsWith('/log/clear')) {
      this.buffer = [];
      this.nextSeq = 0;
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

    // ===== 导入会话缓存模式（原版 Python 用内存字典，Worker 用 DO 存储） =====
    if (path.endsWith('/import/save')) {
      const { token, data } = await request.json<{ token: string; data: unknown }>();
      const now = Date.now();
      const entry = { data, createdAt: now, expiresAt: now + 30 * 60 * 1000 };
      await this.ctx.storage.put(`import:${token}`, entry);
      // 30分钟后清理
      await this.ctx.storage.setAlarm(now + 30 * 60 * 1000);
      return Response.json({ ok: true });
    }

    if (path.endsWith('/import/get')) {
      const token = url.searchParams.get('token') || '';
      const entry = await this.ctx.storage.get<{ data: unknown; createdAt: number; expiresAt: number } | null>(`import:${token}`);
      if (!entry) return Response.json({ data: null });
      if (Date.now() > entry.expiresAt) {
        await this.ctx.storage.delete(`import:${token}`);
        return Response.json({ data: null });
      }
      return Response.json({ data: entry.data });
    }

    if (path.endsWith('/import/delete')) {
      const { token } = await request.json<{ token: string }>();
      await this.ctx.storage.delete(`import:${token}`);
      return new Response('ok');
    }

    // ===== 备份打包模式（DO 30s CPU 预算，Workflow 步骤仅有 10ms） =====
    if (path.endsWith('/backup-pack')) {
      return await this.handleBackupPack(request);
    }

    return new Response('Not found', { status: 404 });
  }

  /** 打包备份：读 R2 sqlite → 生成 db.json/附件/tar.gz（或 AES zip）→ 写回 R2 */
  private async handleBackupPack(request: Request): Promise<Response> {
    try {
      const body = await request.json<{
        sqliteR2Key: string;
        outR2Key: string;
        userId: string;
        ledgerId: string;
        runId: number;
        shouldEncrypt: boolean;
        password?: string;
        scheduleId?: number | null;
        scheduleName?: string | null;
        jwtSecret?: string | null;
      }>();
      const db = this.env.DB;
      const r2 = this.env.R2;
      const logFn = (msg: string) => console.log(`[BackupPack] ${msg}`);

      const obj = await r2.get(body.sqliteR2Key);
      if (!obj) throw new Error(`sqlite temp not found: ${body.sqliteR2Key}`);
      const sqlite = new Uint8Array(await obj.arrayBuffer());
      logFn(`loaded sqlite: ${sqlite.length} bytes`);

      const generated = await generateBackupBytes(
        db, body.userId, body.ledgerId, r2, logFn,
        { scheduleId: body.scheduleId ?? null, scheduleName: body.scheduleName ?? null },
        sqlite, body.jwtSecret ?? null,
      );

      let bytes = generated.backupBytes;
      let encrypted = false;
      if (body.shouldEncrypt && body.password) {
        bytes = await createEncryptedZip(generated.entries, body.password);
        encrypted = true;
      }
      logFn(`packed: ${bytes.length} bytes, encrypted=${encrypted}`);

      await r2.put(body.outR2Key, bytes, {
        httpMetadata: { contentType: encrypted ? 'application/zip' : 'application/gzip' },
      });
      return Response.json({ ok: true, size: bytes.length, encrypted });
    } catch (e) {
      console.error('[BackupPack] failed:', e);
      return Response.json({ ok: false, error: (e as Error).message }, { status: 500 });
    }
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
}
