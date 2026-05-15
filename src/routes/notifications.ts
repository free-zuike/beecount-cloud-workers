/**
 * 实时通知路由模块 - 实现 Server-Sent Events (SSE) 实时推送
 *
 * 参考原版 BeeCount-Cloud (Python/FastAPI) 的 /ws 端点改造：
 * - Cloudflare Workers 不支持原生 WebSocket，改用 SSE (Server-Sent Events)
 * - GET /notifications/subscribe - 订阅实时变更通知（SSE 流）
 *
 * 功能说明：
 * - 客户端通过 SSE 长连接订阅账本变更
 * - 当账本有新的 SyncChange 时，推送通知事件
 * - 支持心跳保持连接活跃
 * - 连接超时由 Cloudflare 控制（通常 100 秒）
 *
 * SSE 事件格式：
 * - event: heartbeat   - 心跳（每 30 秒）
 * - event: change      - 账本变更通知
 * - event: error       - 错误通知
 *
 * 注意：
 * - 这是简化版轮询实现，真正的实时推送需要：
 *   1. Cloudflare Durable Objects（推荐，状态ful）
 *   2. Cloudflare Pub/Sub + WebSocket Gateway
 *   3. 外部消息队列（如 Cloudflare Queues + Pusher）
 *
 * @module routes/notifications
 */

import { Hono } from 'hono';

function nowUtc(): string {
  return new Date().toISOString();
}

type Bindings = {
  DB: D1Database;
  JWT_SECRET: string;
};

type Variables = {
  userId: string;
};

const notificationsRouter = new Hono<{ Bindings: Bindings; Variables: Variables }>();

/**
 * GET /notifications/subscribe - 订阅实时变更通知
 *
 * 查询参数：
 * - ledger_id: 账本外部 ID（可选，不填则订阅所有账本）
 * - device_id: 设备 ID（用于过滤自己产生的变更）
 *
 * SSE 事件：
 * - event: heartbeat
 *   data: { ts: ISO时间戳 }
 *
 * - event: change
 *   data: {
 *     ledger_id: string,
 *     change_id: number,
 *     entity_type: string,
 *     entity_sync_id: string,
 *     action: string,
 *     updated_at: string,
 *     cursor: number
 *   }
 *
 * - event: error
 *   data: { code: string, message: string }
 */
notificationsRouter.get('/subscribe', async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const ledgerExternalId = c.req.query('ledger_id') ?? null;
  const deviceId = c.req.query('device_id') ?? null;

  // 获取用户所有账本
  let ledgerQuery = 'SELECT id, external_id FROM ledgers WHERE user_id = ?';
  const ledgerParams: string[] = [userId];

  if (ledgerExternalId) {
    ledgerQuery += ' AND external_id = ?';
    ledgerParams.push(ledgerExternalId);
  }

  const ledgers = await db.prepare(ledgerQuery).bind(...ledgerParams).all<{ id: string; external_id: string }>();

  if (ledgers.results.length === 0) {
    return c.json({ error: 'No ledger found' }, 404);
  }

  const ledgerInternalIds = ledgers.results.map((l) => l.id);
  const ledgerIdMap: Record<string, string> = {};
  ledgers.results.forEach((l) => {
    ledgerIdMap[l.id] = l.external_id;
  });

  // 获取当前最大游标
  const initialCursorRow = await db
    .prepare(
      `SELECT MAX(change_id) as max_id FROM sync_changes
       WHERE ledger_id IN (${ledgerInternalIds.map(() => '?').join(',')})`
    )
    .bind(...ledgerInternalIds)
    .first<{ max_id: number | null }>();

  const initialCursor = initialCursorRow?.max_id ?? 0;

  // 构建 SSE 流
  const encoder = new TextEncoder();
  let currentCursor = initialCursor;

  // 简化实现：
  // Cloudflare Workers SSE 有 100 秒超时限制
  // 完整实现应使用 Durable Objects 或定时轮询
  const stream = new ReadableStream({
    async start(controller) {
      const sendEvent = (eventName: string, data: unknown) => {
        try {
          controller.enqueue(
            encoder.encode(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`)
          );
        } catch {
          // 连接已关闭
        }
      };

      // 发送初始连接确认
      sendEvent('connected', {
        user_id: userId,
        ledger_ids: ledgerInternalIds.map((id) => ledgerIdMap[id]),
        initial_cursor: currentCursor,
        ts: nowUtc(),
      });

      // 简化实现：每 30 秒发送一次心跳
      // 真正的实时推送需要 Durable Objects 或外部消息队列
      let heartbeatCount = 0;
      const maxHeartbeats = 180; // 约 90 分钟

      const heartbeatInterval = setInterval(() => {
        heartbeatCount++;
        sendEvent('heartbeat', { ts: nowUtc() });

        // 检查是否有新变更（简化轮询）
        checkForNewChanges().catch(() => {});

        if (heartbeatCount >= maxHeartbeats) {
          clearInterval(heartbeatInterval);
          sendEvent('error', { code: 'TIMEOUT', message: 'Connection timeout' });
          controller.close();
        }
      }, 30000);

      const checkForNewChanges = async () => {
        try {
          const newChanges = await db
            .prepare(
              `SELECT sc.change_id, sc.ledger_id, sc.entity_type, sc.entity_sync_id,
                      sc.action, sc.updated_at, sc.updated_by_device_id
               FROM sync_changes sc
               WHERE sc.ledger_id IN (${ledgerInternalIds.map(() => '?').join(',')})
                 AND sc.change_id > ?
                 ${deviceId ? 'AND sc.updated_by_device_id != ?' : ''}
               ORDER BY sc.change_id ASC
               LIMIT 100`
            )
            .bind(...ledgerInternalIds, currentCursor, ...(deviceId ? [deviceId] : []))
            .all<{
              change_id: number;
              ledger_id: string;
              entity_type: string;
              entity_sync_id: string;
              action: string;
              updated_at: string;
              updated_by_device_id: string | null;
            }>();

          if (newChanges.results.length > 0) {
            for (const change of newChanges.results) {
              sendEvent('change', {
                ledger_id: ledgerIdMap[change.ledger_id],
                change_id: change.change_id,
                entity_type: change.entity_type,
                entity_sync_id: change.entity_sync_id,
                action: change.action,
                updated_at: change.updated_at,
                updated_by_device_id: change.updated_by_device_id,
                cursor: change.change_id,
              });

              currentCursor = Math.max(currentCursor, change.change_id);
            }
          }
        } catch {
          // 数据库查询失败，忽略
        }
      };

      // 清理函数
      c.req.signal.addEventListener('abort', () => {
        clearInterval(heartbeatInterval);
        try {
          controller.close();
        } catch {
          // 已关闭
        }
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
});

/**
 * GET /notifications/poll - 短轮询接口（替代 SSE 的轻量方案）
 *
 * 查询参数：
 * - ledger_id: 账本外部 ID
 * - since: 起始游标
 * - device_id: 设备 ID（用于过滤自己）
 *
 * 响应：
 * - changes: 新变更数组
 * - cursor: 最新游标
 * - has_more: 是否还有更多
 */
notificationsRouter.get('/poll', async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const ledgerExternalId = c.req.query('ledger_id') ?? 'default';
  const since = parseInt(c.req.query('since') ?? '0', 10);
  const deviceId = c.req.query('device_id') ?? null;
  const limit = Math.min(parseInt(c.req.query('limit') ?? '100', 10), 500);

  const ledger = await db
    .prepare('SELECT id, external_id FROM ledgers WHERE user_id = ? AND external_id = ?')
    .bind(userId, ledgerExternalId)
    .first<{ id: string; external_id: string }>();

  if (!ledger) {
    return c.json({ changes: [], cursor: since, has_more: false });
  }

  let query;
  if (deviceId) {
    query = db
      .prepare(
        `SELECT change_id, entity_type, entity_sync_id, action, updated_at, updated_by_device_id
         FROM sync_changes
         WHERE ledger_id = ? AND change_id > ? AND updated_by_device_id != ?
         ORDER BY change_id ASC
         LIMIT ?`
      )
      .bind(ledger.id, since, deviceId, limit + 1);
  } else {
    query = db
      .prepare(
        `SELECT change_id, entity_type, entity_sync_id, action, updated_at, updated_by_device_id
         FROM sync_changes
         WHERE ledger_id = ? AND change_id > ?
         ORDER BY change_id ASC
         LIMIT ?`
      )
      .bind(ledger.id, since, limit + 1);
  }

  const rows = await query.all<{
    change_id: number;
    entity_type: string;
    entity_sync_id: string;
    action: string;
    updated_at: string;
    updated_by_device_id: string | null;
  }>();

  const hasMore = rows.results.length > limit;
  const items = rows.results.slice(0, limit);

  return c.json({
    changes: items.map((row) => ({
      ledger_id: ledger.external_id,
      change_id: row.change_id,
      entity_type: row.entity_type,
      entity_sync_id: row.entity_sync_id,
      action: row.action,
      updated_at: row.updated_at,
      updated_by_device_id: row.updated_by_device_id,
    })),
    cursor: since,
    has_more: hasMore,
  });
});

export default notificationsRouter;
