/**
 * 设备路由模块 - 实现 BeeCount Cloud 设备管理接口
 *
 * 参考原版 BeeCount-Cloud (Python/FastAPI) 的 /devices 端点：
 * - GET  /devices       - 列出当前用户的所有设备
 * - DELETE /devices/:id - 撤销设备（使其 token 失效）
 *
 * 功能说明：
 * - 设备在登录时自动创建/更新
 * - 设备存储 last_seen_at / last_ip 等信息
 * - 撤销设备会使其 refresh_token 失效
 *
 * @module routes/devices
 */

import { Hono } from 'hono';

// ===========================
// 辅助函数
// ===========================

/** 获取当前 UTC 时间 */
function nowUtc(): string {
  return new Date().toISOString();
}

// ===========================
// 类型定义
// ===========================

/** 设备输出 */
interface DeviceOut {
  id: string;
  name: string;
  platform: string;
  app_version: string | null;
  os_version: string | null;
  device_model: string | null;
  last_ip: string | null;
  last_seen_at: string;
  created_at: string;
  session_count: number;
}

// ===========================
// 路由定义
// ===========================

type Bindings = {
  DB: D1Database;
  JWT_SECRET: string;
};

type Variables = {
  userId: string;
};

const devicesRouter = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// ---------------------------------------------------------------------------
// GET /devices - 列出用户所有设备
// ---------------------------------------------------------------------------

/**
 * 获取当前用户的所有设备列表
 *
 * 功能说明：
 * - 返回所有未撤销的设备（revoked_at IS NULL）
 * - 包含设备元信息和最后活跃时间
 * - 按最后活跃时间倒序
 *
 * 响应字段：
 * - id: 设备 ID
 * - name: 设备名称
 * - platform: 平台（ios/android/web/...)
 * - app_version / os_version / device_model: 版本信息
 * - last_ip / last_seen_at: 最后活跃信息
 * - created_at: 首次登录时间
 * - session_count: session 数量（简化版始终为 1）
 */
devicesRouter.get('/', async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const view = c.req.query('view') ?? 'deduped';
  const activeWithinDays = parseInt(c.req.query('active_within_days') ?? '30', 10);

  // 计算活跃时间窗口
  const cutoff = new Date(Date.now() - activeWithinDays * 24 * 60 * 60 * 1000).toISOString();

  const rows = await db
    .prepare(
      `SELECT id, name, platform, app_version, os_version, device_model,
              last_ip, last_seen_at, created_at
       FROM devices
       WHERE user_id = ? AND revoked_at IS NULL AND last_seen_at >= ?
       ORDER BY last_seen_at DESC`
    )
    .bind(userId, cutoff)
    .all<{
      id: string;
      name: string;
      platform: string;
      app_version: string | null;
      os_version: string | null;
      device_model: string | null;
      last_ip: string | null;
      last_seen_at: string;
      created_at: string;
    }>();

  // deduped 视图：按 (user_id, name, platform, device_model, os_version, app_version) 分组
  if (view === 'deduped') {
    const grouped = new Map<string, { primary: typeof rows.results[0]; count: number }>();
    for (const row of rows.results) {
      const key = [
        row.name || '', row.platform || '', row.device_model || '',
        row.os_version || '', row.app_version || ''
      ].join('|');
      const existing = grouped.get(key);
      if (existing) {
        existing.count++;
      } else {
        grouped.set(key, { primary: row, count: 1 });
      }
    }
    const result: DeviceOut[] = [];
    for (const { primary, count } of grouped.values()) {
      result.push({
        id: primary.id,
        name: primary.name,
        platform: primary.platform,
        app_version: primary.app_version,
        os_version: primary.os_version,
        device_model: primary.device_model,
        last_ip: primary.last_ip,
        last_seen_at: primary.last_seen_at,
        created_at: primary.created_at,
        session_count: count,
      });
    }
    return c.json(result);
  }

  // sessions 视图：返回所有记录
  const result: DeviceOut[] = rows.results.map((row) => ({
    id: row.id,
    name: row.name,
    platform: row.platform,
    app_version: row.app_version,
    os_version: row.os_version,
    device_model: row.device_model,
    last_ip: row.last_ip,
    last_seen_at: row.last_seen_at,
    created_at: row.created_at,
    session_count: 1,
  }));

  return c.json(result);
});

// POST /devices/:id/revoke - 撤销设备（与原版 POST /{device_id}/revoke 对齐）
devicesRouter.post('/:id/revoke', async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const deviceId = c.req.param('id');
  const serverNow = nowUtc();

  const device = await db
    .prepare('SELECT id FROM devices WHERE id = ? AND user_id = ? AND revoked_at IS NULL')
    .bind(deviceId, userId)
    .first<{ id: string }>();

  if (!device) {
    return c.json({ error: 'Device not found' }, 404);
  }

  await db.prepare('UPDATE devices SET revoked_at = ? WHERE id = ?').bind(serverNow, deviceId).run();
  await db.prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL').bind(serverNow, deviceId).run();

  return c.json({ ok: true, device_id: deviceId });
});

// DELETE /devices/:id - 撤销设备
devicesRouter.delete('/:id', async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const deviceId = c.req.param('id');
  const serverNow = nowUtc();

  // 验证设备归属（必须属于当前用户）
  const device = await db
    .prepare('SELECT id FROM devices WHERE id = ? AND user_id = ? AND revoked_at IS NULL')
    .bind(deviceId, userId)
    .first<{ id: string }>();

  if (!device) {
    return c.json({ error: 'Device not found' }, 404);
  }

  // 撤销设备
  await db
    .prepare('UPDATE devices SET revoked_at = ? WHERE id = ?')
    .bind(serverNow, deviceId)
    .run();

  // 使该设备的所有 refresh_token 失效
  await db
    .prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL')
    .bind(serverNow, deviceId)
    .run();

  return c.json({ ok: true, device_id: deviceId });
});

export default devicesRouter;
