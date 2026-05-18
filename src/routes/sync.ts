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

    // ====================== 优化2：批量获取现有变更 ======================
    const existingChangeMap = new Map<string, { change_id: number; updated_at: string; updated_by_device_id: string | null }>();
    
    if (changes.length > 0) {
      // 构建批量查询
      let query = `SELECT ledger_id, entity_type, entity_sync_id, change_id, updated_at, updated_by_device_id FROM sync_changes WHERE (`;
      const params: (string | number)[] = [];
      
      for (let i = 0; i < changes.length; i++) {
        if (i > 0) query += ' OR ';
        const ledgerId = ledgerMap[changes[i].ledger_id]?.id;
        if (!ledgerId) continue;
        query += `(ledger_id = ? AND entity_type = ? AND entity_sync_id = ?)`;
        params.push(ledgerId, changes[i].entity_type, changes[i].entity_sync_id);
      }
      query += ')';
      
      // 只有当有参数时才执行查询
      if (params.length > 0) {
        console.log('[SYNC] Querying existing changes with params count:', params.length);
        const existingChanges = await db
          .prepare(query)
          .bind(...params)
          .all<{ ledger_id: string; entity_type: string; entity_sync_id: string; change_id: number; updated_at: string; updated_by_device_id: string | null }>();
        
        console.log('[SYNC] existingChanges found:', existingChanges.results.length);
        for (const change of existingChanges.results) {
          const key = `${change.ledger_id}:${change.entity_type}:${change.entity_sync_id}`;
          existingChangeMap.set(key, change);
        }
      }
    }
    console.log('[SYNC] existingChangeMap size:', existingChangeMap.size);

    // ====================== 优化3：批量写入变更 ======================
    const insertPromises: Promise<{ meta: { last_row_id: number } }>[] = [];
    const conflictList: typeof conflictSamples = [];

    for (const change of changes) {
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
      insertPromises.push(
        db.prepare(
          `INSERT INTO sync_changes
           (user_id, ledger_id, entity_type, entity_sync_id, action, payload_json, updated_at, updated_by_device_id, updated_by_user_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          userId,
          ledgerRow.id,
          change.entity_type,
          change.entity_sync_id,
          change.action,
          safeJsonStringify(change.payload),
          clampedUpdatedAt.toISOString(),
          deviceId,
          userId,
        )
        .run()
      );

      touchedLedgers[ledgerRow.external_id] = ledgerRow.id;
    }

    console.log('[SYNC] insertPromises count:', insertPromises.length);

    // 执行批量插入
    if (insertPromises.length > 0) {
      const results = await Promise.all(insertPromises);
      accepted += results.length;
      
      // 获取最大 cursor
      for (const result of results) {
        const changeId = result.meta.last_row_id as number;
        maxCursor = Math.max(maxCursor, changeId);
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
  
  const cursor = parseInt(c.req.query('cursor') || '0');
  const limit = parseInt(c.req.query('limit') || '100');
  const ledgerId = c.req.query('ledger_id');

  try {
    let query = `
      SELECT c.change_id, c.entity_type, c.entity_sync_id, c.action, c.payload_json, c.updated_at, l.external_id as ledger_id
      FROM sync_changes c
      JOIN ledgers l ON c.ledger_id = l.id
      WHERE c.user_id = ? AND c.change_id > ?
    `;
    
    const params: (string | number)[] = [userId, cursor];
    
    if (ledgerId) {
      query += ' AND l.external_id = ?';
      params.push(ledgerId);
    }
    
    query += ' ORDER BY c.change_id ASC LIMIT ?';
    params.push(limit);

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
        ledger_id: string;
      }>();

    const maxRow = await db
      .prepare(`SELECT MAX(change_id) as max_id FROM sync_changes WHERE user_id = ?`)
      .bind(userId)
      .first<{ max_id: number | null }>();

    return c.json({
      changes: changes.results.map(c => ({
        ledger_id: c.ledger_id,
        entity_type: c.entity_type,
        entity_sync_id: c.entity_sync_id,
        action: c.action,
        payload: c.payload_json ? JSON.parse(c.payload_json) : {},
        updated_at: c.updated_at,
      })),
      server_cursor: maxRow?.max_id ?? 0,
      server_timestamp: nowUtc(),
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

export default syncRouter;