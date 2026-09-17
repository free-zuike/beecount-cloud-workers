import { DurableObject } from 'cloudflare:workers';
import { generateBackupBytes } from '../services/backup-executor';
import { createEncryptedZipStream } from '../lib/zip-lib';
import { createTarGzStream } from '../lib/tar';

type BackupPackEnv = {
  DB: D1Database;
  R2: R2Bucket;
  BEECOUNT_DO: DurableObjectNamespace;
};

/** 运维表清理清单（对齐原版 VACUUM INTO 前清表；保留 backup_runs/backup_run_targets 备份历史） */
const CLEANUP_TABLES = ['sync_push_idempotency', 'audit_logs', 'refresh_tokens', 'mcp_call_logs'];

/**
 * 把 tar.gz 流式上传到 R2。
 * R2 的 put() 只接受已知长度的流（request/response body 或 FixedLengthStream 的 readable half），
 * 裸 ReadableStream 会报 "Provided readable stream must have a known length"。
 * 因此先压一遍数出字节数，再用 FixedLengthStream 包第二遍流式写入；两次压缩同一输入，
 * 输出长度一致，且压缩包从不整包落内存。makeStream 每次调用都新建独立生成流。
 */
async function putTarGzToR2(
  r2: R2Bucket,
  key: string,
  makeStream: () => ReadableStream<Uint8Array>,
  contentType: string,
): Promise<number> {
  let total = 0;
  for await (const chunk of makeStream()) total += chunk.length;
  const fixed = new FixedLengthStream(total);
  const pump = (async () => {
    const writer = fixed.writable.getWriter();
    try {
      for await (const chunk of makeStream()) await writer.write(chunk);
      await writer.close();
    } catch (e) {
      await writer.abort(e instanceof Error ? e : new Error(String(e))).catch(() => {});
    }
  })();
  const obj = await r2.put(key, fixed.readable, { httpMetadata: { contentType } });
  await pump;
  return obj.size;
}

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

  /** 打包备份：读 R2 sqlite（可选）→ 生成 db.json/附件/tar.gz（或 AES zip）→ 写回 R2
   *
   * sqliteR2Key 非空：有 CLOUDFLARE_API_TOKEN → 读取 db.sqlite3 + 清理运维表 +
   *   生成 db.json + 附件 → 打包（与原版互恢复）
   * sqliteR2Key 为 null：无 token → 跳过 sqlite，仅生成 db.json + 附件 → 打包
   *   （TS 版自有格式，仍可正常恢复）
   */
  private async handleBackupPack(request: Request): Promise<Response> {
    try {
      const body = await request.json<{
        sqliteR2Key: string | null;
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

      let sqlite: Uint8Array | null = null;

      // 有 db.sqlite3（用户提供了 CLOUDFLARE_API_TOKEN）→ 加载。
      // 运维表清理已合并进 rewriteSqliteAttachmentPaths（generateBackupBytes 内），
      // 整条打包路径只加载一次 sql.js，避免二次加载的 asm.js 堆把 isolate 顶爆。
      if (body.sqliteR2Key) {
        const obj = await r2.get(body.sqliteR2Key);
        if (!obj) throw new Error(`sqlite temp not found: ${body.sqliteR2Key}`);
        sqlite = new Uint8Array(await obj.arrayBuffer());
        logFn(`loaded sqlite: ${sqlite.length} bytes`);
      } else {
        logFn(`no sqliteR2Key (no CLOUDFLARE_API_TOKEN) — using db.json only`);
      }

      // 生成完整备份条目（含附件）——generateBackupBytes 内部 fetchR2Attachments
      // 会把 R2 key 重映射为原版相对路径（attachments/<user>/<ledger>/<sha>/<id>_<name>
      // + profile-avatars/<user>/avatar_<uuid>.<ext>，头像已按魔数补扩展名），
      // tar 内附件路径与原版完全一致，可直接互恢复。不再用裸 R2 key 命名。
      const generated = await generateBackupBytes(
        db, body.userId, body.ledgerId, r2, logFn,
        { scheduleId: body.scheduleId ?? null, scheduleName: body.scheduleName ?? null },
        sqlite, body.jwtSecret ?? null,
        undefined, CLEANUP_TABLES,
      );
      logFn(`generated entries: ${generated.entries.length} (incl. remapped attachments)`);
      // 内存占用基线（定位超限用）：sqlite 缓冲 + 全部条目（附件/db.json）原始字节
      const entriesBytes = generated.entries.reduce((n, e) => n + e.data.length, 0);
      logFn(`held bytes: sqlite=${sqlite?.length ?? 0}, entries=${entriesBytes}`);

      // 拆分基础条目 vs 附件（附件 entry 名已是原版相对路径）
      const baseEntries = generated.entries;
  const isAttachment = (name: string) =>
    name.startsWith('attachments/') || name.startsWith('profile-avatars/');

  // sqlite 版基础条目：meta.json + db.sqlite3 + .jwt_secret
  const sqliteBase = baseEntries.filter(e =>
    e.name === 'meta.json' || e.name === 'db.sqlite3' || e.name === '.jwt_secret'
  );
  // json 版基础条目：meta.json + db.json + .jwt_secret
  const jsonBase = baseEntries.filter(e =>
    e.name === 'meta.json' || e.name === 'db.json' || e.name === '.jwt_secret'
  );
  const attachmentEntries = baseEntries.filter(e => isAttachment(e.name));
  logFn(`sqlite base ${sqliteBase.length}, json base ${jsonBase.length}, attachments ${attachmentEntries.length}`);

  // 生成器：基础条目 + 原版布局附件（两个文件各自独立可恢复）
  const sqliteGen = async function* (): AsyncGenerator<{ name: string; data: Uint8Array }> {
    for (const e of sqliteBase) yield e;
    for (const e of attachmentEntries) yield e;
  };
  const jsonGen = async function* (): AsyncGenerator<{ name: string; data: Uint8Array }> {
    for (const e of jsonBase) yield e;
    for (const e of attachmentEntries) yield e;
  };

      const baseKey = body.outR2Key;
      const files: { r2Key: string; size: number; encrypted: boolean }[] = [];

      // 有 db.sqlite3 → 生成原版格式文件。tar.gz 真流式写 R2（压缩包不落内存，
      // 附件仍逐个入流）；加密 zip 因 central directory 无法流式，维持单份缓冲。
      if (sqlite) {
        const sqliteKey = baseKey;
        const enc = !!(body.shouldEncrypt && body.password);
        const contentType = enc ? 'application/zip' : 'application/gzip';
        if (enc) {
          const bytes = await createEncryptedZipStream(sqliteGen(), body.password!);
          await r2.put(sqliteKey, bytes, { httpMetadata: { contentType } });
          logFn(`sqlite archive: ${bytes.length} bytes, encrypted=true`);
          files.push({ r2Key: sqliteKey, size: bytes.length, encrypted: true });
        } else {
          const size = await putTarGzToR2(r2, sqliteKey, () => createTarGzStream(sqliteGen()), contentType);
          logFn(`sqlite archive: ${size} bytes (streamed), encrypted=false`);
          files.push({ r2Key: sqliteKey, size, encrypted: false });
        }
      }

      // 生成 json 版独立文件（同上：tar.gz 流式 / 加密 zip 缓冲）
      const jsonKey = baseKey.replace(/\.(tar\.gz|zip)$/, '-json.$1');
      const jsonEnc = !!(body.shouldEncrypt && body.password);
      const jsonContentType = jsonEnc ? 'application/zip' : 'application/gzip';
      if (jsonEnc) {
        const jsonBytes = await createEncryptedZipStream(jsonGen(), body.password!);
        await r2.put(jsonKey, jsonBytes, { httpMetadata: { contentType: jsonContentType } });
        logFn(`json archive: ${jsonBytes.length} bytes, encrypted=true`);
        files.push({ r2Key: jsonKey, size: jsonBytes.length, encrypted: true });
      } else {
        const size = await putTarGzToR2(r2, jsonKey, () => createTarGzStream(jsonGen()), jsonContentType);
        logFn(`json archive: ${size} bytes (streamed), encrypted=false`);
        files.push({ r2Key: jsonKey, size, encrypted: false });
      }

      return Response.json({ ok: true, files, heldBytes: { sqlite: sqlite?.length ?? 0, entries: entriesBytes } });
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
