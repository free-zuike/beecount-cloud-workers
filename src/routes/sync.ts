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

const USER_GLOBAL_TYPES = ['category', 'account', 'tag'];

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
  device_id: z.string().optional(),
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
};

// ===========================
// 类型定义
// ===========================

type Bindings = {
  DB: D1Database;
  JWT_SECRET: string;
  BEECOUNT_DO: DurableObjectNamespace;
  R2?: R2Bucket;
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
  console.log(`[SYNC] ===== ${CODE_VERSION} START =====`);
  try {
    console.log('[SYNC] /sync/push started');
    const userId = c.get('userId');
    console.log('[SYNC] userId:', userId);
    const db = c.env.DB;
    const req = c.req.valid('json');
    const entityCounts: Record<string, number> = {};
    for (const ch of (req.changes || [])) {
      entityCounts[ch.entity_type] = (entityCounts[ch.entity_type] || 0) + 1;
    }
    console.log('[SYNC] changes count:', req.changes?.length, 'by_type:', JSON.stringify(entityCounts));
    
    // 调试：打印第一条变更的字段名
    if (req.changes && req.changes.length > 0) {
      const first = req.changes[0];
      console.log('[SYNC] first change keys:', Object.keys(first));
      console.log('[SYNC] first change payload type:', typeof first.payload, 'is_null:', first.payload === null);
      console.log('[SYNC] first change entity_sync_id:', first.entity_sync_id, 'type:', typeof first.entity_sync_id);
      console.log('[SYNC] first change action:', first.action, 'type:', typeof first.action);
      console.log('[SYNC] first change ledger_id:', first.ledger_id, 'type:', typeof first.ledger_id);
    }
    
    const serverNow = nowUtc();

    // 处理 device_id - 如果未提供，尝试从 header 获取或使用默认值
    const deviceId = req.device_id || c.req.header('X-Device-ID') || 'unknown';
    console.log('[SYNC] deviceId:', deviceId);

    // 验证设备有效性（设备必须属于当前用户且未被撤销）
    const device = await db
      .prepare(
        `SELECT id FROM devices
         WHERE id = ? AND user_id = ? AND revoked_at IS NULL`
      )
      .bind(deviceId, userId)
      .first();

    console.log('[SYNC] device check result:', device);

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
    console.log('[SYNC] ledgerExternalIds:', ledgerExternalIds);
    const ledgerMap: Record<string, { id: string; user_id: string; external_id: string }> = {};
    
    if (ledgerExternalIds.length > 0) {
      const ledgerPlaceholders = ledgerExternalIds.map(() => '?').join(',');
      console.log('[SYNC] Querying ledgers with placeholders:', ledgerPlaceholders);
      const existingLedgers = await db
        .prepare(
          `SELECT id, user_id, external_id FROM ledgers
           WHERE user_id = ? AND external_id IN (${ledgerPlaceholders})`
        )
        .bind(userId, ...ledgerExternalIds)
        .all<{ id: string; user_id: string; external_id: string }>();
      
      console.log('[SYNC] existingLedgers found:', existingLedgers.results.length);
      for (const ledger of existingLedgers.results) {
        ledgerMap[ledger.external_id] = ledger;
      }
      
      // 创建不存在的账本（批量）
      for (const externalId of ledgerExternalIds) {
        if (!ledgerMap[externalId]) {
          console.log('[SYNC] Creating new ledger:', externalId);
          const newLedgerId = randomUUID();
          await db
            .prepare(
              `INSERT INTO ledgers (id, user_id, external_id, name, currency, created_at)
               VALUES (?, ?, ?, ?, 'CNY', ?)`
            )
            .bind(newLedgerId, userId, externalId, externalId, serverNow)
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
    console.log('[SYNC] ledgerMap keys:', Object.keys(ledgerMap));

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
      console.log('[SYNC] Split valid entries into', batches.length, 'batches');

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
        
        console.log('[SYNC] Querying batch', batchIdx + 1, '/', batches.length, 'with', params.length, 'params');
        const existingChanges = await db
          .prepare(query)
          .bind(...params)
          .all<{ ledger_id: string; entity_type: string; entity_sync_id: string; change_id: number; updated_at: string; updated_by_device_id: string | null }>();
        
        console.log('[SYNC] Batch', batchIdx + 1, 'found', existingChanges.results.length, 'changes');
        for (const change of existingChanges.results) {
          const key = `${change.ledger_id}:${change.entity_type}:${change.entity_sync_id}`;
          existingChangeMap.set(key, change);
        }
      }
    }
    console.log('[SYNC] existingChangeMap size:', existingChangeMap.size);

    // 补充查询 user-global 变更（category/account/tag 不依附 ledger）
    const USER_GLOBAL_TYPES = ['category', 'account', 'tag'];
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
    console.log('[SYNC] existingChangeMap size after user-global:', existingChangeMap.size);

    // ====================== 优化3：批量写入变更（分小批次避免 CPU 超时） ======================
    const conflictList: typeof conflictSamples = [];
    const BATCH_INSERT_SIZE = 15; // 每批处理 15 个插入

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

    for (let startIdx = 0; startIdx < changes.length; startIdx += BATCH_INSERT_SIZE) {
      const batchChanges = changes.slice(startIdx, startIdx + BATCH_INSERT_SIZE);
      console.log('[SYNC] Processing insertion batch', Math.floor(startIdx / BATCH_INSERT_SIZE) + 1, 'with', batchChanges.length, 'changes');
      
      // 打印前3条变更的详情（调试用）
      if (startIdx === 0) {
        for (const ch of batchChanges.slice(0, 3)) {
          console.log('[SYNC] sample change:', JSON.stringify({
            entity_type: ch.entity_type,
            ledger_id: ch.ledger_id,
            entity_sync_id: ch.entity_sync_id,
            action: ch.action,
            updated_at: ch.updated_at,
          }));
        }
      }
      
      const insertPromises: Array<{
        result: Promise<{ meta: { last_row_id: number } }>;
        change: typeof changes[0];
        ledgerRow: typeof ledgerMap[string] | null;
      }> = [];

      for (const change of batchChanges) {
        // user-global 实体：category/account/tag 可以不依附 ledger
        const USER_GLOBAL_TYPES = ['category', 'account', 'tag'];
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
            console.log('[SYNC] SKIPPED - ledger not found for', change.entity_type, 'ledger_id:', change.ledger_id);
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
          console.log('[SYNC] REJECTED - older change:', change.entity_type, change.entity_sync_id, 'server_ts:', existingTuple.ts, 'incoming_ts:', incomingTuple.ts);
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
          // 原版对齐：冲突写审计日志
          await insertAuditLog({
            db, userId,
            ledgerId: isUserGlobal ? null : (ledgerRowId ?? null),
            action: 'sync_push',
            entityType: 'sync_conflict',
            details: {
              ...conflictSample,
              incomingUpdatedAt: clampedUpdatedAt.toISOString(),
              existingUpdatedAt: new Date(existingTuple.ts).toISOString(),
              incomingDeviceId: deviceId,
              existingDeviceId: existingTuple.deviceId,
            },
          });
          continue;
        }

        // 完全相同的 (ts, device_id) → 幂等重放
        if (existingTuple && existingTuple.ts === incomingTuple.ts && existingTuple.deviceId === incomingTuple.deviceId) {
          accepted++;
          console.log('[SYNC] IDEMPOTENT - same (ts,device):', change.entity_type, change.entity_sync_id);
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

        // 添加到批量插入
        const bindParams = [
            userId,
            isUserGlobal ? null : (ledgerRowId ?? null),
            change.entity_type ?? '',
            change.entity_sync_id ?? '',
            change.action ?? 'upsert',
            safeJsonStringify(payloadForStorage ?? {}),
            clampedUpdatedAt.toISOString(),
            deviceId ?? 'unknown',
            userId,
            scope ?? 'ledger',
        ];
        // 检查是否有 undefined 值
        for (let i = 0; i < bindParams.length; i++) {
          if (bindParams[i] === undefined) {
            console.error('[SYNC] UNDEFINED at bind index', i, 'for change:', change.entity_type, change.entity_sync_id);
          }
        }
        insertPromises.push({
          result: db.prepare(
            `INSERT INTO sync_changes
             (user_id, ledger_id, entity_type, entity_sync_id, action, payload_json, updated_at, updated_by_device_id, updated_by_user_id, scope)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).bind(...bindParams).run(),
          change,
          ledgerRow: isUserGlobal ? null : { id: ledgerRowId as string, user_id: userId, external_id: '' },
        });

        if (!isUserGlobal && ledgerRowId) {
          touchedLedgers[ledgerMap[change.ledger_id as string]?.external_id ?? (change.ledger_id as string)] = ledgerRowId;
        }

        // 追踪 user-global 变更（与原版对齐：push 后广播 __user_global__ 通道）
        if (isUserGlobal) {
          touchedUserGlobal = true;
          // 共享账本 fan-out：仅对 category/account/tag 推 shared_resource_change
          if (USER_GLOBAL_TYPES.includes(change.entity_type)) {
            pendingSharedResourceEvents.push({
              resource_type: change.entity_type,
              action: change.action,
              sync_id: change.entity_sync_id,
              payload: change.payload || { sync_id: change.entity_sync_id },
            });
          }
        }
      }

      // 执行这一批次的插入
      if (insertPromises.length > 0) {
        const results = await Promise.all(insertPromises.map(p => p.result));
        accepted += results.length;
        
        // 记录处理的变更以便后续应用投影
        for (let i = 0; i < insertPromises.length; i++) {
          const { change, ledgerRow } = insertPromises[i];
          const changeId = results[i].meta.last_row_id as number;
          maxCursor = Math.max(maxCursor, changeId);
          processedChanges.push({ change, ledgerRow, newChangeId: changeId });
        }

        // 立即应用这一批次的投影更新（避免一次性处理太多）
        for (const { change, ledgerRow, newChangeId } of processedChanges) {
          try {
            if (isUserGlobalType(change.entity_type)) {
              await applyUserChangeToProjection(db, userId, {
                change_id: newChangeId,
                entity_type: change.entity_type,
                entity_sync_id: change.entity_sync_id,
                action: change.action,
                payload: change.payload,
              }, c.env.R2);
            } else if (ledgerRow) {
              await applyChangeToProjection(db, ledgerRow.id, userId, {
                change_id: newChangeId,
                entity_type: change.entity_type,
                entity_sync_id: change.entity_sync_id,
                action: change.action,
                payload: change.payload,
                ledger_id: ledgerRow.id,
              });
            }
          } catch (err) {
            console.error('[SYNC] Error applying change to projection:', err);
          }
        }
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
    };

    console.log('[SYNC] /sync/push result - accepted:', accepted, 'rejected:', rejected, 'conflicts:', conflictCount, 'server_cursor:', maxCursor);
    console.log(`[SYNC] ===== ${CODE_VERSION} SUCCESS =====`);

    // 统计最终状态
    const totalChanges = await db.prepare('SELECT COUNT(*) as cnt FROM sync_changes WHERE user_id = ?').bind(userId).first<{ cnt: number }>();
    const categoryCount = await db.prepare("SELECT COUNT(*) as cnt FROM sync_changes WHERE user_id = ? AND entity_type = 'category'").bind(userId).first<{ cnt: number }>();
    console.log('[SYNC] DB totals - all_changes:', totalChanges?.cnt, 'categories:', categoryCount?.cnt);

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
        console.log('[SYNC] DO broadcast failed (non-fatal):', e);
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
        console.log('[SYNC] shared_resource fan-out failed (non-fatal):', e);
      }
    }

    return c.json(response);
  } catch (error: any) {
    // Zod 验证错误返回详细信息
    if (error?.name === 'ZodError' || error?.issues) {
      console.error('[SYNC] /sync/push validation error:', JSON.stringify(error.issues || error));
      return c.json({ error: 'Validation failed', details: error.issues || error.message }, 400);
    }
    console.error('[SYNC] /sync/push error - BEGIN ====================================');
    console.error('[SYNC] error:', error);
    console.error('[SYNC] typeof error:', typeof error);
    try {
      console.error('[SYNC] stringified error:', JSON.stringify(error));
    } catch (e) {
      console.error('[SYNC] JSON.stringify failed');
    }
    if (error instanceof Error) {
      console.error('[SYNC] Error message:', error.message);
      console.error('[SYNC] Error stack:', error.stack);
    }
    console.error('[SYNC] /sync/push error - END ======================================');
    console.log(`[SYNC] ===== ${CODE_VERSION} ERROR =====`);
    
    return c.json({ 
      error: 'Internal server error',
      message: error instanceof Error ? error.message : String(error)
    }, 500);
  }
});

// ---------------------------------------------------------------------------
// GET /sync/debug - 诊断同步状态
// ---------------------------------------------------------------------------

syncRouter.get('/debug', async (c) => {
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
// GET /sync/pull - 增量拉取：客户端按游标拉取服务端变更
// ---------------------------------------------------------------------------

syncRouter.get('/pull', async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  
  const since = parseInt(c.req.query('since') ?? '0');
  const limit = Math.min(parseInt(c.req.query('limit') ?? '1000', 10), 5000);
  const ledgerId = c.req.query('ledger_id');
  const deviceId = c.req.query('device_id');

  console.log('[SYNC] /sync/pull since:', since, 'limit:', limit, 'ledger_id:', ledgerId, 'device_id:', deviceId);

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

    let query = `
      SELECT c.change_id, c.entity_type, c.entity_sync_id, c.action, c.payload_json, c.updated_at, c.updated_by_device_id, c.scope, l.external_id as ledger_id
      FROM sync_changes c
      LEFT JOIN ledgers l ON c.ledger_id = l.id
      WHERE c.user_id = ?
        AND (
          (c.scope = 'user' AND c.change_id > ?)
          OR (c.scope = 'ledger' AND c.change_id > ?)
        )
    `;
    
    const params: (string | number)[] = [userId, since, since];
    
    if (ledgerId) {
      query += ' AND (l.external_id = ? OR c.scope = \'user\')';
      params.push(ledgerId);
    }

    // 注意：不再用 updated_by_device_id 过滤设备自身变更
    // 在无 WebSocket 推送的环境下，设备需要能看到自己推送的变更
    // 重复处理由客户端游标 (since) 防止
    
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
    await enrichTxPayloadsWithUserIds(db, limitedResults);

    const resultTypeCounts: Record<string, number> = {};
    for (const r of limitedResults) {
      resultTypeCounts[r.entity_type] = (resultTypeCounts[r.entity_type] || 0) + 1;
    }
    console.log('[SYNC] /sync/pull returning:', limitedResults.length, 'changes, has_more:', hasMore, 'by_type:', JSON.stringify(resultTypeCounts));

    // 写回 SyncCursor（per-device per-ledger 游标持久化）
    if (deviceId && limitedResults.length > 0) {
      const perLedgerCursor: Record<string, number> = {};
      for (const r of limitedResults) {
        const lid = r.ledger_id ?? '__global__';
        perLedgerCursor[lid] = Math.max(perLedgerCursor[lid] ?? 0, r.change_id);
      }
      const now = new Date().toISOString();
      for (const [ledgerExtId, lastCursor] of Object.entries(perLedgerCursor)) {
        await db.prepare(`INSERT INTO sync_cursors (user_id, device_id, ledger_external_id, last_cursor, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id, device_id, ledger_external_id) DO UPDATE SET last_cursor = ?, updated_at = ?`)
          .bind(userId, deviceId, ledgerExtId, lastCursor, now, lastCursor, now).run();
      }
    }

    return c.json({
      changes: limitedResults.map(c => ({
        change_id: c.change_id,
        ledger_id: c.scope === 'user' ? '__user_global__' : (c.ledger_id ?? ''),
        entity_type: c.entity_type,
        entity_sync_id: c.entity_sync_id,
        action: c.action,
        payload: c.payload_json ? JSON.parse(c.payload_json) : {},
        updated_at: c.updated_at,
        updated_by_device_id: c.updated_by_device_id ?? null,
        scope: c.scope || 'ledger',
      })),
      server_cursor: serverCursor,
      has_more: hasMore,
    });
  } catch (error) {
    console.error('[SYNC] /sync/pull error:', error);
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
    const ledgers = await db
      .prepare(`SELECT id, external_id, name, currency, created_at FROM ledgers WHERE user_id = ?`)
      .bind(userId)
      .all<{ id: string; external_id: string; name: string; currency: string; created_at: string }>();

    const result: Array<Record<string, unknown>> = [];

    for (const l of ledgers.results) {
      // 软删除检查：最后一个 ledger_snapshot delete tombstone
      const tombstone = await db
        .prepare(`SELECT action FROM sync_changes WHERE ledger_id = ? AND entity_type = 'ledger_snapshot' AND action = 'delete' ORDER BY change_id DESC LIMIT 1`)
        .bind(l.id)
        .first<{ action: string }>();
      if (tombstone?.action === 'delete') continue;

      // 检查是否有任何变更
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
        updated_at: latestUpdated?.updated_at ?? l.created_at,
        size: 512 + (txCount?.cnt ?? 0) * 300,
        metadata: { source: 'lazy_rebuild' },
        role: 'owner',
      });
    }

    return c.json(result);
  } catch (error) {
    console.error('[SYNC] /sync/ledgers error:', error);
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
    if (!ledgerChangeId?.max_id) {
      return c.json({ ledger_id: ledgerId, snapshot: null, latest_cursor: latestCursor });
    }

    const [txs, accounts, categories, tags, budgets] = await Promise.all([
      db.prepare('SELECT * FROM read_tx_projection WHERE ledger_id = ?').bind(ledger.id).all(),
      db.prepare('SELECT * FROM read_account_projection WHERE user_id = ?').bind(userId).all(),
      db.prepare('SELECT * FROM read_category_projection WHERE user_id = ?').bind(userId).all(),
      db.prepare('SELECT * FROM read_tag_projection WHERE user_id = ?').bind(userId).all(),
      db.prepare('SELECT * FROM read_budget_projection WHERE ledger_id = ?').bind(ledger.id).all(),
    ]);

    // 检查缓存（与原版 snapshot_cache 对齐）
    let snapshot = snapshotCacheGet(ledger.id, latestCursor) as Record<string, unknown> | null;
    if (!snapshot) {
      snapshot = {
        ledgerSyncId: ledger.external_id,
        ledgerName: ledger.name || ledger.external_id,
        currency: ledger.currency || 'CNY',
        monthStartDay: ledger.month_start_day || 1,
        count: txs.results.length,
        items: txs.results,
        accounts: accounts.results,
        categories: categories.results,
        tags: tags.results,
        budgets: budgets.results,
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
      },
    });
  } catch (error) {
    console.error('[SYNC] /sync/full error:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// ---------------------------------------------------------------------------
// applyUserChangeToProjection - 应用 user-global 变更到投影表
// ---------------------------------------------------------------------------

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
): Promise<void> {
  const { entity_type, entity_sync_id, action, payload } = change;

  if (action === 'delete') {
    if (entity_type === 'category') {
      // 删除前清理分类图标 R2 文件（与原版 gc_orphan_attachments 对齐）
      if (r2) {
        try {
          const catIcon = await db.prepare(
            'SELECT icon_cloud_file_id FROM read_category_projection WHERE sync_id = ? AND user_id = ?'
          ).bind(entity_sync_id, userId).first<{ icon_cloud_file_id: string | null }>();
          if (catIcon?.icon_cloud_file_id) {
            const fileId = catIcon.icon_cloud_file_id;
            // 先删 projection 行（gc_orphan 要求目标行已删后再调）
            await db.prepare('DELETE FROM read_category_projection WHERE sync_id = ? AND user_id = ?')
              .bind(entity_sync_id, userId).run();
            // 检查是否仍被其他 category 引用
            const stillUsed = await db.prepare(
              'SELECT COUNT(*) as cnt FROM read_category_projection WHERE icon_cloud_file_id = ? AND user_id = ?'
            ).bind(fileId, userId).first<{ cnt: number }>();
            if (!stillUsed || stillUsed.cnt === 0) {
              // 无引用，安全删除 R2 + attachment_files
              const iconRow = await db.prepare(
                "SELECT storage_path FROM attachment_files WHERE id = ? AND attachment_kind = 'category_icon'"
              ).bind(fileId).first<{ storage_path: string }>();
              if (iconRow?.storage_path && r2) {
                try { await r2.delete(iconRow.storage_path); } catch {}
              }
              await db.prepare('DELETE FROM attachment_files WHERE id = ?').bind(fileId).run();
            }
          } else {
            // 无图标，只删 projection 行
            await db.prepare('DELETE FROM read_category_projection WHERE sync_id = ? AND user_id = ?')
              .bind(entity_sync_id, userId).run();
          }
        } catch {
          await db.prepare('DELETE FROM read_category_projection WHERE sync_id = ? AND user_id = ?')
            .bind(entity_sync_id, userId).run();
        }
      } else {
        await db.prepare('DELETE FROM read_category_projection WHERE sync_id = ? AND user_id = ?')
          .bind(entity_sync_id, userId).run();
      }
    } else if (entity_type === 'account') {
      await db.prepare('DELETE FROM read_account_projection WHERE sync_id = ? AND user_id = ?')
        .bind(entity_sync_id, userId).run();
    } else if (entity_type === 'tag') {
      await db.prepare('DELETE FROM read_tag_projection WHERE sync_id = ? AND user_id = ?')
        .bind(entity_sync_id, userId).run();
    }
    // 与原版 _compact_entity_upsert_events 对齐：实体删除后清掉 upsert 历史，只留 delete 事件
    await db.prepare(
      `DELETE FROM sync_changes WHERE user_id = ? AND entity_type = ? AND entity_sync_id = ? AND action != 'delete'`
    ).bind(userId, entity_type, entity_sync_id).run();
    return;
  }

  if (entity_type === 'category') {
    // Rename cascade：名称变化时级联更新 read_tx_projection 的 denorm 列
    const newName = (payload.name as string) ?? null;
    if (newName) {
      const prevRow = await db.prepare('SELECT name, kind FROM read_category_projection WHERE sync_id = ? AND user_id = ?')
        .bind(entity_sync_id, userId).first<{ name: string | null; kind: string | null }>();
      const oldName = prevRow?.name;
      if (oldName && oldName !== newName) {
        await db.prepare('UPDATE read_tx_projection SET category_name = ?, category_kind = ? WHERE user_id = ? AND category_sync_id = ?')
          .bind(newName, payload.kind ?? prevRow?.kind ?? null, userId, entity_sync_id).run();
      }
    }

    // APP 用 camelCase (parentName)，原版用 snake_case (parent_name)
    const parentName = (payload as any).parentName ?? payload.parent_name ?? null;
    const sortOrder = (payload as any).sortOrder ?? payload.sort_order ?? null;
    const iconType = (payload as any).iconType ?? payload.icon_type ?? null;
    const customIconPath = (payload as any).customIconPath ?? payload.custom_icon_path ?? null;
    const iconCloudFileId = (payload as any).iconCloudFileId ?? payload.icon_cloud_file_id ?? null;
    const iconCloudSha256 = (payload as any).iconCloudSha256 ?? payload.icon_cloud_sha256 ?? null;

    // merge_with_existing：payload 缺失/None 的字段用已有行的旧值补齐
    const existingRow = await db.prepare(
      'SELECT name, kind, level, sort_order, icon, icon_type, custom_icon_path, icon_cloud_file_id, icon_cloud_sha256, parent_name FROM read_category_projection WHERE sync_id = ? AND user_id = ?'
    ).bind(entity_sync_id, userId).first<{
      name: string | null; kind: string | null; level: number | null;
      sort_order: number | null; icon: string | null; icon_type: string | null;
      custom_icon_path: string | null; icon_cloud_file_id: string | null;
      icon_cloud_sha256: string | null; parent_name: string | null;
    }>();

    const merged = {
      name: payload.name ?? existingRow?.name ?? null,
      kind: payload.kind ?? existingRow?.kind ?? null,
      level: payload.level ?? existingRow?.level ?? null,
      sort_order: sortOrder ?? existingRow?.sort_order ?? null,
      icon: payload.icon ?? existingRow?.icon ?? null,
      icon_type: iconType ?? existingRow?.icon_type ?? null,
      custom_icon_path: customIconPath ?? existingRow?.custom_icon_path ?? null,
      icon_cloud_file_id: iconCloudFileId ?? existingRow?.icon_cloud_file_id ?? null,
      icon_cloud_sha256: iconCloudSha256 ?? existingRow?.icon_cloud_sha256 ?? null,
      parent_name: parentName ?? existingRow?.parent_name ?? null,
    };

    if (existingRow) {
      await db.prepare(
        `UPDATE read_category_projection SET name=?, kind=?, level=?, sort_order=?,
         icon=?, icon_type=?, custom_icon_path=?, icon_cloud_file_id=?, icon_cloud_sha256=?,
         parent_name=?, source_change_id=?
         WHERE sync_id=? AND user_id=?`
      ).bind(
        merged.name, merged.kind, merged.level, merged.sort_order,
        merged.icon, merged.icon_type, merged.custom_icon_path,
        merged.icon_cloud_file_id, merged.icon_cloud_sha256,
        merged.parent_name, change.change_id ?? 0,
        entity_sync_id, userId
      ).run();
    } else {
      await db.prepare(
        `INSERT INTO read_category_projection
         (ledger_id, sync_id, user_id, name, kind, level, sort_order,
          icon, icon_type, custom_icon_path, icon_cloud_file_id, icon_cloud_sha256,
          parent_name, source_change_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        null, entity_sync_id, userId, merged.name, merged.kind,
        merged.level, merged.sort_order, merged.icon, merged.icon_type,
        merged.custom_icon_path, merged.icon_cloud_file_id, merged.icon_cloud_sha256,
        merged.parent_name, change.change_id ?? 0
      ).run();
    }
  } else if (entity_type === 'account') {
    // Rename cascade：名称变化时级联更新 read_tx_projection 的 account_name 等列
    const newName = (payload.name as string) ?? null;
    if (newName) {
      const prevRow = await db.prepare('SELECT name FROM read_account_projection WHERE sync_id = ? AND user_id = ?')
        .bind(entity_sync_id, userId).first<{ name: string | null }>();
      const oldName = prevRow?.name;
      if (oldName && oldName !== newName) {
        await db.prepare('UPDATE read_tx_projection SET account_name = ? WHERE user_id = ? AND account_sync_id = ?')
          .bind(newName, userId, entity_sync_id).run();
        await db.prepare('UPDATE read_tx_projection SET from_account_name = ? WHERE user_id = ? AND from_account_sync_id = ?')
          .bind(newName, userId, entity_sync_id).run();
        await db.prepare('UPDATE read_tx_projection SET to_account_name = ? WHERE user_id = ? AND to_account_sync_id = ?')
          .bind(newName, userId, entity_sync_id).run();
      }
    }

    // APP 用 camelCase，原版用 snake_case
    const accountType = (payload as any).accountType ?? payload.account_type ?? (payload as any).type ?? null;
    const initialBalance = (payload as any).initialBalance ?? payload.initial_balance ?? 0;
    const creditLimit = (payload as any).creditLimit ?? payload.credit_limit ?? null;
    const billingDay = (payload as any).billingDay ?? payload.billing_day ?? null;
    const paymentDueDay = (payload as any).paymentDueDay ?? payload.payment_due_day ?? null;
    const bankName = (payload as any).bankName ?? payload.bank_name ?? null;
    const cardLastFour = (payload as any).cardLastFour ?? payload.card_last_four ?? null;

    // merge_with_existing
    const existingRow = await db.prepare(
      'SELECT name, account_type, currency, initial_balance, note, credit_limit, billing_day, payment_due_day, bank_name, card_last_four FROM read_account_projection WHERE sync_id = ? AND user_id = ?'
    ).bind(entity_sync_id, userId).first<{
      name: string | null; account_type: string | null; currency: string | null;
      initial_balance: number | null; note: string | null; credit_limit: number | null;
      billing_day: number | null; payment_due_day: number | null;
      bank_name: string | null; card_last_four: string | null;
    }>();

    const merged = {
      name: payload.name ?? existingRow?.name ?? null,
      account_type: accountType ?? existingRow?.account_type ?? null,
      currency: payload.currency ?? existingRow?.currency ?? null,
      initial_balance: initialBalance ?? existingRow?.initial_balance ?? 0,
      note: payload.note ?? existingRow?.note ?? null,
      credit_limit: creditLimit ?? existingRow?.credit_limit ?? null,
      billing_day: billingDay ?? existingRow?.billing_day ?? null,
      payment_due_day: paymentDueDay ?? existingRow?.payment_due_day ?? null,
      bank_name: bankName ?? existingRow?.bank_name ?? null,
      card_last_four: cardLastFour ?? existingRow?.card_last_four ?? null,
    };

    if (existingRow) {
      await db.prepare(
        `UPDATE read_account_projection SET name=?, account_type=?, currency=?, initial_balance=?,
         note=?, credit_limit=?, billing_day=?, payment_due_day=?, bank_name=?, card_last_four=?,
         source_change_id=?
         WHERE sync_id=? AND user_id=?`
      ).bind(
        merged.name, merged.account_type, merged.currency, merged.initial_balance,
        merged.note, merged.credit_limit, merged.billing_day, merged.payment_due_day,
        merged.bank_name, merged.card_last_four,
        change.change_id ?? 0, entity_sync_id, userId
      ).run();
    } else {
      await db.prepare(
        `INSERT INTO read_account_projection
         (ledger_id, sync_id, user_id, name, account_type, currency, initial_balance,
          note, credit_limit, billing_day, payment_due_day, bank_name, card_last_four, source_change_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        null, entity_sync_id, userId, merged.name, merged.account_type,
        merged.currency, merged.initial_balance, merged.note,
        merged.credit_limit, merged.billing_day,
        merged.payment_due_day, merged.bank_name,
        merged.card_last_four, change.change_id ?? 0
      ).run();
    }
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
      await db.prepare(
        `UPDATE read_tag_projection SET name=?, color=?, source_change_id=?
         WHERE sync_id=? AND user_id=?`
      ).bind(merged.name, merged.color, change.change_id, entity_sync_id, userId).run();
    } else {
      await db.prepare(
        `INSERT INTO read_tag_projection (ledger_id, sync_id, user_id, name, color, source_change_id)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).bind(null, entity_sync_id, userId, merged.name, merged.color, change.change_id ?? 0).run();
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
  }
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

  const payload = change.payload as Record<string, unknown>;

  switch (change.entity_type) {
    case 'transaction': {
      if (change.action === 'delete') {
        await db
          .prepare('DELETE FROM read_tx_projection WHERE ledger_id = ? AND sync_id = ?')
          .bind(ledgerId, change.entity_sync_id)
          .run();
        // 与原版 _compact_entity_upsert_events 对齐：清理 upsert 历史
        await db.prepare(
          `DELETE FROM sync_changes WHERE ledger_id = ? AND entity_type = 'transaction' AND entity_sync_id = ? AND action != 'delete'`
        ).bind(ledgerId, change.entity_sync_id).run();
      } else {
        const tagPayload = (payload.tags as string) ?? null;
        const tagIdsPayload = Array.isArray(payload.tagIds) ? payload.tagIds as string[] : null;
        const resolvedTagsCsv = await resolveTagsCsv(db, tagPayload, tagIdsPayload);

        const existing = await db
          .prepare('SELECT sync_id FROM read_tx_projection WHERE ledger_id = ? AND sync_id = ?')
          .bind(ledgerId, change.entity_sync_id)
          .first();

        if (existing) {
          await db
            .prepare(
              `UPDATE read_tx_projection SET
               tx_type = ?, amount = ?, happened_at = ?, note = ?,
               category_sync_id = ?, category_name = ?, category_kind = ?,
               account_sync_id = ?, account_name = ?,
               from_account_sync_id = ?, from_account_name = ?,
               to_account_sync_id = ?, to_account_name = ?,
               tags_csv = ?, tag_sync_ids_json = ?, attachments_json = ?,
               tx_index = ?, last_edited_by_user_id = ?, source_change_id = ?
               WHERE ledger_id = ? AND sync_id = ?`
            )
            .bind(
              payload.tx_type ?? payload.txType ?? payload.type ?? 'expense',
              payload.amount ?? 0,
              payload.happened_at ?? nowUtc(),
              payload.note ?? null,
              payload.categoryId ?? null,
              payload.categoryName ?? null,
              payload.categoryKind ?? null,
              payload.accountId ?? null,
              payload.accountName ?? null,
              payload.fromAccountId ?? null,
              payload.fromAccountName ?? null,
              payload.toAccountId ?? null,
              payload.toAccountName ?? null,
              resolvedTagsCsv,
              payload.tagIds ? safeJsonStringify(payload.tagIds) : null,
              payload.attachments ? safeJsonStringify(payload.attachments) : null,
              payload.tx_index ?? 0,
              payload.updatedByUserId ?? userId,
              change.change_id,
              ledgerId,
              change.entity_sync_id,
            )
            .run();
        } else {
          await db
            .prepare(
              `INSERT INTO read_tx_projection
               (ledger_id, sync_id, user_id, tx_type, amount, happened_at, note,
                category_sync_id, category_name, category_kind,
                account_sync_id, account_name,
                from_account_sync_id, from_account_name,
                to_account_sync_id, to_account_name,
                tags_csv, tag_sync_ids_json, attachments_json, tx_index,
                created_by_user_id, last_edited_by_user_id, source_change_id)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .bind(
              ledgerId,
              change.entity_sync_id,
              userId,
              payload.tx_type ?? payload.txType ?? payload.type ?? 'expense',
              payload.amount ?? 0,
              payload.happened_at ?? nowUtc(),
              payload.note ?? null,
              payload.categoryId ?? null,
              payload.categoryName ?? null,
              payload.categoryKind ?? null,
              payload.accountId ?? null,
              payload.accountName ?? null,
              payload.fromAccountId ?? null,
              payload.fromAccountName ?? null,
              payload.toAccountId ?? null,
              payload.toAccountName ?? null,
              resolvedTagsCsv,
              payload.tagIds ? safeJsonStringify(payload.tagIds) : null,
              payload.attachments ? safeJsonStringify(payload.attachments) : null,
              payload.tx_index ?? 0,
              payload.createdByUserId ?? userId,
              payload.updatedByUserId ?? userId,
              change.change_id,
            )
            .run();
        }
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
        const existing = await db
          .prepare('SELECT sync_id FROM read_account_projection WHERE ledger_id = ? AND sync_id = ?')
          .bind(ledgerId, change.entity_sync_id)
          .first();

        if (existing) {
          await db
            .prepare(
              `UPDATE read_account_projection SET
               name = ?, account_type = ?, currency = ?, initial_balance = ?,
               note = ?, credit_limit = ?, billing_day = ?, payment_due_day = ?,
               bank_name = ?, card_last_four = ?, source_change_id = ?
               WHERE ledger_id = ? AND sync_id = ?`
            )
            .bind(
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
              change.change_id,
              ledgerId,
              change.entity_sync_id,
            )
            .run();
        } else {
          await db
            .prepare(
              `INSERT INTO read_account_projection
               (ledger_id, sync_id, user_id, name, account_type, currency, initial_balance,
                note, credit_limit, billing_day, payment_due_day, bank_name, card_last_four, source_change_id)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        await db
          .prepare('DELETE FROM read_budget_projection WHERE ledger_id = ? AND sync_id = ?')
          .bind(ledgerId, change.entity_sync_id)
          .run();
        // 与原版 _compact_entity_upsert_events 对齐
        await db.prepare(
          `DELETE FROM sync_changes WHERE ledger_id = ? AND entity_type = 'budget' AND entity_sync_id = ? AND action != 'delete'`
        ).bind(ledgerId, change.entity_sync_id).run();
      } else {
        const existing = await db
          .prepare('SELECT sync_id FROM read_budget_projection WHERE ledger_id = ? AND sync_id = ?')
          .bind(ledgerId, change.entity_sync_id)
          .first();

        if (existing) {
          await db
            .prepare(
              `UPDATE read_budget_projection SET
               budget_type = ?, category_sync_id = ?, amount = ?,
               period = ?, start_day = ?, enabled = ?, source_change_id = ?
               WHERE ledger_id = ? AND sync_id = ?`
            )
            .bind(
              payload.budget_type ?? 'total',
              payload.category_sync_id ?? null,
              payload.amount ?? 0,
              payload.period ?? 'monthly',
              payload.start_day ?? 1,
              payload.enabled ?? true,
              change.change_id,
              ledgerId,
              change.entity_sync_id,
            )
            .run();
        } else {
          await db
            .prepare(
              `INSERT INTO read_budget_projection
               (ledger_id, sync_id, user_id, budget_type, category_sync_id, amount,
                period, start_day, enabled, source_change_id)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .bind(
              ledgerId,
              change.entity_sync_id,
              userId,
              payload.budget_type ?? 'total',
              payload.category_sync_id ?? null,
              payload.amount ?? 0,
              payload.period ?? 'monthly',
              payload.start_day ?? 1,
              payload.enabled ?? true,
              change.change_id,
            )
            .run();
        }
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
  }
}

export default syncRouter;