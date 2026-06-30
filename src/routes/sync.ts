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

// ===========================
// Schema 定义
// ===========================

const SyncPushRequestSchema = z.object({
  device_id: z.string().optional(),
  changes: z.array(
    z.object({
      ledger_id: z.string(),
      entity_type: z.string(),
      entity_sync_id: z.string(),
      action: z.enum(['upsert', 'delete']),
      payload: z.record(z.any()),
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
    console.log('[SYNC] changes count:', req.changes?.length);
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
    const ledgerExternalIds = [...new Set(changes.map(c => c.ledger_id))];
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
          ledgerId: ledgerMap[c.ledger_id]?.id,
          entity_type: c.entity_type,
          entity_sync_id: c.entity_sync_id,
        }))
        .filter(Boolean) as Array<{
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

    // ====================== 优化3：批量写入变更（分小批次避免 CPU 超时） ======================
    const conflictList: typeof conflictSamples = [];
    const BATCH_INSERT_SIZE = 15; // 每批处理 15 个插入
    const processedChanges: Array<{
      change: typeof changes[0];
      ledgerRow: typeof ledgerMap[string];
      newChangeId: number;
    }> = [];

    for (let startIdx = 0; startIdx < changes.length; startIdx += BATCH_INSERT_SIZE) {
      const batchChanges = changes.slice(startIdx, startIdx + BATCH_INSERT_SIZE);
      console.log('[SYNC] Processing insertion batch', Math.floor(startIdx / BATCH_INSERT_SIZE) + 1, 'with', batchChanges.length, 'changes');
      
      const insertPromises: Array<{
        result: Promise<{ meta: { last_row_id: number } }>;
        change: typeof changes[0];
        ledgerRow: typeof ledgerMap[string];
      }> = [];

      for (const change of batchChanges) {
        const ledgerRow = ledgerMap[change.ledger_id];
        if (!ledgerRow) continue;

        const changeUpdatedAt = toUtcDate(change.updated_at);
        const maxAllowed = new Date(new Date(serverNow).getTime() + 5000);
        const clampedUpdatedAt = changeUpdatedAt > maxAllowed ? maxAllowed : changeUpdatedAt;

        const key = `${ledgerRow.id}:${change.entity_type}:${change.entity_sync_id}`;
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
          if (conflictList.length < 20) {
            conflictList.push({
              reason: 'lww_rejected_older_change',
              ledgerId: change.ledger_id,
              entityType: change.entity_type,
              entitySyncId: change.entity_sync_id,
              existingChangeId: existingTuple.changeId,
            });
          }
          continue;
        }

        // 完全相同的 (ts, device_id) → 幂等重放
        if (existingTuple && existingTuple.ts === incomingTuple.ts && existingTuple.deviceId === incomingTuple.deviceId) {
          accepted++;
          continue;
        }

        // 添加到批量插入
        insertPromises.push({
          result: db.prepare(
            `INSERT INTO sync_changes
             (user_id, ledger_id, entity_type, entity_sync_id, action, payload_json, updated_at, updated_by_device_id, updated_by_user_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).bind(
            userId,
            ledgerRow.id,
            change.entity_type,
            change.entity_sync_id,
            change.action,
            safeJsonStringify(change.payload),
            clampedUpdatedAt.toISOString(),
            deviceId,
            userId,
          ).run(),
          change,
          ledgerRow,
        });

        touchedLedgers[ledgerRow.external_id] = ledgerRow.id;
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
            await applyChangeToProjection(db, ledgerRow.id, userId, {
              change_id: newChangeId,
              entity_type: change.entity_type,
              entity_sync_id: change.entity_sync_id,
              action: change.action,
              payload: change.payload,
              ledger_id: ledgerRow.id,
            });
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

    console.log('[SYNC] /sync/push returning with accepted:', accepted);
    console.log(`[SYNC] ===== ${CODE_VERSION} SUCCESS =====`);

    await insertAuditLog({
      db, userId, action: 'sync_push', entityType: 'sync',
      details: { accepted, rejected, conflict_count: conflictCount, device_id: deviceId },
    });

    return c.json(response);
  } catch (error) {
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
// GET /sync/pull - 增量拉取：客户端按游标拉取服务端变更
// ---------------------------------------------------------------------------

syncRouter.get('/pull', async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  
  const since = parseInt(c.req.query('since') ?? '0');
  const limit = parseInt(c.req.query('limit') ?? '100');
  const ledgerId = c.req.query('ledger_id');
  const deviceId = c.req.query('device_id');

  try {
    let query = `
      SELECT c.change_id, c.entity_type, c.entity_sync_id, c.action, c.payload_json, c.updated_at, c.updated_by_device_id, l.external_id as ledger_id
      FROM sync_changes c
      LEFT JOIN ledgers l ON c.ledger_id = l.id
      WHERE c.user_id = ? AND c.change_id > ?
    `;
    
    const params: (string | number)[] = [userId, since];
    
    if (ledgerId) {
      query += ' AND l.external_id = ?';
      params.push(ledgerId);
    }

    if (deviceId) {
      query += ' AND c.updated_by_device_id != ?';
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
      }>();

    const maxRow = await db
      .prepare(`SELECT MAX(change_id) as max_id FROM sync_changes WHERE user_id = ?`)
      .bind(userId)
      .first<{ max_id: number | null }>();

    const allResults = changes.results;
    const hasMore = allResults.length > limit;
    const limitedResults = hasMore ? allResults.slice(0, limit) : allResults;

    return c.json({
      changes: limitedResults.map(c => ({
        change_id: c.change_id,
        ledger_id: c.ledger_id ?? '',
        entity_type: c.entity_type,
        entity_sync_id: c.entity_sync_id,
        action: c.action,
        payload: c.payload_json ? JSON.parse(c.payload_json) : {},
        updated_at: c.updated_at,
        updated_by_device_id: c.updated_by_device_id ?? null,
      })),
      server_cursor: maxRow?.max_id ?? 0,
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
      .prepare(`SELECT external_id, name, currency, created_at FROM ledgers WHERE user_id = ?`)
      .bind(userId)
      .all<{ external_id: string; name: string; currency: string; created_at: string }>();

    return c.json({
      ledgers: ledgers.results.map(l => ({
        ledger_id: l.external_id,
        name: l.name,
        currency: l.currency,
        created_at: l.created_at,
      })),
    });
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

  try {
    // 查找账本
    let query = `SELECT id, external_id FROM ledgers WHERE user_id = ?`;
    const params: (string | number)[] = [userId];
    
    if (ledgerId) {
      query += ' AND external_id = ?';
      params.push(ledgerId);
    }
    
    const ledgers = await db
      .prepare(query)
      .bind(...params)
      .all<{ id: string; external_id: string }>();

    const result: Record<string, any> = {
      server_timestamp: nowUtc(),
    };

    for (const ledger of ledgers.results) {
      // 获取账本下的所有变更
      const changes = await db
        .prepare(`
          SELECT entity_type, entity_sync_id, action, payload_json
          FROM sync_changes
          WHERE ledger_id = ?
          ORDER BY change_id ASC
        `)
        .bind(ledger.id)
        .all<{ entity_type: string; entity_sync_id: string; action: string; payload_json: string }>();

      result[ledger.external_id] = changes.results.map(c => ({
        entity_type: c.entity_type,
        entity_sync_id: c.entity_sync_id,
        action: c.action,
        payload: c.payload_json ? JSON.parse(c.payload_json) : {},
      }));
    }

    return c.json(result);
  } catch (error) {
    console.error('[SYNC] /sync/full error:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

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

  // 处理 ledger_snapshot upsert - 创建或更新账本
  if (change.entity_type === 'ledger_snapshot' && change.action === 'upsert') {
    const payload = change.payload as Record<string, unknown>;
    const name = (payload.ledgerName ?? payload.ledger_name ?? payload.name ?? '账本') as string;
    const currency = (payload.currency ?? 'CNY') as string;
    
    // 检查账本是否存在
    const existing = await db
      .prepare('SELECT id FROM ledgers WHERE id = ?')
      .bind(ledgerId)
      .first();
    
    if (existing) {
      // 更新账本
      await db
        .prepare('UPDATE ledgers SET name = ?, currency = ? WHERE id = ?')
        .bind(name, currency, ledgerId)
        .run();
    } else {
      // 查找账本的 external_id
      const ledgerInfo = await db
        .prepare('SELECT external_id FROM ledgers WHERE id = ?')
        .bind(ledgerId)
        .first<{ external_id: string }>();
      
      const externalId = ledgerInfo?.external_id ?? change.entity_sync_id;
      
      // 创建账本（如果不存在）
      await db
        .prepare(
          `INSERT OR IGNORE INTO ledgers (id, user_id, external_id, name, currency, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .bind(ledgerId, userId, externalId, name, currency, nowUtc())
        .run();
    }
    return;
  }

  const INDIVIDUAL_ENTITY_TYPES = [
    'transaction',
    'account',
    'category',
    'tag',
    'budget',
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
      } else {
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
               tx_index = ?, source_change_id = ?
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
              payload.tags ?? null,
              payload.tagIds ? safeJsonStringify(payload.tagIds) : null,
              payload.attachments ? safeJsonStringify(payload.attachments) : null,
              payload.tx_index ?? 0,
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
                tags_csv, tag_sync_ids_json, attachments_json, tx_index, source_change_id)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
              payload.tags ?? null,
              payload.tagIds ? safeJsonStringify(payload.tagIds) : null,
              payload.attachments ? safeJsonStringify(payload.attachments) : null,
              payload.tx_index ?? 0,
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