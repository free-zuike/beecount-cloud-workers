/**
 * 同步路由模块 - 实现 BeeCount Cloud 核心同步协议
 *
 * 参考原版 BeeCount-Cloud (Python/FastAPI) 的以下端点：
 * - GET  /sync/full      - 全量同步：首次同步或重装时一次性返回账本完整快照
 * - POST /sync/push      - 增量推送：mobile 批量推送本地变更到服务端（LWW 冲突解决）
 * - GET  /sync/pull      - 增量拉取：mobile 按游标拉取服务端变更
 * - GET  /sync/ledgers   - 列出用户可访问的账本元信息
 *
 * 核心概念：
 * - SyncChange: 每次变更的原子记录，包含 entity_type/action/payload_json
 * - LWW (Last-Write-Wins): 用 updated_at + device_id 做冲突解决
 * - projection 表: CQRS 读侧视图，push 同事务刷新（方案 B）
 * - idempotency key: 防止重复 push
 *
 * @module routes/sync
 */

import { Hono } from 'hono';
import { serverLogger } from '../lib/logger';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { insertAuditLog } from '../lib/audit';

const CODE_VERSION = 'v1.3-projection-fix';

// ===========================
// Snapshot Cache（与原版 snapshot_cache 对齐）
// ===========================

interface CacheEntry { snapshot: unknown; changeId: number; ts: number }
const snapshotCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60_000; // 60 秒过期

function snapshotCacheGet(ledgerId: string, changeId: number): unknown | null {
  const entry = snapshotCache.get(ledgerId);
  if (!entry) return null;
  if (entry.changeId !== changeId) { snapshotCache.delete(ledgerId); return null; }
  if (Date.now() - entry.ts > CACHE_TTL_MS) { snapshotCache.delete(ledgerId); return null; }
  return entry.snapshot;
}

function snapshotCachePut(ledgerId: string, changeId: number, snapshot: unknown): void {
  snapshotCache.set(ledgerId, { snapshot, changeId, ts: Date.now() });
  // 防止内存泄漏：超过 100 个 entry 时清一半
  if (snapshotCache.size > 100) {
    const keys = [...snapshotCache.keys()];
    for (let i = 0; i < keys.length / 2; i++) snapshotCache.delete(keys[i]);
  }
}

// ===========================
// 辅助函数
// ===========================

/**
 * 将字符串或 Date 转换为 UTC Date 对象
 * @param dt - 日期字符串或 Date 对象
 * @returns UTC 时区的 Date
 */
function toUtcDate(dt: string | Date): Date {
  const d = typeof dt === 'string' ? new Date(dt) : dt;
  return new Date(d.toISOString());
}

/**
 * 获取当前 UTC 时间
 * @returns ISO 格式 UTC 时间字符串
 */
function nowUtc(): string {
  return new Date().toISOString();
}

/**
 * 序列化为 JSON 字符串（用于 payload_json 存储）
 * @param obj - 任意对象
 * @returns JSON 字符串
 */
function safeJsonStringify(obj: unknown): string {
  return JSON.stringify(obj);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function resolveTagsCsv(db: D1Database, tags: string | null, tagIds: string[] | null): Promise<string | null> {
  if (!tags && !tagIds?.length) return null;
  const parts = (tags ?? '').split(',').map((t) => t.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const nameMap: Record<string, string> = {};
  const uuidParts = parts.filter((p) => UUID_RE.test(p));
  if (uuidParts.length > 0) {
    const rows = await db.prepare(`SELECT sync_id, name FROM read_tag_projection WHERE sync_id IN (${uuidParts.map(() => '?').join(',')})`).bind(...uuidParts).all<{ sync_id: string; name: string }>();
    for (const r of rows.results) nameMap[r.sync_id] = r.name;
  }
  const resolved = parts.map((p) => (UUID_RE.test(p) ? (nameMap[p] ?? p) : p));
  return resolved.length > 0 ? resolved.join(',') : null;
}

const USER_GLOBAL_LEDGER_SENTINEL = '__user_global__';
const USER_GLOBAL_TYPES = ['category', 'account', 'tag', 'exchange_rate_override'];

/** SQLite 用 0/1 存储布尔值，Flutter 期望 bool — 统一转换 */
const BOOL_KEYS = ['enabled', 'exclude_from_stats', 'exclude_from_budget', 'is_default', 'hidden', 'income_is_red'];
function convertBooleans<T extends Record<string, unknown>>(row: T): T {
  for (const k of BOOL_KEYS) {
    if (typeof row[k] === 'number') (row as any)[k] = row[k] === 1;
  }
  return row;
}

function isUserGlobalType(entityType: string): boolean {
  return USER_GLOBAL_TYPES.includes(entityType);
}

/**
 * 将数组拆分成更小的批次
 */
function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

/**
 * 补全 transaction payload 中缺失的 createdByUserId/updatedByUserId
 * 从 read_tx_projection 表查询，与原版 _enrich_tx_payloads_with_user_ids 对齐
 */
async function enrichTxPayloadsWithUserIds(
  db: D1Database,
  rows: Array<{ entity_type: string; ledger_id: string | null; entity_sync_id: string; payload_json: string }>
): Promise<void> {
  // 收集需要补全的 (ledger_id, sync_id) 对
  const pending: Array<{ ledgerId: string; syncId: string; idx: number }> = [];
  for (let idx = 0; idx < rows.length; idx++) {
    const row = rows[idx];
    if (row.entity_type !== 'transaction' || !row.ledger_id) continue;
    let payload: Record<string, unknown>;
    try { payload = JSON.parse(row.payload_json); } catch { continue; }
    if (payload.createdByUserId && payload.updatedByUserId) continue;
    pending.push({ ledgerId: row.ledger_id, syncId: row.entity_sync_id, idx });
  }
  if (pending.length === 0) return;

  // 批量查询 projection（含 last_edited_by_user_id）
  const syncIds = [...new Set(pending.map(p => p.syncId))];
  const ledgerIds = [...new Set(pending.map(p => p.ledgerId))];
  const placeholdersSid = syncIds.map(() => '?').join(',');
  const placeholdersLid = ledgerIds.map(() => '?').join(',');
  const projRows = await db.prepare(
    `SELECT ledger_id, sync_id, created_by_user_id, last_edited_by_user_id FROM read_tx_projection
     WHERE sync_id IN (${placeholdersSid}) AND ledger_id IN (${placeholdersLid})`
  ).bind(...syncIds, ...ledgerIds)
    .all<{ ledger_id: string; sync_id: string; created_by_user_id: string | null; last_edited_by_user_id: string | null }>();

  const projMap = new Map<string, { cb: string | null; eb: string | null }>();
  for (const r of projRows.results) {
    projMap.set(`${r.ledger_id}:${r.sync_id}`, { cb: r.created_by_user_id, eb: r.last_edited_by_user_id });
  }

  // 补全 payload
  for (const { ledgerId, syncId, idx } of pending) {
    const entry = projMap.get(`${ledgerId}:${syncId}`);
    if (!entry) continue;
    try {
      const payload = JSON.parse(rows[idx].payload_json);
      if (!payload.createdByUserId && entry.cb) payload.createdByUserId = entry.cb;
      if (!payload.updatedByUserId) payload.updatedByUserId = entry.eb || entry.cb;
      rows[idx] = { ...rows[idx], payload_json: JSON.stringify(payload) };
    } catch { /* skip */ }
  }
}

// ===========================
// Schema 定义
// ===========================

const SyncPushRequestSchema = z.object({
  device_id: z.string(),
  changes: z.array(
    z.object({
      ledger_id: z.string().optional().nullable(),
      entity_type: z.string(),
      entity_sync_id: z.string(),
      action: z.enum(['upsert', 'delete']),
      payload: z.any().nullable().optional().default({}),
      updated_at: z.string().or(z.date()),
    })
  ),
});

type SyncPushResponse = {
  accepted: number;
  rejected: number;
  conflict_count: number;
  conflict_samples: Array<Record<string, unknown>>;
  server_cursor: number;
  server_timestamp: string;
  projection_errors?: Array<{ change_id: number; entity_type: string; entity_sync_id: string; error: string }>;
};

// ===========================
// 类型定义
// ===========================

type Bindings = {
  DB: D1Database;
  JWT_SECRET: string;
  BEECOUNT_DO: DurableObjectNamespace;
  R2?: R2Bucket;
  NODE_ENV?: string;
};

type Variables = {
  userId: string;
};

// ===========================
// 路由定义
// ===========================

const syncRouter = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// ---------------------------------------------------------------------------
// POST /sync/push - 增量推送：客户端推送变更到服务端
// ---------------------------------------------------------------------------

syncRouter.post('/push', zValidator('json', SyncPushRequestSchema), async (c) => {
  serverLogger.info('src.routers.sync', `[SYNC] ===== ${CODE_VERSION} START =====`);
  const userId = c.get('userId');
  const db = c.env.DB;
  try {
    serverLogger.info('src.routers.sync', '[SYNC] /sync/push started');
    serverLogger.info('src.routers.sync', '[SYNC] userId:', userId);
    const req = c.req.valid('json');
    const entityCounts: Record<string, number> = {};
    for (const ch of (req.changes || [])) {
      entityCounts[ch.entity_type] = (entityCounts[ch.entity_type] || 0) + 1;
    }
    serverLogger.info('src.routers.sync', '[SYNC] changes count:', req.changes?.length, 'by_type:', JSON.stringify(entityCounts));
    
    // 调试：打印第一条变更的字段名
    if (req.changes && req.changes.length > 0) {
      const first = req.changes[0];
      serverLogger.info('src.routers.sync', '[SYNC] first change keys:', Object.keys(first));
      serverLogger.info('src.routers.sync', '[SYNC] first change payload type:', typeof first.payload, 'is_null:', first.payload === null);
      serverLogger.info('src.routers.sync', '[SYNC] first change entity_sync_id:', first.entity_sync_id, 'type:', typeof first.entity_sync_id);
      serverLogger.info('src.routers.sync', '[SYNC] first change action:', first.action, 'type:', typeof first.action);
      serverLogger.info('src.routers.sync', '[SYNC] first change ledger_id:', first.ledger_id, 'type:', typeof first.ledger_id);
    }
    
    const serverNow = nowUtc();

    // 处理 device_id - 如果未提供，尝试从 header 获取或使用默认值
    const deviceId = req.device_id || c.req.header('X-Device-ID') || 'unknown';
    serverLogger.info('src.routers.sync', '[SYNC] deviceId:', deviceId);

    // 验证设备有效性（设备必须属于当前用户且未被撤销）
    const device = await db
      .prepare(
        `SELECT id FROM devices
         WHERE id = ? AND user_id = ? AND revoked_at IS NULL`
      )
      .bind(deviceId, userId)
      .first();

    serverLogger.info('src.routers.sync', '[SYNC] device check result:', device);

    if (!device) {
      return c.json({ error: 'Invalid device' }, 401);
    }

    // 更新设备最后活跃时间
    await db
      .prepare(
        `UPDATE devices SET last_seen_at = ?, last_ip = ?
         WHERE id = ?`
      )
      .bind(serverNow, c.req.header('CF-Connecting-IP') ?? null, deviceId)
      .run();

    let accepted = 0;
    let rejected = 0;
    let conflictCount = 0;
    const conflictSamples: Array<Record<string, unknown>> = [];
    let maxCursor = 0;
    const touchedLedgers: Record<string, string> = {};
    let touchedUserGlobal = false;
    const pendingSharedResourceEvents: Array<Record<string, unknown>> = [];
    const projectionErrors: Array<{ change_id: number; entity_type: string; entity_sync_id: string; error: string }> = [];

    const changes = req.changes;
    
    // 空变更快速返回
    if (changes.length === 0) {
      const maxRow = await db
        .prepare(`SELECT MAX(change_id) as max_id FROM sync_changes WHERE user_id = ?`)
        .bind(userId)
        .first<{ max_id: number | null }>();
      maxCursor = maxRow?.max_id ?? 0;
      
      return c.json({
        accepted: 0,
        rejected: 0,
        conflict_count: 0,
        conflict_samples: [],
        server_cursor: maxCursor,
        server_timestamp: serverNow,
      });
    }


    // ====================== 优化1：批量预加载账本 ======================
    const ledgerExternalIds = [...new Set(changes.filter(c => c.ledger_id).map(c => c.ledger_id as string))];
    serverLogger.info('src.routers.sync', '[SYNC] ledgerExternalIds:', ledgerExternalIds);
    const ledgerMap: Record<string, { id: string; user_id: string; external_id: string }> = {};
    
    if (ledgerExternalIds.length > 0) {
      const ledgerPlaceholders = ledgerExternalIds.map(() => '?').join(',');
      serverLogger.info('src.routers.sync', '[SYNC] Querying ledgers with placeholders:', ledgerPlaceholders);
      const existingLedgers = await db
        .prepare(
          `SELECT l.id, l.user_id, l.external_id FROM ledgers l
           JOIN ledger_members lm ON l.id = lm.ledger_id
           WHERE lm.user_id = ? AND l.external_id IN (${ledgerPlaceholders})`
        )
        .bind(userId, ...ledgerExternalIds)
        .all<{ id: string; user_id: string; external_id: string }>();
      
      serverLogger.info('src.routers.sync', '[SYNC] existingLedgers found:', existingLedgers.results.length);
      for (const ledger of existingLedgers.results) {
        ledgerMap[ledger.external_id] = ledger;
      }
      
      // 创建不存在的账本（批量）
      for (const externalId of ledgerExternalIds) {
        if (!ledgerMap[externalId]) {
          const existing = await db.prepare('SELECT id, user_id FROM ledgers WHERE user_id = ? AND external_id = ?').bind(userId, externalId).first<{ id: string; user_id: string }>();
          if (existing) {
            ledgerMap[externalId] = { id: existing.id, user_id: existing.user_id, external_id: externalId };
            continue;
          }
          // 从 sync changes 中查找账本名称（如果本次 push 包含 ledger upsert）
          let ledgerName: string | null = null;
          const ledgerChange = changes.find(c => c.ledger_id === externalId && (c.entity_type === 'ledger' || c.entity_type === 'ledger_snapshot') && c.action === 'upsert');
          if (ledgerChange?.payload) {
            const p = ledgerChange.payload as Record<string, unknown>;
            ledgerName = (p.ledgerName ?? p.ledger_name ?? p.name ?? null) as string | null;
          }
          // 对齐原版 Python：name 可为 NULL，后续 ledger upsert 会更新
          serverLogger.info('src.routers.sync', '[SYNC] Creating new ledger:', externalId, 'name:', ledgerName);
          const newLedgerId = randomUUID();
          await db
            .prepare(
              `INSERT INTO ledgers (id, user_id, external_id, name, currency, created_at)
               VALUES (?, ?, ?, ?, 'CNY', ?)`
            )
            .bind(newLedgerId, userId, externalId, ledgerName, serverNow)
            .run();
          // 与原版对齐：自动创建 owner 成员记录
          await db
            .prepare(
              `INSERT INTO ledger_members (ledger_id, user_id, role, joined_at)
               VALUES (?, ?, 'owner', ?)`
            )
            .bind(newLedgerId, userId, serverNow)
            .run();
          ledgerMap[externalId] = { id: newLedgerId, user_id: userId, external_id: externalId };
        }
      }
    }
    serverLogger.info('src.routers.sync', '[SYNC] ledgerMap keys:', Object.keys(ledgerMap));

    // ====================== 优化2：批量获取现有变更（分更小的批次） ======================
    const existingChangeMap = new Map<string, { change_id: number; updated_at: string; updated_by_device_id: string | null }>();
    
    if (changes.length > 0) {
      // 准备有效的变更查询参数
      const validChangeEntries = changes
        .map(c => ({
          ledgerId: c.ledger_id ? ledgerMap[c.ledger_id]?.id : undefined,
          entity_type: c.entity_type,
          entity_sync_id: c.entity_sync_id,
        }))
        .filter(c => c.ledgerId !== undefined && c.entity_sync_id) as Array<{
          ledgerId: string;
          entity_type: string;
          entity_sync_id: string;
        }>;

      // 分成更小的批次（每批 30 个，每批 90 个变量，远低于 SQLite 限制）
      const batches = chunkArray(validChangeEntries, 30);
      serverLogger.info('src.routers.sync', '[SYNC] Split valid entries into', batches.length, 'batches');

      for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
        const batch = batches[batchIdx];
        if (batch.length === 0) continue;

        let query = `SELECT ledger_id, entity_type, entity_sync_id, change_id, updated_at, updated_by_device_id FROM sync_changes WHERE (`;
        const params: (string | number)[] = [];
        
        for (let i = 0; i < batch.length; i++) {
          if (i > 0) query += ' OR ';
          const entry = batch[i];
          query += `(ledger_id = ? AND entity_type = ? AND entity_sync_id = ?)`;
          params.push(entry.ledgerId, entry.entity_type, entry.entity_sync_id);
        }
        query += ')';
        
        serverLogger.info('src.routers.sync', '[SYNC] Querying batch', batchIdx + 1, '/', batches.length, 'with', params.length, 'params');
        const existingChanges = await db
          .prepare(query)
          .bind(...params)
          .all<{ ledger_id: string; entity_type: string; entity_sync_id: string; change_id: number; updated_at: string; updated_by_device_id: string | null }>();
        
        serverLogger.info('src.routers.sync', '[SYNC] Batch', batchIdx + 1, 'found', existingChanges.results.length, 'changes');
        for (const change of existingChanges.results) {
          const key = `${change.ledger_id}:${change.entity_type}:${change.entity_sync_id}`;
          existingChangeMap.set(key, change);
        }
      }
    }
    serverLogger.info('src.routers.sync', '[SYNC] existingChangeMap size:', existingChangeMap.size);

    // 补充查询 user-global 变更（category/account/tag 不依附 ledger）
    const USER_GLOBAL_LEDGER_SENTINEL = '__user_global__';
const USER_GLOBAL_TYPES = ['category', 'account', 'tag', 'exchange_rate_override'];
    const userGlobalEntries = changes
      .filter(c => USER_GLOBAL_TYPES.includes(c.entity_type) && !c.ledger_id)
      .map(c => ({ entity_type: c.entity_type, entity_sync_id: c.entity_sync_id }));

    for (let i = 0; i < userGlobalEntries.length; i += 30) {
      const batch = userGlobalEntries.slice(i, i + 30);
      if (batch.length === 0) continue;
      let q = `SELECT entity_type, entity_sync_id, change_id, updated_at, updated_by_device_id FROM sync_changes WHERE scope = 'user' AND user_id = ? AND (`;
      const p: (string | number)[] = [userId];
      for (let j = 0; j < batch.length; j++) {
        if (j > 0) q += ' OR ';
        q += `(entity_type = ? AND entity_sync_id = ?)`;
        p.push(batch[j].entity_type, batch[j].entity_sync_id);
      }
      q += ')';
      const rows = await db.prepare(q).bind(...p).all<{ entity_type: string; entity_sync_id: string; change_id: number; updated_at: string; updated_by_device_id: string | null }>();
      for (const r of rows.results) {
        const key = `user:${userId}:${r.entity_type}:${r.entity_sync_id}`;
        existingChangeMap.set(key, r);
      }
    }
    serverLogger.info('src.routers.sync', '[SYNC] existingChangeMap size after user-global:', existingChangeMap.size);

    // ====================== 优化3：批量写入变更（分小批次避免 CPU 超时） ======================
    const conflictList: typeof conflictSamples = [];
    const BATCH_INSERT_SIZE = 10; // 每批处理 10 个插入，控制 D1 调用次数

    // 批量预加载 member role（避免每条变更都查一次 ledger_members）
    const memberRoleMap = new Map<string, string>();
    const uniqueLedgerIds = [...new Set(changes.filter(c => c.ledger_id).map(c => ledgerMap[c.ledger_id as string]?.id).filter(Boolean))];
    if (uniqueLedgerIds.length > 0) {
      const placeholders = uniqueLedgerIds.map(() => '?').join(',');
      const memberRows = await db.prepare(
        `SELECT ledger_id, role FROM ledger_members WHERE user_id = ? AND ledger_id IN (${placeholders})`
      ).bind(userId, ...uniqueLedgerIds).all<{ ledger_id: string; role: string }>();
      for (const r of memberRows.results) {
        memberRoleMap.set(r.ledger_id, r.role);
      }
    }

    const processedChanges: Array<{
      change: typeof changes[0];
      ledgerRow: typeof ledgerMap[string] | null;
      newChangeId: number;
    }> = [];

    // 全量预载 user-global 投影已有的行（一次查询替代每批多次 SELECT，大幅减少 D1 调用数）
    const userGlobalChanges = changes.filter(c => USER_GLOBAL_TYPES.includes(c.entity_type) && !c.ledger_id);
    const userGlobalPreloaded = await preloadUserGlobalProjections(db, userId, userGlobalChanges.map(c => ({ entity_type: c.entity_type, entity_sync_id: c.entity_sync_id })));

    // 冲突审计日志收集器：批量执行替代逐条 INSERT，避免超 api_limit
    const conflictAuditStmts: any[] = [];

    for (let startIdx = 0; startIdx < changes.length; startIdx += BATCH_INSERT_SIZE) {
      const batchChanges = changes.slice(startIdx, startIdx + BATCH_INSERT_SIZE);
      serverLogger.info('src.routers.sync', '[SYNC] Processing insertion batch', Math.floor(startIdx / BATCH_INSERT_SIZE) + 1, 'with', batchChanges.length, 'changes');
      
      // 打印前3条变更的详情（调试用）
      if (startIdx === 0) {
        for (const ch of batchChanges.slice(0, 3)) {
          serverLogger.info('src.routers.sync', '[SYNC] sample change:', JSON.stringify({
            entity_type: ch.entity_type,
            ledger_id: ch.ledger_id,
            entity_sync_id: ch.entity_sync_id,
            action: ch.action,
            updated_at: ch.updated_at,
          }));
        }
      }
      
      const insertPromises: Array<{
        stmt: any;
        change: typeof changes[0];
        ledgerRow: typeof ledgerMap[string] | null;
        lwwKey: string;
        lwwTs: string;
        lwwDevice: string;
      }> = [];

      for (const change of batchChanges) {
        // 对齐原版：附件不写 sync_changes（App 不识别 attachment 实体类型，
        // 附件信息通过交易 payload 的 attachments 字段同步）
        if (change.entity_type === 'attachment') {
          continue;
        }
        // user-global 实体：category/account/tag 可以不依附 ledger
        const USER_GLOBAL_LEDGER_SENTINEL = '__user_global__';
const USER_GLOBAL_TYPES = ['category', 'account', 'tag', 'exchange_rate_override'];
        const isUserGlobal = USER_GLOBAL_TYPES.includes(change.entity_type) && !change.ledger_id;

        const changeUpdatedAt = toUtcDate(change.updated_at);
        const maxAllowed = new Date(new Date(serverNow).getTime() + 5000);
        const clampedUpdatedAt = changeUpdatedAt > maxAllowed ? maxAllowed : changeUpdatedAt;

        let key: string;
        let scope = 'ledger';
        let ledgerRowId: string | null = null;

        if (isUserGlobal) {
          // user-global LWW key: (user_id, scope='user', entity_type, entity_sync_id)
          key = `user:${userId}:${change.entity_type}:${change.entity_sync_id}`;
          scope = 'user';
        } else {
          const ledgerRow = ledgerMap[change.ledger_id as string];
          if (!ledgerRow) {
            serverLogger.info('src.routers.sync', '[SYNC] SKIPPED - ledger not found for', change.entity_type, 'ledger_id:', change.ledger_id);
            continue;
          }
          // Editor 只能推 transaction/budget；ledger/ledger_snapshot 只有 owner 能推（与原版对齐）
          const callerRole = memberRoleMap.get(ledgerRow.id) ?? (ledgerRow.user_id === userId ? 'owner' : null);
          if (callerRole !== 'owner' && (change.entity_type === 'ledger' || change.entity_type === 'ledger_snapshot')) {
            rejected++;
            continue;
          }
          ledgerRowId = ledgerRow.id;
          key = `${ledgerRow.id}:${change.entity_type}:${change.entity_sync_id}`;
        }

        const latestChange = existingChangeMap.get(key);

        const incomingTuple = { ts: clampedUpdatedAt.getTime(), deviceId };
        let existingTuple: { ts: number; deviceId: string; changeId: number } | null = null;

        if (latestChange) {
          existingTuple = {
            ts: new Date(latestChange.updated_at).getTime(),
            deviceId: latestChange.updated_by_device_id ?? '',
            changeId: latestChange.change_id,
          };
        }

        // 已有变更且更新更新 → 冲突拒绝
        if (existingTuple && existingTuple.ts > incomingTuple.ts) {
          rejected++;
          conflictCount++;
          serverLogger.info('src.routers.sync', '[SYNC] REJECTED - older change:', change.entity_type, change.entity_sync_id, 'server_ts:', existingTuple.ts, 'incoming_ts:', incomingTuple.ts);
          const conflictSample = {
            reason: 'lww_rejected_older_change',
            ledgerId: change.ledger_id,
            entityType: change.entity_type,
            entitySyncId: change.entity_sync_id,
            existingChangeId: existingTuple.changeId,
          };
          if (conflictList.length < 20) {
            conflictList.push(conflictSample);
          }
          // 原版对齐：冲突写审计日志（收集到 batch 数组，避免逐条 INSERT 超 api_limit）
          const auditDetails = {
            ...conflictSample,
            incomingUpdatedAt: clampedUpdatedAt.toISOString(),
            existingUpdatedAt: new Date(existingTuple.ts).toISOString(),
            incomingDeviceId: deviceId,
            existingDeviceId: existingTuple.deviceId,
          };
          conflictAuditStmts.push(
            db.prepare(
              `INSERT INTO audit_logs (user_id, ledger_id, action, entity_type, entity_id, details_json, level, logger)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
            ).bind(
              userId, isUserGlobal ? null : (ledgerRowId ?? null),
              'sync_push', 'sync_conflict', null,
              safeJsonStringify(auditDetails), 'INFO', null,
            ),
          );
          continue;
        }

        // 时间戳相同时按 device_id 字典序裁决（与原版 tuple 排序对齐）
        if (existingTuple && existingTuple.ts === incomingTuple.ts) {
          const incomingDid = deviceId ?? '';
          const existingDid = existingTuple.deviceId ?? '';
          if (existingDid > incomingDid) {
            // 服务端设备赢 → 拒绝
            rejected++;
            conflictCount++;
            continue;
          }
          if (existingDid === incomingDid) {
            // 幂等重放 → 接受
            accepted++;
            continue;
          }
          // incomingDid > existingDid → 落入下方接受逻辑
        }
        if (existingTuple && existingTuple.ts === incomingTuple.ts && existingTuple.deviceId === incomingTuple.deviceId) {
          accepted++;
          continue;
        }

        // 注入 createdByUserId / updatedByUserId（与原版 §7 对齐）
        let payloadForStorage = change.payload;
        if (change.entity_type === 'transaction' && typeof payloadForStorage === 'object' && payloadForStorage !== null) {
          const p = { ...payloadForStorage } as Record<string, unknown>;
          if (!p.updatedByUserId) p.updatedByUserId = userId;
          if (!p.createdByUserId) {
            const existing = await db.prepare('SELECT created_by_user_id FROM read_tx_projection WHERE ledger_id = ? AND sync_id = ?')
              .bind(ledgerRowId || '', change.entity_sync_id).first<{ created_by_user_id: string | null }>();
            p.createdByUserId = existing?.created_by_user_id || userId;
          }
          payloadForStorage = p;
        }

        const ledgerRowRef = isUserGlobal ? null : { id: ledgerRowId as string, external_id: '' };

        // 添加到批量插入 — ledger-scoped 使用 ledger owner 的 user_id（与原版对齐）
        const changeUserId = isUserGlobal ? userId : (ledgerMap[change.ledger_id as string]?.user_id ?? userId);
        const bindParams = [
            changeUserId,
            isUserGlobal ? null : (ledgerRowId ?? null),
            change.entity_type ?? '',
            change.entity_sync_id ?? '',
            change.action ?? 'upsert',
            safeJsonStringify(payloadForStorage ?? {}),
            clampedUpdatedAt.toISOString(),
            deviceId ?? null,
            userId,
            scope ?? 'ledger',
        ];
        // 检查是否有 undefined 值
        for (let i = 0; i < bindParams.length; i++) {
          if (bindParams[i] === undefined) {
            serverLogger.error('src.routers.sync', '[SYNC] UNDEFINED at bind index', i, 'for change:', change.entity_type, change.entity_sync_id);
          }
        }
        insertPromises.push({
          stmt: db.prepare(
            `INSERT INTO sync_changes
             (user_id, ledger_id, entity_type, entity_sync_id, action, payload_json, updated_at, updated_by_device_id, updated_by_user_id, scope)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).bind(...bindParams),
          change,
          ledgerRow: isUserGlobal ? null : { id: ledgerRowId as string, user_id: userId, external_id: '' },
          lwwKey: key,
          lwwTs: clampedUpdatedAt.toISOString(),
          lwwDevice: deviceId ?? null,
        });

        if (!isUserGlobal && ledgerRowId) {
          touchedLedgers[ledgerMap[change.ledger_id as string]?.external_id ?? (change.ledger_id as string)] = ledgerRowId;
        }

        // 追踪 user-global 变更（与原版对齐：push 后广播 __user_global__ 通道）
        if (isUserGlobal) {
          touchedUserGlobal = true;
          // 共享账本 fan-out：仅对 category/account/tag 推 shared_resource_change（与原版对齐）
          if (['category', 'account', 'tag'].includes(change.entity_type)) {
            pendingSharedResourceEvents.push({
              resource_type: change.entity_type,
              action: change.action,
              sync_id: change.entity_sync_id,
              payload: change.payload || { sync_id: change.entity_sync_id },
            });
          }
        }
      }

      // 执行这一批次的插入（分块 db.batch：一次批量 = 1 次 D1 API 请求，
      // 大幅减少 API 调用数，避免超 Worker api_limit 上限）
      if (insertPromises.length > 0) {
        const stmts = insertPromises.map(p => p.stmt);
        const allResults: { meta: { last_row_id: number } }[] = [];
        for (let i = 0; i < stmts.length; i += 100) {
          const chunk = stmts.slice(i, i + 100);
          const res = await db.batch(chunk);
          allResults.push(...res);
        }
        accepted += allResults.length;
        
        // 记录处理的变更以便后续应用投影
        for (let i = 0; i < insertPromises.length; i++) {
          const { change, ledgerRow, lwwKey, lwwTs, lwwDevice } = insertPromises[i];
          const changeId = allResults[i].meta.last_row_id as number;
          maxCursor = Math.max(maxCursor, changeId);
          processedChanges.push({ change, ledgerRow, newChangeId: changeId });
          // 更新冲突 map：同批内后续重复实体按幂等跳过（对齐原版 flush 语义）
          if (lwwKey) {
            existingChangeMap.set(lwwKey, { change_id: changeId, updated_at: lwwTs, updated_by_device_id: lwwDevice });
          }
        }

        // 立即应用这一批次的投影更新（收集写入语句后分块 db.batch 执行，减少 D1 调用数）
        const batchCollector: any[] = [];
        for (const { change, ledgerRow, newChangeId } of processedChanges) {
          if (isUserGlobalType(change.entity_type)) {
              await applyUserChangeToProjection(db, userId, {
                change_id: newChangeId,
                entity_type: change.entity_type,
                entity_sync_id: change.entity_sync_id,
                action: change.action,
                payload: change.payload,
              }, c.env.R2, userGlobalPreloaded.get(change.entity_type)?.get(change.entity_sync_id), batchCollector);
            } else if (ledgerRow) {
              await applyChangeToProjection(db, ledgerRow.id, userId, {
                change_id: newChangeId,
                entity_type: change.entity_type,
                entity_sync_id: change.entity_sync_id,
                action: change.action,
                payload: change.payload,
                ledger_id: ledgerRow.id,
              }, c.env.R2);
            }
        }
        // 批量执行投影写入语句（100 条/批，1 批 = 1 次 D1 API 请求）
        for (let i = 0; i < batchCollector.length; i += 100) {
          await db.batch(batchCollector.slice(i, i + 100));
        }
        // 批量执行冲突审计 INSERT（100 条/批，避免逐条 INSERT 超 api_limit）
        for (let i = 0; i < conflictAuditStmts.length; i += 100) {
          await db.batch(conflictAuditStmts.slice(i, i + 100));
        }
        conflictAuditStmts.length = 0;
        processedChanges.length = 0; // 清空已处理的列表
      }
    }

    // 合并冲突样本
    conflictSamples.push(...conflictList);

    // 如果没有任何变更被接受，计算最大游标
    if (maxCursor === 0) {
      const maxRow = await db
        .prepare(`SELECT MAX(change_id) as max_id FROM sync_changes WHERE user_id = ?`)
        .bind(userId)
        .first<{ max_id: number | null }>();
      maxCursor = maxRow?.max_id ?? 0;
    }

    const response: SyncPushResponse = {
      accepted,
      rejected,
      conflict_count: conflictCount,
      conflict_samples: conflictSamples,
      server_cursor: maxCursor,
      server_timestamp: serverNow,
      projection_errors: projectionErrors.length > 0 ? projectionErrors : undefined,
    };

    serverLogger.info('src.routers.sync', '[SYNC] /sync/push result - accepted:', accepted, 'rejected:', rejected, 'conflicts:', conflictCount, 'server_cursor:', maxCursor, 'projection_errors:', projectionErrors.length);
    serverLogger.info('src.routers.sync', `[SYNC] ===== ${CODE_VERSION} SUCCESS =====`);

    // 统计最终状态
    const totalChanges = await db.prepare('SELECT COUNT(*) as cnt FROM sync_changes WHERE user_id = ?').bind(userId).first<{ cnt: number }>();
    const categoryCount = await db.prepare("SELECT COUNT(*) as cnt FROM sync_changes WHERE user_id = ? AND entity_type = 'category'").bind(userId).first<{ cnt: number }>();
    serverLogger.info('src.routers.sync', '[SYNC] DB totals - all_changes:', totalChanges?.cnt, 'categories:', categoryCount?.cnt);

    await insertAuditLog({
      db, userId, action: 'sync_push', entityType: 'sync',
      details: { accepted, rejected, conflict_count: conflictCount, device_id: deviceId },
    });

    // WS 广播给所有受影响账本的成员（通过 Durable Object）
    if (Object.keys(touchedLedgers).length > 0) {
      try {
        const { getWsManager } = await import('../lib/ws-manager');
        for (const [extId, internalId] of Object.entries(touchedLedgers)) {
          const members = await db.prepare('SELECT user_id FROM ledger_members WHERE ledger_id = ?')
            .bind(internalId).all<{ user_id: string }>();
          const memberIds = new Set([userId, ...members.results.map(m => m.user_id)]);
          for (const uid of memberIds) {
            try {
              const doId = c.env.BEECOUNT_DO.idFromName(`ws-${uid}`);
              const doStub = c.env.BEECOUNT_DO.get(doId);
              await doStub.fetch(new Request(`https://dummy/broadcast`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  message: JSON.stringify({
                    type: 'sync_change',
                    ledgerId: extId,
                    serverCursor: maxCursor,
                    serverTimestamp: serverNow,
                  }),
                }),
              }));
            } catch {}
          }
        }
      } catch (e) {
        serverLogger.info('src.routers.sync', '[SYNC] DO broadcast failed (non-fatal):', e);
      }
    }

    // 广播给所有受影响账本的成员（与原版 broadcast_to_ledger 对齐）
    if (Object.keys(touchedLedgers).length > 0) {
      try {
        const { getWsManager } = await import('../lib/ws-manager');
        for (const [extId, internalId] of Object.entries(touchedLedgers)) {
          const members = await db.prepare('SELECT user_id FROM ledger_members WHERE ledger_id = ?')
            .bind(internalId).all<{ user_id: string }>();
          const memberIds = new Set([userId, ...members.results.map(m => m.user_id)]);
          for (const uid of memberIds) {
            await getWsManager().broadcastToUser(uid, {
              type: 'sync_change',
              ledgerId: extId,
              serverCursor: maxCursor,
              serverTimestamp: serverNow,
            });
          }
        }
      } catch {}
    }

    // 与原版对齐：user-global 变更广播 __user_global__ 通道
    if (touchedUserGlobal) {
      const userGlobalPayload = {
        type: 'sync_change',
        ledgerId: '__user_global__',
        serverCursor: maxCursor,
        serverTimestamp: serverNow,
      };
      try {
        const doId = c.env.BEECOUNT_DO.idFromName(`ws-${userId}`);
        const doStub = c.env.BEECOUNT_DO.get(doId);
        await doStub.fetch(new Request(`https://dummy/broadcast`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: JSON.stringify(userGlobalPayload) }),
        }));
      } catch {}
      try {
        const { getWsManager } = await import('../lib/ws-manager');
        await getWsManager().broadcastToUser(userId, userGlobalPayload);
      } catch {}
    }

    // 与原版对齐：共享账本 fan-out — 对 caller 作为 owner 的所有共享账本，
    // 推 shared_resource_change 给非 owner member
    if (pendingSharedResourceEvents.length > 0) {
      try {
        // 查找 caller 作为 owner 且有多个 member 的共享账本
        const sharedLedgers = await db.prepare(
          `SELECT l.id, l.external_id
           FROM ledgers l
           JOIN ledger_members lm ON lm.ledger_id = l.id
           WHERE l.user_id = ?
           GROUP BY l.id, l.external_id
           HAVING COUNT(lm.user_id) > 1`
        ).bind(userId).all<{ id: string; external_id: string }>();

        for (const sl of sharedLedgers.results) {
          // 查找该账本的所有 member
          const members = await db.prepare(
            `SELECT user_id, role FROM ledger_members WHERE ledger_id = ?`
          ).bind(sl.id).all<{ user_id: string; role: string }>();

          for (const member of members.results) {
            if (member.role === 'owner') continue;
            // 给每个非 owner member 广播 shared_resource_change
            for (const ev of pendingSharedResourceEvents) {
              const msg = {
                type: 'shared_resource_change',
                ledgerId: sl.external_id,
                resourceType: ev.resource_type,
                action: ev.action,
                payload: ev.payload,
              };
              try {
                const doId = c.env.BEECOUNT_DO.idFromName(`ws-${member.user_id}`);
                const doStub = c.env.BEECOUNT_DO.get(doId);
                await doStub.fetch(new Request(`https://dummy/broadcast`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ message: JSON.stringify(msg) }),
                }));
              } catch {}
              try {
                const { getWsManager } = await import('../lib/ws-manager');
                await getWsManager().broadcastToUser(member.user_id, msg);
              } catch {}
            }
          }
        }
      } catch (e) {
        serverLogger.info('src.routers.sync', '[SYNC] shared_resource fan-out failed (non-fatal):', e);
      }
    }

    return c.json(response);
  } catch (error: any) {
    // Zod 验证错误返回详细信息
    if (error?.name === 'ZodError' || error?.issues) {
      serverLogger.error('src.routers.sync', '[SYNC] /sync/push validation error:', JSON.stringify(error.issues || error));
      return c.json({ error: 'Validation failed' }, 400);
    }
    serverLogger.error('src.routers.sync', '[SYNC] /sync/push error - BEGIN ====================================');
    serverLogger.error('src.routers.sync', '[SYNC] error:', error);
    serverLogger.error('src.routers.sync', '[SYNC] typeof error:', typeof error);
    try {
      serverLogger.error('src.routers.sync', '[SYNC] stringified error:', JSON.stringify(error));
    } catch (e) {
      serverLogger.error('src.routers.sync', '[SYNC] JSON.stringify failed');
    }
    const errMessage = error instanceof Error
      ? error.message
      : (typeof error === 'string' ? error : JSON.stringify(error)?.slice(0, 500) ?? 'Unknown error');
    const errStack = error instanceof Error ? (error.stack ?? '') : '';
    serverLogger.error('src.routers.sync', '[SYNC] Error message:', errMessage);
    if (errStack) serverLogger.error('src.routers.sync', '[SYNC] Error stack:', errStack);
    // 诊断：500 异常摘要落库（失败不阻塞响应），便于直接查 D1 定位
    try {
      await db.prepare(
        `INSERT INTO audit_logs (user_id, action, details_json, level, logger, created_at)
         VALUES (?, 'sync_push_error', ?, 'ERROR', 'sync.diag', ?)`
      ).bind(
        userId,
        JSON.stringify({ message: errMessage, stack: errStack.slice(0, 2000), ts: new Date().toISOString() }),
        new Date().toISOString(),
      ).run();
    } catch (diagErr) {
      serverLogger.error('src.routers.sync', '[SYNC] sync.diag insert failed:', diagErr);
    }
    serverLogger.error('src.routers.sync', '[SYNC] /sync/push error - END ======================================');
    serverLogger.info('src.routers.sync', `[SYNC] ===== ${CODE_VERSION} ERROR =====`);
    
    // 响应体带上真实错误摘要（app debugPrint 会打出来，便于定位）
    return c.json({ error: 'Internal server error', detail: errMessage.slice(0, 300) }, 500);
  }
});

// ---------------------------------------------------------------------------
// GET /sync/debug - 诊断同步状态
// ---------------------------------------------------------------------------

syncRouter.get('/debug', async (c) => {
  if (c.env.NODE_ENV !== 'development') {
    return c.json({ error: 'Not found' }, 404);
  }
  let userId: string;
  try {
    userId = c.get('userId');
  } catch {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  const db = c.env.DB;

  // 统计 sync_changes 中各 entity_type 的数量
  const entityCounts = await db.prepare(
    "SELECT entity_type, scope, COUNT(*) as cnt FROM sync_changes WHERE user_id = ? GROUP BY entity_type, scope"
  ).bind(userId).all<{ entity_type: string; scope: string; cnt: number }>();

  // 统计 projection 中各表的数量
  const catProjCount = await db.prepare("SELECT COUNT(DISTINCT sync_id) as cnt FROM read_category_projection WHERE user_id = ?").bind(userId).first<{ cnt: number }>();
  const txProjCount = await db.prepare("SELECT COUNT(*) as cnt FROM read_tx_projection WHERE user_id = ?").bind(userId).first<{ cnt: number }>();
  const accProjCount = await db.prepare("SELECT COUNT(DISTINCT sync_id) as cnt FROM read_account_projection WHERE user_id = ?").bind(userId).first<{ cnt: number }>();
  const tagProjCount = await db.prepare("SELECT COUNT(DISTINCT sync_id) as cnt FROM read_tag_projection WHERE user_id = ?").bind(userId).first<{ cnt: number }>();
  const budgetProjCount = await db.prepare("SELECT COUNT(DISTINCT sync_id) as cnt FROM read_budget_projection WHERE user_id = ?").bind(userId).first<{ cnt: number }>();

  // sync_cursors 状态
  const cursors = await db.prepare("SELECT * FROM sync_cursors WHERE user_id = ?").bind(userId).all();

  // 最近3条 category 变更
  const recentCategories = await db.prepare(
    "SELECT entity_sync_id, action, payload_json, updated_at FROM sync_changes WHERE user_id = ? AND entity_type = 'category' ORDER BY change_id DESC LIMIT 3"
  ).bind(userId).all();

  return c.json({
    sync_changes: entityCounts.results,
    projections: {
      category: catProjCount?.cnt ?? 0,
      transaction: txProjCount?.cnt ?? 0,
      account: accProjCount?.cnt ?? 0,
      tag: tagProjCount?.cnt ?? 0,
      budget: budgetProjCount?.cnt ?? 0,
    },
    cursors: cursors.results,
    recent_categories: recentCategories.results,
  });
});

// ---------------------------------------------------------------------------
// GET /sync/debug/change/:changeId - 检查特定 change_id 的状态
// ---------------------------------------------------------------------------

syncRouter.get('/debug/change/:changeId', async (c) => {
  if (c.env.NODE_ENV !== 'development') {
    return c.json({ error: 'Not found' }, 404);
  }
  let userId: string;
  try {
    userId = c.get('userId');
  } catch {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  const db = c.env.DB;
  const changeId = parseInt(c.req.param('changeId'));

  if (!changeId || changeId <= 0) {
    return c.json({ error: 'Invalid change_id' }, 400);
  }

  // 查询该 change 的详情
  const change = await db.prepare(
    `SELECT change_id, user_id, ledger_id, entity_type, entity_sync_id, action, payload_json, updated_at, updated_by_device_id, scope
     FROM sync_changes WHERE change_id = ? AND user_id = ?`
  ).bind(changeId, userId).first<{
    change_id: number;
    user_id: string;
    ledger_id: string | null;
    entity_type: string;
    entity_sync_id: string;
    action: string;
    payload_json: string;
    updated_at: string;
    updated_by_device_id: string | null;
    scope: string | null;
  }>();

  if (!change) {
    return c.json({ error: 'Change not found', change_id: changeId });
  }

  // 尝试解析 payload
  let payloadParseStatus = 'ok';
  let payloadPreview = null;
  try {
    if (change.payload_json) {
      payloadPreview = JSON.parse(change.payload_json);
    }
  } catch (err) {
    payloadParseStatus = 'error: ' + (err instanceof Error ? err.message : String(err));
  }

  // 检查 projection 中是否有对应记录
  let projectionStatus = 'not_checked';
  if (change.entity_type === 'transaction' && change.ledger_id) {
    const projRow = await db.prepare(
      `SELECT sync_id FROM read_tx_projection WHERE ledger_id = ? AND sync_id = ?`
    ).bind(change.ledger_id, change.entity_sync_id).first();
    projectionStatus = projRow ? 'exists' : 'missing';
  }

  return c.json({
    change: {
      ...change,
      payload_json_length: change.payload_json?.length ?? 0,
    },
    payload_parse: payloadParseStatus,
    payload_preview: payloadPreview ? JSON.stringify(payloadPreview).substring(0, 500) : null,
    projection: projectionStatus,
  });
});

// ---------------------------------------------------------------------------
// GET /sync/pull - 增量拉取：客户端按游标拉取服务端变更
// ---------------------------------------------------------------------------

syncRouter.get('/pull', async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  
  const since = parseInt(c.req.query('since') ?? '0');
  const limit = Math.min(parseInt(c.req.query('limit') ?? '1000', 10), 5000);
  const ledgerId = c.req.query('ledger_id');
  const deviceId = c.req.query('device_id');

  serverLogger.info('src.routers.sync', '[SYNC] /sync/pull since:', since, 'limit:', limit, 'ledger_id:', ledgerId, 'device_id:', deviceId);

  try {
// 设备验证 + heartbeat
    if (deviceId) {
      const device = await db
        .prepare('SELECT id FROM devices WHERE id = ? AND user_id = ? AND revoked_at IS NULL')
        .bind(deviceId, userId)
        .first();
      if (!device) {
        return c.json({ error: 'Invalid device' }, 401);
      }
      await db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ? AND user_id = ?')
        .bind(new Date().toISOString(), deviceId, userId).run();
    }

    // 获取用户可访问的所有账本 ID（自有 + 共享成员）— 与原版 list_accessible_ledgers 对齐
    const accessibleLedgerRows = await db.prepare(
      `SELECT l.id FROM ledgers l WHERE l.user_id = ?
       UNION
       SELECT lm.ledger_id FROM ledger_members lm WHERE lm.user_id = ?`
    ).bind(userId, userId).all<{ id: string }>();
    const accessibleLedgerIds = accessibleLedgerRows.results.map(r => r.id);

    let query = `
      SELECT c.change_id, c.entity_type, c.entity_sync_id, c.action, c.payload_json, c.updated_at, c.updated_by_device_id, c.scope, l.external_id as ledger_id
      FROM sync_changes c
      LEFT JOIN ledgers l ON c.ledger_id = l.id
      WHERE (
        (c.scope = 'user' AND c.user_id = ? AND c.change_id > ?)
        OR (c.scope = 'ledger' AND c.ledger_id IN (${accessibleLedgerIds.map(() => '?').join(',')}) AND c.change_id > ?)
      )
    `;

    const params: (string | number)[] = [userId, since, ...accessibleLedgerIds, since];
    
    if (ledgerId) {
      query += ' AND (l.external_id = ? OR c.scope = \'user\')';
      params.push(ledgerId);
    }

    // 与原版对齐：过滤设备自身变更（依赖 WS 推送获取实时更新）。
    // SQLite 三值逻辑：NULL != ? 结果为 NULL（视为 false），会把
    // updated_by_device_id IS NULL 的变更（web 端/恢复/导入创建）误过滤掉，
    // 导致 app 拉不到这些交易。必须显式放行 NULL。
    if (deviceId) {
      query += ' AND (c.updated_by_device_id IS NULL OR c.updated_by_device_id != ?)';
      params.push(deviceId);
    }
    
    query += ' ORDER BY c.change_id ASC LIMIT ?';
    params.push(limit + 1);

    const changes = await db
      .prepare(query)
      .bind(...params)
      .all<{
        change_id: number;
        entity_type: string;
        entity_sync_id: string;
        action: string;
        payload_json: string;
        updated_at: string;
        ledger_id: string | null;
        updated_by_device_id: string | null;
        scope: string | null;
      }>();

    const allResults = changes.results;
    const hasMore = allResults.length > limit;
    const limitedResults = hasMore ? allResults.slice(0, limit) : allResults;

    let serverCursor = since;
    for (const r of limitedResults) {
      serverCursor = Math.max(serverCursor, r.change_id);
    }

    // 补全 transaction payload 中缺失的 createdByUserId/updatedByUserId（与原版对齐）
    try {
      await enrichTxPayloadsWithUserIds(db, limitedResults);
    } catch (err) {
      serverLogger.error('src.routers.sync', '[SYNC] /sync/pull enrichTxPayloads error (non-fatal):', err);
    }

    const resultTypeCounts: Record<string, number> = {};
    for (const r of limitedResults) {
      resultTypeCounts[r.entity_type] = (resultTypeCounts[r.entity_type] || 0) + 1;
    }
    serverLogger.info('src.routers.sync', '[SYNC] /sync/pull returning:', limitedResults.length, 'changes, has_more:', hasMore, 'by_type:', JSON.stringify(resultTypeCounts));

    // 写回 SyncCursor（per-device per-ledger 游标持久化）
    if (deviceId && limitedResults.length > 0) {
      const perLedgerCursor: Record<string, number> = {};
      for (const r of limitedResults) {
        const lid = r.ledger_id ?? '__user_global__';
        perLedgerCursor[lid] = Math.max(perLedgerCursor[lid] ?? 0, r.change_id);
      }
      const now = new Date().toISOString();
      for (const [ledgerExtId, lastCursor] of Object.entries(perLedgerCursor)) {
        await db.prepare(`INSERT INTO sync_cursors (user_id, device_id, ledger_external_id, last_cursor, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id, device_id, ledger_external_id) DO UPDATE SET last_cursor = ?, updated_at = ?`)
          .bind(userId, deviceId, ledgerExtId, lastCursor, now, lastCursor, now).run();
      }
    }

    return c.json({
      changes: limitedResults.map(c => {
        let payload: Record<string, unknown> = {};
        if (c.payload_json) {
          try {
            payload = JSON.parse(c.payload_json);
            convertBooleans(payload);
          } catch (err) {
            serverLogger.error('src.routers.sync', '[SYNC] /sync/pull JSON.parse error for change_id:', c.change_id, 'entity_type:', c.entity_type, 'error:', err);
            payload = {};
          }
        }
        return {
          change_id: c.change_id,
          ledger_id: c.scope === 'user' ? '__user_global__' : (c.ledger_id ?? ''),
          entity_type: c.entity_type,
          entity_sync_id: c.entity_sync_id,
          action: c.action,
          payload,
          updated_at: c.updated_at,
          updated_by_device_id: c.updated_by_device_id ?? null,
          scope: c.scope || 'ledger',
        };
      }),
      server_cursor: serverCursor,
      has_more: hasMore,
    });
  } catch (error) {
    serverLogger.error('src.routers.sync', '[SYNC] /sync/pull error - BEGIN ====================================');
    serverLogger.error('src.routers.sync', '[SYNC] error:', error);
    if (error instanceof Error) {
      serverLogger.error('src.routers.sync', '[SYNC] Error message:', error.message);
      serverLogger.error('src.routers.sync', '[SYNC] Error stack:', error.stack);
    }
    serverLogger.error('src.routers.sync', '[SYNC] /sync/pull error - END ======================================');
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// ---------------------------------------------------------------------------
// GET /sync/ledgers - 列出用户可访问的账本元信息
// ---------------------------------------------------------------------------

syncRouter.get('/ledgers', async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;

  try {
    // 查询用户可访问的所有账本（自有 + 共享成员）— 与原版 list_accessible_ledgers 对齐
    const ledgers = await db
      .prepare(`SELECT l.id, l.external_id, l.name, l.currency, l.created_at, 'owner' as role
                FROM ledgers l WHERE l.user_id = ?
                UNION
                SELECT l.id, l.external_id, l.name, l.currency, l.created_at, lm.role
                FROM ledgers l JOIN ledger_members lm ON l.id = lm.ledger_id
                WHERE lm.user_id = ?`)
      .bind(userId, userId)
      .all<{ id: string; external_id: string; name: string; currency: string; created_at: string; role: string }>();

    const result: Array<Record<string, unknown>> = [];

    for (const l of ledgers.results) {
      // 软删除检查：最后一个 ledger_snapshot delete tombstone
      const tombstone = await db
        .prepare(`SELECT action FROM sync_changes WHERE ledger_id = ? AND entity_type = 'ledger_snapshot' AND action = 'delete' ORDER BY change_id DESC LIMIT 1`)
        .bind(l.id)
        .first<{ action: string }>();
      if (tombstone?.action === 'delete') continue;

      // 检查是否有任何变更（空账本跳过，与原版对齐）
      const latestChangeId = await db
        .prepare('SELECT MAX(change_id) as max_id FROM sync_changes WHERE ledger_id = ?')
        .bind(l.id)
        .first<{ max_id: number | null }>();
      if (!latestChangeId?.max_id) continue;

      // 获取最新变更时间
      const latestUpdated = await db
        .prepare('SELECT updated_at FROM sync_changes WHERE ledger_id = ? ORDER BY change_id DESC LIMIT 1')
        .bind(l.id)
        .first<{ updated_at: string }>();

      // 估算大小
      const txCount = await db
        .prepare('SELECT COUNT(*) as cnt FROM read_tx_projection WHERE ledger_id = ?')
        .bind(l.id)
        .first<{ cnt: number }>();

      result.push({
        ledger_id: l.external_id,
        path: l.external_id,
        updated_at: latestUpdated?.updated_at ?? new Date().toISOString(),
        size: 512 + (txCount?.cnt ?? 0) * 300,
        metadata: { source: 'lazy_rebuild' },
        role: l.role,
      });
    }

    return c.json(result);
  } catch (error) {
    serverLogger.error('src.routers.sync', '[SYNC] /sync/ledgers error:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// ---------------------------------------------------------------------------
// GET /sync/full - 全量同步：返回账本完整快照
// ---------------------------------------------------------------------------

syncRouter.get('/full', async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  
  const ledgerId = c.req.query('ledger_id');
  if (!ledgerId) {
    return c.json({ error: 'ledger_id is required' }, 400);
  }

  try {
    // 支持共享账本：先查 owner 的，再查通过 ledger_members 共享的
    let ledger = await db
      .prepare(`SELECT id, external_id, name, currency, month_start_day FROM ledgers WHERE user_id = ? AND external_id = ?`)
      .bind(userId, ledgerId)
      .first<{ id: string; external_id: string; name: string | null; currency: string; month_start_day: number }>();

    if (!ledger) {
      // 检查是否通过 ledger_members 共享
      const shared = await db
        .prepare(`SELECT l.id, l.external_id, l.name, l.currency, l.month_start_day
                  FROM ledgers l JOIN ledger_members lm ON l.id = lm.ledger_id
                  WHERE lm.user_id = ? AND l.external_id = ?`)
        .bind(userId, ledgerId)
        .first<{ id: string; external_id: string; name: string | null; currency: string; month_start_day: number }>();
      if (shared) ledger = shared;
    }

    if (!ledger) {
      return c.json({ ledger_id: ledgerId, snapshot: null, latest_cursor: 0 });
    }

    console.debug(`[SYNC] sync/full ledger found: id=${ledger.id}, external_id=${ledger.external_id}`);

    // 诊断：检查投影表中的 ledger_id 是否匹配
    const sampleTx = await db.prepare('SELECT ledger_id FROM read_tx_projection LIMIT 3').all<{ ledger_id: string }>();
    console.debug(`[SYNC] sync/full projection ledger_ids:`, JSON.stringify(sampleTx.results?.map(r => r.ledger_id)));
    console.debug(`[SYNC] sync/full looking for ledger.id:`, ledger.id);

    // latest_cursor 只取该账本的 max change_id（与原版 _max_cursor_for_ledgers 对齐）
    const latestCursorRow = await db
      .prepare('SELECT MAX(change_id) as max_id FROM sync_changes WHERE ledger_id = ?')
      .bind(ledger.id)
      .first<{ max_id: number | null }>();
    const latestCursor = latestCursorRow?.max_id ?? 0;

    const tombstone = await db
      .prepare(`SELECT action FROM sync_changes WHERE ledger_id = ? AND entity_type = 'ledger_snapshot' AND action = 'delete' ORDER BY change_id DESC LIMIT 1`)
      .bind(ledger.id)
      .first<{ action: string }>();
    if (tombstone?.action === 'delete') {
      return c.json({ ledger_id: ledgerId, snapshot: null, latest_cursor: latestCursor });
    }

    // 检查账本是否有任何变更
    const ledgerChangeId = await db
      .prepare('SELECT MAX(change_id) as max_id FROM sync_changes WHERE ledger_id = ?')
      .bind(ledger.id)
      .first<{ max_id: number | null }>();

    // 检查投影表是否有数据——交易、预算、账户、分类、标签都要检查
    const hasProjectionsById = !!(await db.prepare('SELECT 1 FROM read_tx_projection WHERE ledger_id = ? LIMIT 1').bind(ledger.id).first()) ||
      !!(await db.prepare('SELECT 1 FROM read_budget_projection WHERE ledger_id = ? LIMIT 1').bind(ledger.id).first());
    const hasProjectionsByExtId = !!(await db.prepare('SELECT 1 FROM read_tx_projection WHERE ledger_id = ? LIMIT 1').bind(ledger.external_id).first()) ||
      !!(await db.prepare('SELECT 1 FROM read_budget_projection WHERE ledger_id = ? LIMIT 1').bind(ledger.external_id).first());
    const hasProjections = hasProjectionsById || hasProjectionsByExtId;
    // 用实际匹配的值查询
    const effectiveLedgerId = hasProjectionsById ? ledger.id : ledger.external_id;

    if (!ledgerChangeId?.max_id && !hasProjections) {
      return c.json({ ledger_id: ledgerId, snapshot: null, latest_cursor: latestCursor });
    }

    const [txs, accounts, categories, tags, budgets] = await Promise.all([
      db.prepare('SELECT * FROM read_tx_projection WHERE ledger_id = ?').bind(effectiveLedgerId).all(),
      db.prepare('SELECT * FROM read_account_projection WHERE user_id = ?').bind(userId).all(),
      db.prepare('SELECT * FROM read_category_projection WHERE user_id = ?').bind(userId).all(),
      db.prepare('SELECT * FROM read_tag_projection WHERE user_id = ?').bind(userId).all(),
      db.prepare('SELECT * FROM read_budget_projection WHERE ledger_id = ?').bind(effectiveLedgerId).all(),
    ]);
    console.log(`[SYNC] sync/full ledger=${ledger.id} ext=${ledger.external_id} effective=${effectiveLedgerId} txs=${txs.results.length} budgets=${budgets.results.length} userId=${userId}`);

    // 检查缓存（与原版 snapshot_cache 对齐）
    let snapshot = snapshotCacheGet(ledger.id, latestCursor) as Record<string, unknown> | null;
    if (!snapshot) {
      snapshot = {
        ledgerSyncId: ledger.external_id,
        ledgerName: ledger.name || ledger.external_id,
        currency: ledger.currency || 'CNY',
        monthStartDay: ledger.month_start_day || 1,
        count: txs.results.length,
        items: txs.results.map(r => convertBooleans(r as Record<string, unknown>)),
        accounts: accounts.results.map(r => convertBooleans(r as Record<string, unknown>)),
        categories: categories.results.map(r => convertBooleans(r as Record<string, unknown>)),
        tags: tags.results.map(r => convertBooleans(r as Record<string, unknown>)),
        budgets: budgets.results.map(r => convertBooleans(r as Record<string, unknown>)),
      };
      snapshotCachePut(ledger.id, latestCursor, snapshot);
    }

    return c.json({
      ledger_id: ledgerId,
      latest_cursor: latestCursor,
      snapshot: {
        change_id: latestCursor,
        ledger_id: ledgerId,
        entity_type: 'ledger_snapshot',
        entity_sync_id: ledger.external_id,
        action: 'upsert',
        payload: { content: JSON.stringify(snapshot), metadata: { source: 'lazy_rebuild' } },
        updated_at: new Date().toISOString(),
        updated_by_device_id: null,
        scope: 'ledger',
      },
    });
  } catch (error) {
    serverLogger.error('src.routers.sync', '[SYNC] /sync/full error:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// ---------------------------------------------------------------------------
// applyUserChangeToProjection - 应用 user-global 变更到投影表
// ---------------------------------------------------------------------------

async function preloadUserGlobalProjections(
  db: D1Database,
  userId: string,
  changes: Array<{ entity_type: string; entity_sync_id: string }>,
): Promise<Map<string, Map<string, any>>> {
  const result = new Map<string, Map<string, any>>();
  const byType = new Map<string, string[]>();
  for (const ch of changes) {
    if (!byType.has(ch.entity_type)) byType.set(ch.entity_type, []);
    const list = byType.get(ch.entity_type)!;
    if (!list.includes(ch.entity_sync_id)) list.push(ch.entity_sync_id);
  }
  for (const [type, syncIds] of byType.entries()) {
    const table = type === 'category' ? 'read_category_projection'
      : type === 'account' ? 'read_account_projection'
      : type === 'tag' ? 'read_tag_projection'
      : null;
    if (!table) continue;
    const typeMap = new Map<string, any>();
    for (let i = 0; i < syncIds.length; i += 30) {
      const chunkIds = syncIds.slice(i, i + 30);
      const placeholders = chunkIds.map(() => '?').join(',');
      const rows = await db.prepare(
        `SELECT * FROM ${table} WHERE user_id = ? AND sync_id IN (${placeholders}) AND ledger_id IS NULL`
      ).bind(userId, ...chunkIds).all<any>();
      for (const r of rows.results) typeMap.set(r.sync_id, r);
    }
    if (typeMap.size > 0) result.set(type, typeMap);
  }
  return result;
}

async function applyUserChangeToProjection(
  db: D1Database,
  userId: string,
  change: {
    change_id: number;
    entity_type: string;
    entity_sync_id: string;
    action: string;
    payload: Record<string, unknown>;
  },
  r2?: R2Bucket,
  preloadedRow?: any,
  batchCollector?: any[],
): Promise<void> {
  const { entity_type, entity_sync_id, action, payload } = change;

  if (action === 'delete') {
    if (entity_type === 'category') {
      // 删除前收集图标信息（SELECT 在外，batch 内只做 DB 写）
      const catIcon = r2 ? await db.prepare(
        'SELECT icon_cloud_file_id FROM read_category_projection WHERE sync_id = ? AND user_id = ?'
      ).bind(entity_sync_id, userId).first<{ icon_cloud_file_id: string | null }>() : null;
      const fileId = catIcon?.icon_cloud_file_id;

      // 删投影 + 紧凑化历史（同事务原子）
      await db.batch([
        db.prepare('DELETE FROM read_category_projection WHERE sync_id = ? AND user_id = ?')
          .bind(entity_sync_id, userId),
        db.prepare(
          `DELETE FROM sync_changes WHERE user_id = ? AND entity_type = ? AND entity_sync_id = ? AND action != 'delete'`
        ).bind(userId, entity_type, entity_sync_id),
      ]);

      // gc 孤立图标（best-effort，投影已删后才能检查引用）
      if (fileId) {
        try {
          const stillUsed = await db.prepare(
            'SELECT COUNT(*) as cnt FROM read_category_projection WHERE icon_cloud_file_id = ? AND user_id = ?'
          ).bind(fileId, userId).first<{ cnt: number }>();
          if (!stillUsed || stillUsed.cnt === 0) {
            const iconRow = await db.prepare(
              "SELECT storage_path FROM attachment_files WHERE id = ? AND attachment_kind = 'category_icon'"
            ).bind(fileId).first<{ storage_path: string }>();
            if (iconRow?.storage_path && r2) {
              try { await r2.delete(iconRow.storage_path); } catch {}
            }
            await db.prepare('DELETE FROM attachment_files WHERE id = ?').bind(fileId).run();
          }
        } catch {}
      }
    } else if (entity_type === 'account') {
      await db.batch([
        db.prepare('DELETE FROM read_account_projection WHERE sync_id = ? AND user_id = ?')
          .bind(entity_sync_id, userId),
        db.prepare(
          `DELETE FROM sync_changes WHERE user_id = ? AND entity_type = ? AND entity_sync_id = ? AND action != 'delete'`
        ).bind(userId, entity_type, entity_sync_id),
      ]);
    } else if (entity_type === 'tag') {
      await db.batch([
        db.prepare('DELETE FROM read_tag_projection WHERE sync_id = ? AND user_id = ?')
          .bind(entity_sync_id, userId),
        db.prepare(
          `DELETE FROM sync_changes WHERE user_id = ? AND entity_type = ? AND entity_sync_id = ? AND action != 'delete'`
        ).bind(userId, entity_type, entity_sync_id),
      ]);
    }
    return;
  }

  if (entity_type === 'category') {
    // APP 用 camelCase (parentName, parentSyncId)，原版用 snake_case (parent_name, parent_sync_id)
    const parentName = (payload as any).parentName ?? payload.parent_name ?? null;
    let parentSyncId = (payload as any).parentSyncId ?? payload.parent_sync_id ?? null;
    // 原版 projection.py:378-386：parentSyncId 缺失时用 parentName + kind + level=1 反查
    if (parentSyncId === null && parentName) {
      const parentRow = await db.prepare(
        'SELECT sync_id FROM read_category_projection WHERE user_id = ? AND name = ? AND kind = ? AND (level IS NULL OR level = 1) LIMIT 1'
      ).bind(userId, parentName, payload.kind ?? null).first<{ sync_id: string }>();
      if (parentRow) parentSyncId = parentRow.sync_id;
    }
    const sortOrder = (payload as any).sortOrder ?? payload.sort_order ?? null;
    const iconType = (payload as any).iconType ?? payload.icon_type ?? null;
    const customIconPath = (payload as any).customIconPath ?? payload.custom_icon_path ?? null;
    const iconCloudFileId = (payload as any).iconCloudFileId ?? payload.icon_cloud_file_id ?? null;
    const iconCloudSha256 = (payload as any).iconCloudSha256 ?? payload.icon_cloud_sha256 ?? null;

    // 合并 rename 检查和现有行查询为一次 SELECT
    const existingRow = await db.prepare(
      'SELECT name, kind, level, sort_order, icon, icon_type, custom_icon_path, icon_cloud_file_id, icon_cloud_sha256, parent_name, parent_sync_id FROM read_category_projection WHERE sync_id = ? AND user_id = ?'
    ).bind(entity_sync_id, userId).first<{
      name: string | null; kind: string | null; level: number | null;
      sort_order: number | null; icon: string | null; icon_type: string | null;
      custom_icon_path: string | null; icon_cloud_file_id: string | null;
      icon_cloud_sha256: string | null; parent_name: string | null; parent_sync_id: string | null;
    }>();

    // 对齐原版：user-global category upsert 按 (user_id, sync_id) 主键无条件写入。
    // 默认分类的 syncId 是确定性 uuid v5（所有用户相同），跨用户「已有就跳过」会把
    // 新用户的默认分类当别人的数据丢弃 —— 原版无此检查（projection.py _upsert）。

    // Rename cascade + 投影 upsert 同事务原子写入
    const newName = (payload.name as string) ?? null;
    const stmts: any[] = [];
    if (newName && existingRow?.name && existingRow.name !== newName) {
      stmts.push(
        db.prepare('UPDATE read_tx_projection SET category_name = ?, category_kind = ? WHERE user_id = ? AND category_sync_id = ?')
          .bind(newName, payload.kind ?? existingRow.kind ?? null, userId, entity_sync_id),
      );
    }

    const merged = {
      name: newName ?? existingRow?.name ?? null,
      kind: payload.kind ?? existingRow?.kind ?? null,
      level: payload.level ?? existingRow?.level ?? null,
      sort_order: sortOrder ?? existingRow?.sort_order ?? null,
      icon: payload.icon ?? existingRow?.icon ?? null,
      icon_type: iconType ?? existingRow?.icon_type ?? null,
      custom_icon_path: customIconPath ?? existingRow?.custom_icon_path ?? null,
      icon_cloud_file_id: iconCloudFileId ?? existingRow?.icon_cloud_file_id ?? null,
      icon_cloud_sha256: iconCloudSha256 ?? existingRow?.icon_cloud_sha256 ?? null,
      parent_name: parentName ?? existingRow?.parent_name ?? null,
      parent_sync_id: parentSyncId ?? existingRow?.parent_sync_id ?? null,
    };

    if (existingRow) {
      // 动态 UPDATE，只更新提供的字段
      const sets: string[] = [];
      const vals: unknown[] = [];
      if (payload.name !== undefined) { sets.push('name = ?'); vals.push(payload.name); }
      if (payload.kind !== undefined) { sets.push('kind = ?'); vals.push(payload.kind); }
      if (payload.level !== undefined) { sets.push('level = ?'); vals.push(payload.level); }
      if ((payload as any).sortOrder !== undefined) { sets.push('sort_order = ?'); vals.push(sortOrder); }
      if (payload.icon !== undefined) { sets.push('icon = ?'); vals.push(payload.icon); }
      if ((payload as any).iconType !== undefined) { sets.push('icon_type = ?'); vals.push(iconType); }
      if ((payload as any).customIconPath !== undefined) { sets.push('custom_icon_path = ?'); vals.push(customIconPath); }
      if ((payload as any).iconCloudFileId !== undefined) { sets.push('icon_cloud_file_id = ?'); vals.push(iconCloudFileId); }
      if ((payload as any).iconCloudSha256 !== undefined) { sets.push('icon_cloud_sha256 = ?'); vals.push(iconCloudSha256); }
      if (parentName !== undefined) { sets.push('parent_name = ?'); vals.push(parentName); }
      if ((payload as any).parentSyncId !== undefined || payload.parent_sync_id !== undefined) { sets.push('parent_sync_id = ?'); vals.push(parentSyncId); }
      sets.push('source_change_id = ?');
      vals.push(change.change_id ?? 0);
      vals.push(entity_sync_id, userId);
      stmts.push(
        db.prepare(
          `UPDATE read_category_projection SET ${sets.join(', ')} WHERE sync_id = ? AND user_id = ?`
        ).bind(...vals),
      );
    } else {
      stmts.push(
        db.prepare(
          `INSERT OR REPLACE INTO read_category_projection
           (ledger_id, sync_id, user_id, name, kind, level, sort_order,
            icon, icon_type, custom_icon_path, icon_cloud_file_id, icon_cloud_sha256,
            parent_name, parent_sync_id, source_change_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          null, entity_sync_id, userId, merged.name, merged.kind,
          merged.level, merged.sort_order, merged.icon, merged.icon_type,
          merged.custom_icon_path, merged.icon_cloud_file_id, merged.icon_cloud_sha256,
          merged.parent_name, merged.parent_sync_id, change.change_id ?? 0,
        ),
      );
    }

    if (stmts.length > 0) await db.batch(stmts);
  } else if (entity_type === 'account') {
    // APP 用 camelCase，原版用 snake_case
    const accountType = (payload as any).accountType ?? payload.account_type ?? (payload as any).type ?? null;
    const initialBalance = (payload as any).initialBalance ?? payload.initial_balance ?? 0;
    const creditLimit = (payload as any).creditLimit ?? payload.credit_limit ?? null;
    const billingDay = (payload as any).billingDay ?? payload.billing_day ?? null;
    const paymentDueDay = (payload as any).paymentDueDay ?? payload.payment_due_day ?? null;
    const bankName = (payload as any).bankName ?? payload.bank_name ?? null;
    const cardLastFour = (payload as any).cardLastFour ?? payload.card_last_four ?? null;

    // 合并 rename 检查和现有行查询为一次 SELECT
    const existingRow = await db.prepare(
      'SELECT name, account_type, currency, initial_balance, note, credit_limit, billing_day, payment_due_day, bank_name, card_last_four, hidden FROM read_account_projection WHERE sync_id = ? AND user_id = ?'
    ).bind(entity_sync_id, userId).first<{
      name: string | null; account_type: string | null; currency: string | null;
      initial_balance: number | null; note: string | null; credit_limit: number | null;
      billing_day: number | null; payment_due_day: number | null;
      bank_name: string | null; card_last_four: string | null; hidden: number | null;
    }>();

    // Rename cascade + 投影 upsert 同事务原子写入
    const newName = (payload.name as string) ?? null;
    const stmts2: any[] = [];
    if (newName && existingRow?.name && existingRow.name !== newName) {
      stmts2.push(
        db.prepare('UPDATE read_tx_projection SET account_name = ? WHERE user_id = ? AND account_sync_id = ?')
          .bind(newName, userId, entity_sync_id),
        db.prepare('UPDATE read_tx_projection SET from_account_name = ? WHERE user_id = ? AND from_account_sync_id = ?')
          .bind(newName, userId, entity_sync_id),
        db.prepare('UPDATE read_tx_projection SET to_account_name = ? WHERE user_id = ? AND to_account_sync_id = ?')
          .bind(newName, userId, entity_sync_id),
      );
    }

    const merged = {
      name: newName ?? existingRow?.name ?? null,
      account_type: accountType ?? existingRow?.account_type ?? null,
      currency: payload.currency ?? existingRow?.currency ?? null,
      initial_balance: initialBalance ?? existingRow?.initial_balance ?? 0,
      note: payload.note ?? existingRow?.note ?? null,
      credit_limit: creditLimit ?? existingRow?.credit_limit ?? null,
      billing_day: billingDay ?? existingRow?.billing_day ?? null,
      payment_due_day: paymentDueDay ?? existingRow?.payment_due_day ?? null,
      bank_name: bankName ?? existingRow?.bank_name ?? null,
      card_last_four: cardLastFour ?? existingRow?.card_last_four ?? null,
      hidden: (payload as any).hidden ?? existingRow?.hidden ?? null,
    };

    if (existingRow) {
      // 动态 UPDATE，只更新提供的字段
      const sets: string[] = [];
      const vals: unknown[] = [];
      if (payload.name !== undefined) { sets.push('name = ?'); vals.push(payload.name); }
      if ((payload as any).accountType !== undefined || payload.account_type !== undefined || (payload as any).type !== undefined) { sets.push('account_type = ?'); vals.push(accountType); }
      if (payload.currency !== undefined) { sets.push('currency = ?'); vals.push(payload.currency); }
      if ((payload as any).initialBalance !== undefined || payload.initial_balance !== undefined) { sets.push('initial_balance = ?'); vals.push(initialBalance); }
      if (payload.note !== undefined) { sets.push('note = ?'); vals.push(payload.note); }
      if ((payload as any).creditLimit !== undefined || payload.credit_limit !== undefined) { sets.push('credit_limit = ?'); vals.push(creditLimit); }
      if ((payload as any).billingDay !== undefined || payload.billing_day !== undefined) { sets.push('billing_day = ?'); vals.push(billingDay); }
      if ((payload as any).paymentDueDay !== undefined || payload.payment_due_day !== undefined) { sets.push('payment_due_day = ?'); vals.push(paymentDueDay); }
      if ((payload as any).bankName !== undefined || payload.bank_name !== undefined) { sets.push('bank_name = ?'); vals.push(bankName); }
      if ((payload as any).cardLastFour !== undefined || payload.card_last_four !== undefined) { sets.push('card_last_four = ?'); vals.push(cardLastFour); }
      if ((payload as any).hidden !== undefined) { sets.push('hidden = ?'); vals.push((payload as any).hidden ? 1 : 0); }
      sets.push('source_change_id = ?');
      vals.push(change.change_id ?? 0);
      vals.push(entity_sync_id, userId);
      stmts2.push(
        db.prepare(
          `UPDATE read_account_projection SET ${sets.join(', ')} WHERE sync_id = ? AND user_id = ?`
        ).bind(...vals),
      );
    } else {
      stmts2.push(
        db.prepare(
          `INSERT OR REPLACE INTO read_account_projection
           (ledger_id, sync_id, user_id, name, account_type, currency, initial_balance,
            note, credit_limit, billing_day, payment_due_day, bank_name, card_last_four, hidden, source_change_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          null, entity_sync_id, userId, merged.name, merged.account_type,
          merged.currency, merged.initial_balance, merged.note,
          merged.credit_limit, merged.billing_day,
          merged.payment_due_day, merged.bank_name,
          merged.card_last_four, merged.hidden, change.change_id ?? 0,
        ),
      );
    }

    if (stmts2.length > 0) await db.batch(stmts2);
  } else if (entity_type === 'tag') {
    // Rename cascade：标签改名时更新 read_tx_projection 的 tags_csv
    const newName = (payload.name as string) ?? null;
    if (newName) {
      const prevRow = await db.prepare('SELECT name FROM read_tag_projection WHERE sync_id = ? AND user_id = ?')
        .bind(entity_sync_id, userId).first<{ name: string | null }>();
      const oldName = prevRow?.name;
      if (oldName && oldName !== newName) {
        // 按 tag_sync_ids_json 精确匹配
        const likePattern = `%"${entity_sync_id}"%`;
        const txRows = await db.prepare(
          `SELECT ledger_id, sync_id, tags_csv FROM read_tx_projection
           WHERE user_id = ? AND tag_sync_ids_json LIKE ?`
        ).bind(userId, likePattern).all<{ ledger_id: string; sync_id: string; tags_csv: string | null }>();
        for (const tx of txRows.results) {
          if (!tx.tags_csv) continue;
          const parts = tx.tags_csv.split(',').map(p => p.trim());
          const replaced = parts.map(p => p === oldName ? newName : p);
          if (replaced.join(',') !== parts.join(',')) {
            await db.prepare('UPDATE read_tx_projection SET tags_csv = ? WHERE ledger_id = ? AND sync_id = ?')
              .bind(replaced.join(','), tx.ledger_id, tx.sync_id).run();
          }
        }
      }
    }

    // merge_with_existing
    const existingRow = await db.prepare(
      'SELECT name, color FROM read_tag_projection WHERE sync_id = ? AND user_id = ?'
    ).bind(entity_sync_id, userId).first<{ name: string | null; color: string | null }>();

    const merged = {
      name: payload.name ?? existingRow?.name ?? null,
      color: payload.color ?? existingRow?.color ?? null,
    };

    if (existingRow) {
      // 动态 UPDATE，只更新提供的字段
      const sets: string[] = [];
      const vals: unknown[] = [];
      if (payload.name !== undefined) { sets.push('name = ?'); vals.push(payload.name); }
      if (payload.color !== undefined) { sets.push('color = ?'); vals.push(payload.color); }
      sets.push('source_change_id = ?');
      vals.push(change.change_id ?? 0);
      vals.push(entity_sync_id, userId);
      await db.prepare(
        `UPDATE read_tag_projection SET ${sets.join(', ')} WHERE sync_id = ? AND user_id = ?`
      ).bind(...vals).run();
    } else {
      await db.prepare(
        `INSERT OR REPLACE INTO read_tag_projection (ledger_id, sync_id, user_id, name, color, source_change_id)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).bind(null, entity_sync_id, userId, merged.name, merged.color, change.change_id ?? 0).run();
    }
  } else if (entity_type === 'exchange_rate_override') {
    if (change.action === 'delete') {
      // 与原版 _delete_user_exchange_rate_override 一致：按 sync_id 删除
      await db.prepare('DELETE FROM exchange_rate_overrides WHERE user_id = ? AND sync_id = ?')
        .bind(userId, entity_sync_id).run();
      // 与原版 _compact_entity_upsert_events 一致：清理旧 upsert 历史，防止 stale upsert 复活
      await db.prepare(
        `DELETE FROM sync_changes WHERE user_id = ? AND entity_type = 'exchange_rate_override' AND entity_sync_id = ? AND action != 'delete'`
      ).bind(userId, entity_sync_id).run();
    } else {
      const payload = change.payload;
      const baseCurrency = (payload as any).baseCurrency ?? '';
      const quoteCurrency = (payload as any).quoteCurrency ?? '';
      const rate = (payload as any).rate ?? 1;
      const updatedAt = (payload as any).updatedAt ?? new Date().toISOString();
      const existing = await db.prepare('SELECT base_currency FROM exchange_rate_overrides WHERE user_id = ? AND base_currency = ? AND quote_currency = ?')
        .bind(userId, baseCurrency, quoteCurrency).first();
      if (existing) {
        await db.prepare('UPDATE exchange_rate_overrides SET rate = ?, updated_at = ? WHERE user_id = ? AND base_currency = ? AND quote_currency = ?')
          .bind(String(rate), updatedAt, userId, baseCurrency, quoteCurrency).run();
      } else {
        await db.prepare('INSERT INTO exchange_rate_overrides (user_id, sync_id, base_currency, quote_currency, rate, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
          .bind(userId, entity_sync_id, baseCurrency, quoteCurrency, String(rate), updatedAt).run();
      }
    }
  }
}

// ---------------------------------------------------------------------------
// applyChangeToProjection - 应用单个变更到投影表
// ---------------------------------------------------------------------------

async function applyChangeToProjection(
  db: D1Database,
  ledgerId: string,
  userId: string,
  change: {
    change_id: number;
    entity_type: string;
    entity_sync_id: string;
    action: string;
    payload: Record<string, unknown>;
    ledger_id: string;
  },
  r2?: R2Bucket
): Promise<void> {
  // 处理 ledger_snapshot delete - 删除整个账本
  if (change.entity_type === 'ledger_snapshot' && change.action === 'delete') {
    await db.batch([
      db.prepare('DELETE FROM read_tx_projection WHERE ledger_id = ?').bind(ledgerId),
      db.prepare('DELETE FROM read_account_projection WHERE ledger_id = ?').bind(ledgerId),
      db.prepare('DELETE FROM read_category_projection WHERE ledger_id = ?').bind(ledgerId),
      db.prepare('DELETE FROM read_tag_projection WHERE ledger_id = ?').bind(ledgerId),
      db.prepare('DELETE FROM read_budget_projection WHERE ledger_id = ?').bind(ledgerId),
      db.prepare('DELETE FROM ledgers WHERE id = ?').bind(ledgerId),
    ]);
    return;
  }

  // 处理 ledger / ledger_snapshot upsert - 创建或更新账本元数据
  if ((change.entity_type === 'ledger' || change.entity_type === 'ledger_snapshot') && change.action === 'upsert') {
    const payload = change.payload as Record<string, unknown>;
    const name = (payload.ledgerName ?? payload.ledger_name ?? payload.name ?? null) as string | null;
    const currency = (payload.currency ?? null) as string | null;
    const monthStartDay = (payload.monthStartDay ?? payload.month_start_day ?? null) as number | null;

    // 只要有任一字段就更新 ledgers 表
    if (name || currency || monthStartDay) {
      const sets: string[] = [];
      const vals: unknown[] = [];
      if (name) { sets.push('name = ?'); vals.push(name); }
      if (currency) { sets.push('currency = ?'); vals.push(currency); }
      if (monthStartDay) { sets.push('month_start_day = ?'); vals.push(monthStartDay); }
      vals.push(ledgerId);
      await db.prepare(`UPDATE ledgers SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
    }
    return;
  }

  const INDIVIDUAL_ENTITY_TYPES = [
    'transaction',
    'account',
    'category',
    'tag',
    'budget',
    'ledger',
    'recurring_transaction',
    'attachment',
  ];

  if (!INDIVIDUAL_ENTITY_TYPES.includes(change.entity_type)) {
    return;
  }

  const payload = (change.payload ?? {}) as Record<string, unknown>;

  switch (change.entity_type) {
    case 'transaction': {
      if (change.action === 'delete') {
        // 删除前先收集附件 fileId（删投影后 attachments_json 就没了），
        // 再删投影，最后 gc 孤立附件 —— 对齐原版 sync_applier._delete_tx：
        // collect → delete tx → gc_orphan_attachments_for_ledger。
        // tombstone 的 sync_changes 已由 push 插入，这里只做投影副作用。
        const txRow = await db.prepare(
          'SELECT attachments_json FROM read_tx_projection WHERE ledger_id = ? AND sync_id = ?'
        ).bind(ledgerId, change.entity_sync_id).first<{ attachments_json: string | null }>();

        const fileIdsToClean: string[] = [];
        const shaHashesToClean: string[] = [];
        if (txRow?.attachments_json) {
          try {
            const attachments = JSON.parse(txRow.attachments_json);
            if (Array.isArray(attachments)) {
              for (const att of attachments) {
                // Web 端用 cloudFileId，Flutter App 端用 fileName（sha_<sha256>.jpg）
                const fileId = att.cloudFileId || att.id || att.file_id;
                if (fileId && !fileIdsToClean.includes(fileId)) fileIdsToClean.push(fileId);
                // Flutter App 的 fileName 格式：sha_<sha256>.jpg
                const fn = att.fileName || att.file_name || '';
                if (typeof fn === 'string' && fn.startsWith('sha_') && fn.endsWith('.jpg')) {
                  const sha = fn.slice(4, -4); // 去掉 "sha_" 前缀和 ".jpg" 后缀
                  if (sha && !shaHashesToClean.includes(sha)) shaHashesToClean.push(sha);
                }
              }
            }
          } catch {}
        }

        // 删投影 + 紧凑化历史（同事务原子）
        await db.batch([
          db.prepare('DELETE FROM read_tx_projection WHERE ledger_id = ? AND sync_id = ?')
            .bind(ledgerId, change.entity_sync_id),
          db.prepare(
            `DELETE FROM sync_changes WHERE ledger_id = ? AND entity_type = 'transaction' AND entity_sync_id = ? AND action != 'delete'`
          ).bind(ledgerId, change.entity_sync_id),
        ]);

        // gc 孤立附件（R2 无法事务化，做 best-effort）
        // （对齐原版 gc_orphan_attachments_for_ledger + _fileid_still_referenced_in_ledger）。
        // R2 删除是外部副作用，无法事务化，做 best-effort。
        for (const fileId of fileIdsToClean) {
          const attFile = await db.prepare(
            "SELECT storage_path, sha256 FROM attachment_files WHERE id = ? AND attachment_kind = 'transaction'"
          ).bind(fileId).first<{ storage_path: string; sha256: string | null }>();
          if (!attFile) continue;

          // 是否仍被本 ledger 下其他交易引用（共享附件保留）
          const patNoSpace = `"cloudFileId":"${fileId}"`;
          const patWithSpace = `"cloudFileId": "${fileId}"`;
          const shaPat = attFile.sha256 ? `sha_${attFile.sha256}.jpg` : null;
          const stillReferenced = await db.prepare(
            `SELECT COUNT(*) as cnt FROM read_tx_projection
             WHERE ledger_id = ? AND (INSTR(attachments_json, ?) > 0 OR INSTR(attachments_json, ?) > 0${shaPat ? ' OR INSTR(attachments_json, ?) > 0' : ''})`
          ).bind(ledgerId, patNoSpace, patWithSpace, ...(shaPat ? [shaPat] : [])).first<{ cnt: number }>();
          if (stillReferenced && stillReferenced.cnt > 0) continue;

          if (r2 && attFile.storage_path) {
            try { await r2.delete(attFile.storage_path); } catch {}
          }
          await db.prepare('DELETE FROM attachment_files WHERE id = ?').bind(fileId).run();
        }

        // 按 sha256 查找 Flutter App 端创建的附件（fileName 格式，无 cloudFileId）并清理
        for (const sha of shaHashesToClean) {
          const attFile = await db.prepare(
            "SELECT id, storage_path, sha256 FROM attachment_files WHERE sha256 = ? AND attachment_kind = 'transaction' LIMIT 1"
          ).bind(sha).first<{ id: string; storage_path: string; sha256: string | null }>();
          if (!attFile) continue;
          // 检查是否仍被其他交易引用
          const shaPat = `sha_${sha}.jpg`;
          const stillReferenced = await db.prepare(
            `SELECT COUNT(*) as cnt FROM read_tx_projection
             WHERE ledger_id = ? AND (INSTR(attachments_json, ?) > 0 OR INSTR(attachments_json, ?) > 0 OR INSTR(attachments_json, ?) > 0)`
          ).bind(ledgerId, `"cloudFileId":"${attFile.id}"`, `"cloudFileId": "${attFile.id}"`, shaPat).first<{ cnt: number }>();
          // 注意：这里同时检查了 cloudFileId（web 端）和 shaPat（Flutter 端）
          if (stillReferenced && stillReferenced.cnt > 0) continue;
          if (r2 && attFile.storage_path) {
            try { await r2.delete(attFile.storage_path); } catch {}
          }
          await db.prepare('DELETE FROM attachment_files WHERE id = ?').bind(attFile.id).run();
        }

        // 与原版 _compact_entity_upsert_events 对齐：清理 upsert 历史
        await db.prepare(
          `DELETE FROM sync_changes WHERE ledger_id = ? AND entity_type = 'transaction' AND entity_sync_id = ? AND action != 'delete'`
        ).bind(ledgerId, change.entity_sync_id).run();
      } else {
        const tagPayload = (payload.tags as string) ?? null;
        const tagIdsPayload = Array.isArray(payload.tagIds) ? payload.tagIds as string[] : null;
        const resolvedTagsCsv = await resolveTagsCsv(db, tagPayload, tagIdsPayload);

        // 合并已有行（与原版 _merge_from_spec 对齐）
        const existingTx = await db.prepare(
          `SELECT tx_type, amount, happened_at, note, category_sync_id, category_name, category_kind,
           account_sync_id, account_name, from_account_sync_id, from_account_name,
           to_account_sync_id, to_account_name, tags_csv, tag_sync_ids_json, attachments_json,
           tx_index, created_by_user_id, last_edited_by_user_id,
           exclude_from_stats, exclude_from_budget, currency_code, native_amount
           FROM read_tx_projection WHERE ledger_id = ? AND sync_id = ?`
        ).bind(ledgerId, change.entity_sync_id).first<Record<string, unknown>>();

        const txMerged = {
          tx_type: (payload as any).type ?? payload.tx_type ?? payload.txType ?? existingTx?.tx_type ?? 'expense',
          amount: (payload as any).amount ?? existingTx?.amount ?? 0,
          happened_at: (payload as any).happenedAt ?? payload.happened_at ?? existingTx?.happened_at ?? nowUtc(),
          note: (payload as any).note ?? existingTx?.note ?? null,
          category_sync_id: (payload as any).categoryId ?? existingTx?.category_sync_id ?? null,
          category_name: (payload as any).categoryName ?? existingTx?.category_name ?? null,
          category_kind: (payload as any).categoryKind ?? existingTx?.category_kind ?? null,
          account_sync_id: (payload as any).accountId ?? existingTx?.account_sync_id ?? null,
          account_name: (payload as any).accountName ?? existingTx?.account_name ?? null,
          from_account_sync_id: (payload as any).fromAccountId ?? existingTx?.from_account_sync_id ?? null,
          from_account_name: (payload as any).fromAccountName ?? existingTx?.from_account_name ?? null,
          to_account_sync_id: (payload as any).toAccountId ?? existingTx?.to_account_sync_id ?? null,
          to_account_name: (payload as any).toAccountName ?? existingTx?.to_account_name ?? null,
          tags_csv: resolvedTagsCsv ?? (existingTx?.tags_csv as string) ?? null,
          tag_sync_ids_json: (payload as any).tagIds ? safeJsonStringify((payload as any).tagIds) : (existingTx?.tag_sync_ids_json as string) ?? null,
          attachments_json: (payload as any).attachments ? safeJsonStringify((payload as any).attachments) : (existingTx?.attachments_json as string) ?? null,
          tx_index: (payload as any).txIndex ?? existingTx?.tx_index ?? 0,
          created_by_user_id: (payload as any).createdByUserId ?? existingTx?.created_by_user_id ?? userId,
          last_edited_by_user_id: (payload as any).updatedByUserId ?? existingTx?.last_edited_by_user_id ?? userId,
          exclude_from_stats: (payload as any).excludeFromStats ?? existingTx?.exclude_from_stats ?? 0,
          exclude_from_budget: (payload as any).excludeFromBudget ?? existingTx?.exclude_from_budget ?? 0,
          currency_code: (payload as any).currencyCode ?? existingTx?.currency_code ?? null,
          native_amount: (payload as any).nativeAmount ?? existingTx?.native_amount ?? null,
        };

        // 与原版 _sync_native_amount_after_merge 对齐：amount 改变时等比缩放 nativeAmount
        if (existingTx && (payload as any).amount !== undefined && (payload as any).nativeAmount === undefined) {
          const oldAmount = Number(existingTx.amount ?? 0);
          const oldNative = Number(existingTx.native_amount ?? 0);
          const newAmount = Number(txMerged.amount);
          if (oldAmount !== 0 && oldNative !== oldAmount && newAmount !== oldAmount) {
            txMerged.native_amount = oldNative / oldAmount * newAmount;
          }
        }

        await db
          .prepare(
            `INSERT OR REPLACE INTO read_tx_projection
             (ledger_id, sync_id, user_id, tx_type, amount, happened_at, note,
              category_sync_id, category_name, category_kind,
              account_sync_id, account_name,
              from_account_sync_id, from_account_name,
              to_account_sync_id, to_account_name,
              tags_csv, tag_sync_ids_json, attachments_json, tx_index,
              created_by_user_id, last_edited_by_user_id, source_change_id,
              currency_code, native_amount,
              exclude_from_stats, exclude_from_budget)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(
            ledgerId,
            change.entity_sync_id,
            userId,
            txMerged.tx_type,
            txMerged.amount,
            txMerged.happened_at,
            txMerged.note,
            txMerged.category_sync_id,
            txMerged.category_name,
            txMerged.category_kind,
            txMerged.account_sync_id,
            txMerged.account_name,
            txMerged.from_account_sync_id,
            txMerged.from_account_name,
            txMerged.to_account_sync_id,
            txMerged.to_account_name,
            txMerged.tags_csv,
            txMerged.tag_sync_ids_json,
            txMerged.attachments_json,
            txMerged.tx_index,
            txMerged.created_by_user_id,
            txMerged.last_edited_by_user_id,
            change.change_id,
            txMerged.currency_code,
            txMerged.native_amount,
            txMerged.exclude_from_stats ? 1 : 0,
            txMerged.exclude_from_budget ? 1 : 0,
          )
          .run();
      }
      break;
    }

    case 'account': {
      if (change.action === 'delete') {
        await db
          .prepare('DELETE FROM read_account_projection WHERE ledger_id = ? AND sync_id = ?')
          .bind(ledgerId, change.entity_sync_id)
          .run();
      } else {
        // 只更新 payload 中提供的字段（与原版 exclude_unset 对齐），避免覆盖未传字段为 NULL
        const existing = await db
          .prepare('SELECT sync_id FROM read_account_projection WHERE ledger_id = ? AND sync_id = ?')
          .bind(ledgerId, change.entity_sync_id)
          .first();
        
        const accountFields: Array<{ col: string; val: unknown }> = [];
        if (payload.name !== undefined) accountFields.push({ col: 'name', val: payload.name });
        if (payload.account_type !== undefined) accountFields.push({ col: 'account_type', val: payload.account_type });
        if (payload.currency !== undefined) accountFields.push({ col: 'currency', val: payload.currency });
        if (payload.initial_balance !== undefined) accountFields.push({ col: 'initial_balance', val: payload.initial_balance });
        if (payload.note !== undefined) accountFields.push({ col: 'note', val: payload.note });
        if (payload.credit_limit !== undefined) accountFields.push({ col: 'credit_limit', val: payload.credit_limit });
        if (payload.billing_day !== undefined) accountFields.push({ col: 'billing_day', val: payload.billing_day });
        if (payload.payment_due_day !== undefined) accountFields.push({ col: 'payment_due_day', val: payload.payment_due_day });
        if (payload.bank_name !== undefined) accountFields.push({ col: 'bank_name', val: payload.bank_name });
        if (payload.card_last_four !== undefined) accountFields.push({ col: 'card_last_four', val: payload.card_last_four });
        if ((payload as any).hidden !== undefined) accountFields.push({ col: 'hidden', val: (payload as any).hidden ? 1 : 0 });

        if (existing) {
          // UPDATE 只更新提供的字段
          if (accountFields.length > 0) {
            accountFields.push({ col: 'source_change_id', val: change.change_id });
            const sets = accountFields.map(f => `${f.col} = ?`).join(', ');
            const vals = accountFields.map(f => f.val);
            vals.push(ledgerId, change.entity_sync_id);
            await db
              .prepare(`UPDATE read_account_projection SET ${sets} WHERE ledger_id = ? AND sync_id = ?`)
              .bind(...vals)
              .run();
          }
        } else {
          // INSERT 需要所有字段，用默认值填充
          await db
            .prepare(
              `INSERT INTO read_account_projection
               (ledger_id, sync_id, user_id, name, account_type, currency, initial_balance,
                note, credit_limit, billing_day, payment_due_day, bank_name, card_last_four, hidden, source_change_id)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .bind(
              ledgerId,
              change.entity_sync_id,
              userId,
              payload.name ?? null,
              payload.account_type ?? null,
              payload.currency ?? null,
              payload.initial_balance ?? 0,
              payload.note ?? null,
              payload.credit_limit ?? null,
              payload.billing_day ?? null,
              payload.payment_due_day ?? null,
              payload.bank_name ?? null,
              payload.card_last_four ?? null,
              (payload as any).hidden ?? null,
              change.change_id,
            )
            .run();
        }
      }
      break;
    }

    case 'category': {
      if (change.action === 'delete') {
        await db
          .prepare('DELETE FROM read_category_projection WHERE ledger_id = ? AND sync_id = ?')
          .bind(ledgerId, change.entity_sync_id)
          .run();
      } else {
        const existing = await db
          .prepare('SELECT sync_id FROM read_category_projection WHERE ledger_id = ? AND sync_id = ?')
          .bind(ledgerId, change.entity_sync_id)
          .first();

        if (existing) {
          await db
            .prepare(
              `UPDATE read_category_projection SET
               name = ?, kind = ?, level = ?, sort_order = ?,
               icon = ?, icon_type = ?, custom_icon_path = ?,
               icon_cloud_file_id = ?, icon_cloud_sha256 = ?,
               parent_name = ?, source_change_id = ?
               WHERE ledger_id = ? AND sync_id = ?`
            )
            .bind(
              payload.name ?? null,
              payload.kind ?? null,
              payload.level ?? null,
              payload.sort_order ?? null,
              payload.icon ?? null,
              payload.icon_type ?? null,
              payload.custom_icon_path ?? null,
              payload.icon_cloud_file_id ?? null,
              payload.icon_cloud_sha256 ?? null,
              payload.parent_name ?? null,
              change.change_id,
              ledgerId,
              change.entity_sync_id,
            )
            .run();
        } else {
          await db
            .prepare(
              `INSERT INTO read_category_projection
               (ledger_id, sync_id, user_id, name, kind, level, sort_order,
                icon, icon_type, custom_icon_path, icon_cloud_file_id, icon_cloud_sha256,
                parent_name, source_change_id)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .bind(
              ledgerId,
              change.entity_sync_id,
              userId,
              payload.name ?? null,
              payload.kind ?? null,
              payload.level ?? null,
              payload.sort_order ?? null,
              payload.icon ?? null,
              payload.icon_type ?? null,
              payload.custom_icon_path ?? null,
              payload.icon_cloud_file_id ?? null,
              payload.icon_cloud_sha256 ?? null,
              payload.parent_name ?? null,
              change.change_id,
            )
            .run();
        }
      }
      break;
    }

    case 'tag': {
      if (change.action === 'delete') {
        await db
          .prepare('DELETE FROM read_tag_projection WHERE ledger_id = ? AND sync_id = ?')
          .bind(ledgerId, change.entity_sync_id)
          .run();
      } else {
        const existing = await db
          .prepare('SELECT sync_id FROM read_tag_projection WHERE ledger_id = ? AND sync_id = ?')
          .bind(ledgerId, change.entity_sync_id)
          .first();

        if (existing) {
          await db
            .prepare(
              `UPDATE read_tag_projection SET
               name = ?, color = ?, source_change_id = ?
               WHERE ledger_id = ? AND sync_id = ?`
            )
            .bind(
              payload.name ?? null,
              payload.color ?? null,
              change.change_id,
              ledgerId,
              change.entity_sync_id,
            )
            .run();
        } else {
          await db
            .prepare(
              `INSERT INTO read_tag_projection
               (ledger_id, sync_id, user_id, name, color, source_change_id)
               VALUES (?, ?, ?, ?, ?, ?)`
            )
            .bind(
              ledgerId,
              change.entity_sync_id,
              userId,
              payload.name ?? null,
              payload.color ?? null,
              change.change_id,
            )
            .run();
        }
      }
      break;
    }

    case 'budget': {
      if (change.action === 'delete') {
        await db.batch([
          db.prepare('DELETE FROM read_budget_projection WHERE ledger_id = ? AND sync_id = ?')
            .bind(ledgerId, change.entity_sync_id),
          db.prepare(
            `DELETE FROM sync_changes WHERE ledger_id = ? AND entity_type = 'budget' AND entity_sync_id = ? AND action != 'delete'`
          ).bind(ledgerId, change.entity_sync_id),
        ]);
      } else {
        // 合并已有行（与原版 _merge_from_spec 对齐）
        const existing = await db.prepare(
          'SELECT budget_type, category_sync_id, amount, period, start_day, enabled FROM read_budget_projection WHERE ledger_id = ? AND sync_id = ?'
        ).bind(ledgerId, change.entity_sync_id).first<{ budget_type: string; category_sync_id: string | null; amount: number; period: string; start_day: number; enabled: number }>();

        const merged = {
          budget_type: (payload as any).type ?? existing?.budget_type ?? 'total',
          category_sync_id: (payload as any).categoryId ?? existing?.category_sync_id ?? null,
          amount: (payload as any).amount ?? existing?.amount ?? 0,
          period: (payload as any).period ?? existing?.period ?? 'monthly',
          start_day: (payload as any).startDay ?? existing?.start_day ?? 1,
          enabled: (payload as any).enabled ?? (existing ? existing.enabled === 1 : true),
        };

        await db
          .prepare(
            `INSERT OR REPLACE INTO read_budget_projection
             (ledger_id, sync_id, user_id, budget_type, category_sync_id, amount,
              period, start_day, enabled, source_change_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(
            ledgerId,
            change.entity_sync_id,
            userId,
            merged.budget_type,
            merged.category_sync_id,
            merged.amount,
            merged.period,
            merged.start_day,
            merged.enabled ? 1 : 0,
            change.change_id,
          )
          .run();
      }
      break;
    }

    case 'attachment': {
      if (change.action === 'delete') {
        await db
          .prepare('DELETE FROM attachment_files WHERE id = ?')
          .bind(change.entity_sync_id)
          .run();
      }
      break;
    }

    case 'exchange_rate_override': {
      if (change.action === 'delete') {
        await db
          .prepare('DELETE FROM exchange_rate_overrides WHERE user_id = ? AND sync_id = ?')
          .bind(userId, change.entity_sync_id)
          .run();
      } else {
        const baseCurrency = (payload as any).baseCurrency ?? '';
        const quoteCurrency = (payload as any).quoteCurrency ?? '';
        const existing = await db
          .prepare('SELECT base_currency FROM exchange_rate_overrides WHERE user_id = ? AND base_currency = ? AND quote_currency = ?')
          .bind(userId, baseCurrency, quoteCurrency)
          .first();

        if (existing) {
          await db
            .prepare('UPDATE exchange_rate_overrides SET rate = ?, updated_at = ? WHERE user_id = ? AND base_currency = ? AND quote_currency = ?')
            .bind((payload as any).rate ?? 1, new Date().toISOString(), userId, baseCurrency, quoteCurrency)
            .run();
        } else {
          await db
            .prepare('INSERT INTO exchange_rate_overrides (user_id, base_currency, quote_currency, rate, updated_at) VALUES (?, ?, ?, ?, ?)')
            .bind(userId, baseCurrency, quoteCurrency, (payload as any).rate ?? 1, new Date().toISOString())
            .run();
        }
      }
      break;
    }
  }
}

export default syncRouter;