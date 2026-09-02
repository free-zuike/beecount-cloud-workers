/**
 * 管理路由模块 - 实现 BeeCount Cloud 管理员接口
 *
 * 参考原版 BeeCount-Cloud (Python/FastAPI) 的 /admin 端点：
 * - GET  /admin/overview        - 获取系统概览
 * - GET  /admin/users           - 列出所有用户
 * - POST /admin/users           - 创建用户
 * - PATCH /admin/users/:id     - 更新用户
 * - DELETE /admin/users/:id    - 删除用户
 * - GET  /admin/devices         - 列出所有设备
 * - GET  /admin/logs            - 获取最近日志
 *
 * 功能说明：
 * - 需要管理员权限才能访问
 * - 支持用户管理、设备查看、系统概览
 *
 * @module routes/admin
 */

import { Hono } from 'hono';
import { serverLogger } from '../lib/logger';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { hashPassword, verifyPassword } from '../auth';
import { insertAuditLog } from '../lib/audit';

// ===========================
// 辅助函数
// ===========================

/** 获取当前 UTC 时间 */
function nowUtc(): string {
  return new Date().toISOString();
}

// ===========================
// Schema 定义
// ===========================

/** 创建用户请求 */
const AdminUserCreateSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  is_admin: z.boolean().default(false),
  is_enabled: z.boolean().default(true),
});

/** 更新用户请求 */
const AdminUserPatchSchema = z.object({
  email: z.string().email().optional(),
  is_enabled: z.boolean().optional(),
});

// ===========================
// 类型定义
// ===========================

/** 管理员用户输出 */
interface AdminUserOut {
  id: string;
  email: string;
  is_admin: boolean;
  is_enabled: boolean;
  created_at: string;
  display_name: string | null;
  avatar_url: string | null;
  avatar_version: number;
}

/** 系统概览输出 */
interface AdminOverviewOut {
  users_total: number;
  users_enabled_total: number;
  ledgers_total: number;
  transactions_total: number;
  accounts_total: number;
  categories_total: number;
  tags_total: number;
}

// ---------------------------------------------------------------------------
// ===========================
// 路由定义
// ===========================

type Bindings = {
  DB: D1Database;
  JWT_SECRET: string;
  R2?: R2Bucket;
  BEECOUNT_DO: DurableObjectNamespace;
};

type Variables = {
  userId: string;
};

const adminRouter = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// ---------------------------------------------------------------------------
// 管理员权限检查中间件
// ---------------------------------------------------------------------------

/**
 * 检查当前用户是否为管理员
 */
adminRouter.use('/*', async (c, next) => {
  const userId = c.get('userId');
  const db = c.env.DB;

  const user = await db
    .prepare('SELECT is_admin FROM users WHERE id = ?')
    .bind(userId)
    .first<{ is_admin: number }>();

  if (!user || !user.is_admin) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  await next();
});

// Health check endpoint
adminRouter.get('/health', async (c) => {
  const db = c.env.DB;
  
  try {
    await db.prepare('SELECT 1').first();
    
    // 直接返回 UTC 时间，前端 formatIsoDateTime 用 new Date().getHours() 自动转本地时间
    // 不做任何时区偏移计算，避免 DB 中 timezone_offset 值不准确导致时间错误
    
    // 查询在线用户数（5分钟内有活动视为在线）
    let onlineCount = 0;
    try {
      const onlineThreshold = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      const onlineResult = await db
        .prepare(`SELECT COUNT(DISTINCT user_id) as count 
                  FROM devices 
                  WHERE last_seen_at > ?`)
        .bind(onlineThreshold)
        .first<{ count: number }>();
      onlineCount = onlineResult?.count || 0;
    } catch {}
    
    return c.json({
      status: 'ok',
      db: 'connected',
      online_ws_users: onlineCount,
      time: new Date().toISOString(),
    });
  } catch (error) {
    return c.json({
      status: 'error',
      db: 'disconnected',
      online_ws_users: 0,
      time: new Date().toISOString(),
    }, 503);
  }
});

// ---------------------------------------------------------------------------
// GET /admin/overview - 管理员概览
// ---------------------------------------------------------------------------

/**
 * 管理员概览统计
 *
 * 功能说明：
 * - 返回各表的数量统计
 * - 用于管理员仪表板
 */
adminRouter.get('/overview', async (c) => {
  const db = c.env.DB;

  const [
    usersTotal,
    usersEnabled,
    ledgersTotal,
    transactionsTotal,
    accountsTotal,
    categoriesTotal,
    tagsTotal,
  ] = await Promise.all([
    db.prepare('SELECT COUNT(*) as cnt FROM users').first<{ cnt: number }>(),
    db.prepare('SELECT COUNT(*) as cnt FROM users WHERE is_enabled = 1').first<{ cnt: number }>(),
    db.prepare('SELECT COUNT(*) as cnt FROM ledgers').first<{ cnt: number }>(),
    db.prepare('SELECT COUNT(*) as cnt FROM read_tx_projection').first<{ cnt: number }>(),
    db.prepare('SELECT COUNT(DISTINCT sync_id) as cnt FROM user_account_projection').first<{ cnt: number }>(),
    db.prepare('SELECT COUNT(DISTINCT sync_id) as cnt FROM user_category_projection').first<{ cnt: number }>(),
    db.prepare('SELECT COUNT(DISTINCT sync_id) as cnt FROM user_tag_projection').first<{ cnt: number }>(),
  ]);

  const response: AdminOverviewOut = {
    users_total: usersTotal?.cnt ?? 0,
    users_enabled_total: usersEnabled?.cnt ?? 0,
    ledgers_total: ledgersTotal?.cnt ?? 0,
    transactions_total: transactionsTotal?.cnt ?? 0,
    accounts_total: accountsTotal?.cnt ?? 0,
    categories_total: categoriesTotal?.cnt ?? 0,
    tags_total: tagsTotal?.cnt ?? 0,
  };

  return c.json(response);
});

// ---------------------------------------------------------------------------
// GET /admin/users - 列出所有用户
// ---------------------------------------------------------------------------

/**
 * 获取所有用户列表
 *
 * 功能说明：
 * - 返回所有用户（分页支持可选）
 * - 包含用户的资料信息
 */
adminRouter.get('/users', async (c) => {
  const db = c.env.DB;
  const q = c.req.query('q') ?? null;
  const status = c.req.query('status') ?? null;
  const limit = Math.min(parseInt(c.req.query('limit') ?? '100', 10), 1000);
  const offset = parseInt(c.req.query('offset') ?? '0', 10);

  let whereClause = 'WHERE 1=1';
  const params: (string | number)[] = [];

  if (q) {
    whereClause += ' AND (u.email LIKE ? OR p.display_name LIKE ?)';
    params.push(`%${q}%`, `%${q}%`);
  }
  if (status === 'enabled') {
    whereClause += ' AND u.is_enabled = 1';
  } else if (status === 'disabled') {
    whereClause += ' AND u.is_enabled = 0';
  }

  const rows = await db
    .prepare(
      `SELECT u.id, u.email, u.is_admin, u.is_enabled, u.created_at,
              p.display_name, p.avatar_file_id, p.avatar_version
       FROM users u
       LEFT JOIN user_profiles p ON p.user_id = u.id
       ${whereClause}
       ORDER BY u.created_at DESC
       LIMIT ? OFFSET ?`
    )
    .bind(...params, limit, offset)
    .all<{
      id: string;
      email: string;
      is_admin: number;
      is_enabled: number;
      created_at: string;
      display_name: string | null;
      avatar_file_id: string | null;
      avatar_version: number | null;
    }>();

  const totalRow = await db.prepare('SELECT COUNT(*) as cnt FROM users').first<{ cnt: number }>();

  const items: AdminUserOut[] = rows.results.map((row) => ({
    id: row.id,
    email: row.email,
    is_admin: Boolean(row.is_admin),
    is_enabled: Boolean(row.is_enabled),
    created_at: row.created_at,
    display_name: row.display_name,
    avatar_url: row.avatar_file_id,
    avatar_version: row.avatar_version ?? 0,
  }));

  return c.json({ total: totalRow?.cnt ?? 0, items });
});

// ---------------------------------------------------------------------------
// POST /admin/users - 创建用户
// ---------------------------------------------------------------------------

/**
 * 创建新用户
 *
 * 功能说明：
 * - 需要管理员权限
 * - 创建用户及其初始 profile
 */
adminRouter.post('/users', zValidator('json', AdminUserCreateSchema), async (c) => {
  const db = c.env.DB;
  const req = c.req.valid('json');
  const serverNow = nowUtc();

  // 检查邮箱是否已存在
  const existing = await db
    .prepare('SELECT id FROM users WHERE email = ?')
    .bind(req.email.toLowerCase())
    .first();

  if (existing) {
    return c.json({ error: 'Email already exists' }, 409);
  }

  const userId = randomUUID();
  const passwordHash = await hashPassword(req.password);

  await db
    .prepare(
      `INSERT INTO users (id, email, password_hash, is_admin, is_enabled, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(userId, req.email.toLowerCase(), passwordHash, 0, req.is_enabled ? 1 : 0, serverNow)
    .run();

  // 创建用户 profile
  await db
    .prepare(
      `INSERT INTO user_profiles (user_id, display_name, avatar_version)
       VALUES (?, ?, 0)`
    )
    .bind(userId, req.email.split('@')[0])
    .run();

  await insertAuditLog({ db, userId: c.get('userId'), action: 'admin_user_create', entityType: 'user', entityId: userId, details: { email: req.email.toLowerCase() } });

  return c.json({
    id: userId,
    email: req.email.toLowerCase(),
    is_admin: false,
    is_enabled: req.is_enabled,
    created_at: serverNow,
    display_name: null,
    avatar_url: null,
    avatar_version: 0,
  } as AdminUserOut);
});

// ---------------------------------------------------------------------------
// PATCH /admin/users/:id - 更新用户
// ---------------------------------------------------------------------------

/**
 * 更新用户信息
 *
 * 功能说明：
 * - 可更新邮箱和启用状态
 * - 不能通过此接口修改密码（需要单独端点）
 */
adminRouter.patch('/users/:id', zValidator('json', AdminUserPatchSchema), async (c) => {
  const db = c.env.DB;
  const userId = c.req.param('id');
  const req = c.req.valid('json');

  const user = await db
    .prepare('SELECT id FROM users WHERE id = ?')
    .bind(userId)
    .first();

  if (!user) {
    return c.json({ error: 'User not found' }, 404);
  }

  // 阻止禁用管理员用户（与原版对齐）
  if (req.is_enabled === false) {
    const targetUser = await db.prepare('SELECT is_admin FROM users WHERE id = ?').bind(userId).first<{ is_admin: number }>();
    if (targetUser?.is_admin) {
      return c.json({ error: 'Cannot disable an admin user' }, 400);
    }
  }

  if (req.email) {
    // 检查新邮箱是否被占用
    const existing = await db
      .prepare('SELECT id FROM users WHERE email = ? AND id != ?')
      .bind(req.email.toLowerCase(), userId)
      .first();

    if (existing) {
      return c.json({ error: 'Email already exists' }, 409);
    }

    await db.prepare('UPDATE users SET email = ? WHERE id = ?').bind(req.email.toLowerCase(), userId).run();
  }

  if (req.is_enabled !== undefined) {
    await db
      .prepare('UPDATE users SET is_enabled = ? WHERE id = ?')
      .bind(req.is_enabled ? 1 : 0, userId)
      .run();
  }

  // 返回更新后的用户
  const row = await db
    .prepare(
      `SELECT u.id, u.email, u.is_admin, u.is_enabled, u.created_at,
              p.display_name, p.avatar_file_id, p.avatar_version
       FROM users u
       LEFT JOIN user_profiles p ON p.user_id = u.id
       WHERE u.id = ?`
    )
    .bind(userId)
    .first<{
      id: string;
      email: string;
      is_admin: number;
      is_enabled: number;
      created_at: string;
      display_name: string | null;
      avatar_file_id: string | null;
      avatar_version: number | null;
    }>();

  if (!row) {
    return c.json({ error: 'User not found' }, 404);
  }

  const response: AdminUserOut = {
    id: row.id,
    email: row.email,
    is_admin: Boolean(row.is_admin),
    is_enabled: Boolean(row.is_enabled),
    created_at: row.created_at,
    display_name: row.display_name,
    avatar_url: row.avatar_file_id,
    avatar_version: row.avatar_version ?? 0,
  };

  await insertAuditLog({ db, userId: c.get('userId'), action: 'admin_user_patch', entityType: 'user', entityId: userId, details: { changes: Object.keys(req).filter(k => (req as any)[k] !== undefined) } });
  return c.json(response);
});

// ---------------------------------------------------------------------------
// DELETE /admin/users/:id - 删除用户
// ---------------------------------------------------------------------------

/**
 * 删除用户
 *
 * 功能说明：
 * - 物理删除用户（ON DELETE CASCADE 会删除关联数据）
 * - 不可恢复
 */
adminRouter.delete('/users/:id', async (c) => {
  const db = c.env.DB;
  const userId = c.req.param('id');

  // 不能删除自己
  const currentUserId = c.get('userId');
  if (userId === currentUserId) {
    return c.json({ error: 'Cannot delete yourself' }, 400);
  }

  const user = await db.prepare('SELECT id FROM users WHERE id = ?').bind(userId).first();

  if (!user) {
    return c.json({ error: 'User not found' }, 404);
  }

  // 阻止删除管理员用户（与原版对齐）
  const targetUser = await db.prepare('SELECT is_admin FROM users WHERE id = ?').bind(userId).first<{ is_admin: number }>();
  if (targetUser?.is_admin) {
    return c.json({ error: 'Cannot delete an admin user' }, 400);
  }

  const now = nowUtc();

  // 软删除（与原版对齐：禁用而非物理删除）
  await db
    .prepare('UPDATE users SET is_enabled = 0, is_admin = 0 WHERE id = ?')
    .bind(userId)
    .run();

  // 撤销该用户的所有 refresh tokens
  await db
    .prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL')
    .bind(now, userId)
    .run();

  // 撤销该用户的所有设备
  await db
    .prepare('UPDATE devices SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL')
    .bind(now, userId)
    .run();

  await insertAuditLog({ db, userId: c.get('userId'), action: 'admin_user_delete', entityType: 'user', entityId: userId, details: { soft_delete: true } });

  return c.json({ id: userId, email: null, is_admin: false, is_enabled: false, created_at: null });
});

// ---------------------------------------------------------------------------
// GET /admin/devices - 列出所有设备（支持原版 deduped/sessions 视图）
// ---------------------------------------------------------------------------

/**
 * 获取设备列表 — 与原版 devices.py 对齐
 * - view=deduped（默认）：按设备属性分组去重，每组返回最近活跃的 + session_count
 * - view=sessions：返回所有原始设备记录
 * - active_within_days：只返回指定天数内活跃的设备（默认 30 天）
 */
adminRouter.get('/devices', async (c) => {
  const db = c.env.DB;
  const view = c.req.query('view') ?? 'deduped';
  const activeWithinDays = parseInt(c.req.query('active_within_days') ?? '30', 10);

  let whereClause = 'd.revoked_at IS NULL';
  const bindParams: (string | number)[] = [];

  if (activeWithinDays > 0) {
    const cutoff = new Date(Date.now() - activeWithinDays * 24 * 60 * 60 * 1000).toISOString();
    whereClause += ' AND d.last_seen_at >= ?';
    bindParams.push(cutoff);
  }

  // 支持前端已有的筛选参数
  const userId = c.req.query('user_id');
  if (userId) {
    whereClause += ' AND d.user_id = ?';
    bindParams.push(userId);
  }
  const onlineOnly = c.req.query('online_only') === 'true';
  if (onlineOnly) {
    const onlineThreshold = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    whereClause += ' AND d.last_seen_at > ?';
    bindParams.push(onlineThreshold);
  }

  const stmt = db.prepare(
    `SELECT d.id, d.name, d.platform, d.app_version, d.os_version, d.device_model,
            d.last_ip, d.created_at, d.last_seen_at,
            u.id as user_id, u.email as user_email
     FROM devices d
     JOIN users u ON d.user_id = u.id
     WHERE ${whereClause}
     ORDER BY d.last_seen_at DESC`
  );
  const rows = await (bindParams.length > 0 ? stmt.bind(...bindParams) : stmt).all<{
      id: string;
      name: string;
      platform: string;
      app_version: string | null;
      os_version: string | null;
      device_model: string | null;
      last_ip: string | null;
      created_at: string;
      last_seen_at: string;
      user_id: string;
      user_email: string;
    }>();

  const onlineThreshold = new Date(Date.now() - 5 * 60 * 1000).toISOString();

  if (view === 'sessions') {
    const items = rows.results.map((row) => ({
      id: row.id,
      name: row.name,
      platform: row.platform,
      app_version: row.app_version,
      os_version: row.os_version,
      device_model: row.device_model,
      last_ip: row.last_ip,
      created_at: row.created_at,
      last_seen_at: row.last_seen_at,
      is_online: row.last_seen_at > onlineThreshold,
      user_id: row.user_id,
      user_email: row.user_email,
      session_count: 1,
    }));
    return c.json({ total: items.length, items });
  }

  // deduped 视图 — 按 (user_id, name, platform, device_model, os_version, app_version) 分组
  const norm = (v: string | null) => (v || '').trim().toLowerCase() || '__empty__';
  const groups = new Map<string, typeof rows.results>();
  for (const row of rows.results) {
    const key = [row.user_id, row.name, row.platform, row.device_model, row.os_version, row.app_version].map(norm).join('|');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(row);
  }

  const items: Array<{
    id: string; name: string; platform: string; app_version: string | null;
    os_version: string | null; device_model: string | null; last_ip: string | null;
    created_at: string; last_seen_at: string; is_online: boolean;
    user_id: string; user_email: string; session_count: number;
  }> = [];

  for (const bucket of groups.values()) {
    const primary = bucket[0]; // 已按 last_seen_at DESC 排序
    items.push({
      id: primary.id,
      name: primary.name,
      platform: primary.platform,
      app_version: primary.app_version,
      os_version: primary.os_version,
      device_model: primary.device_model,
      last_ip: primary.last_ip,
      created_at: primary.created_at,
      last_seen_at: primary.last_seen_at,
      is_online: primary.last_seen_at > onlineThreshold,
      user_id: primary.user_id,
      user_email: primary.user_email,
      session_count: bucket.length,
    });
  }

  items.sort((a, b) => b.last_seen_at.localeCompare(a.last_seen_at));
  return c.json({ total: items.length, items });
});

// ---------------------------------------------------------------------------
// GET /admin/devices/online - 在线设备统计
// ---------------------------------------------------------------------------

adminRouter.get('/devices/online', async (c) => {
  const db = c.env.DB;

  const onlineThreshold = new Date(Date.now() - 5 * 60 * 1000).toISOString();

  const result = await db
    .prepare(
      `SELECT COUNT(*) as total_online,
              COUNT(DISTINCT user_id) as unique_users
       FROM devices
       WHERE revoked_at IS NULL AND last_seen_at > ?`
    )
    .bind(onlineThreshold)
    .first<{ total_online: number; unique_users: number }>();

  return c.json({
    total_online: result?.total_online ?? 0,
    unique_users: result?.unique_users ?? 0,
    online_threshold_seconds: 300,
  });
});

// ---------------------------------------------------------------------------
// POST /admin/devices/:id/revoke - 撤销设备（与原版 POST /{device_id}/revoke 对齐）
// ---------------------------------------------------------------------------

adminRouter.post('/devices/:id/revoke', async (c) => {
  const db = c.env.DB;
  const deviceId = c.req.param('id');
  const now = new Date().toISOString();

  const device = await db.prepare('SELECT id FROM devices WHERE id = ?').bind(deviceId).first();
  if (!device) {
    return c.json({ error: 'Device not found' }, 404);
  }

  await db.prepare('UPDATE devices SET revoked_at = ? WHERE id = ?').bind(now, deviceId).run();
  await db.prepare(
    "UPDATE refresh_tokens SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL"
  ).bind(now, deviceId).run();

  return c.json({ ok: true, device_id: deviceId });
});

// ---------------------------------------------------------------------------
// DELETE /admin/devices/:id - 删除设备
// ---------------------------------------------------------------------------

adminRouter.delete('/devices/:id', async (c) => {
  const db = c.env.DB;
  const deviceId = c.req.param('id');

  const device = await db.prepare('SELECT id FROM devices WHERE id = ?').bind(deviceId).first();
  if (!device) {
    return c.json({ error: 'Device not found' }, 404);
  }

  await db.prepare('DELETE FROM devices WHERE id = ?').bind(deviceId).run();
  await db.prepare("DELETE FROM refresh_tokens WHERE device_id = ?").bind(deviceId).run();

  return c.json({ ok: true, device_id: deviceId });
});

// ---------------------------------------------------------------------------
// GET /admin/logs - 获取最近日志（简化版）
// ---------------------------------------------------------------------------

/**
 * 获取最近的日志条目
 *
 * 功能说明：
 * - 返回最近的审计日志
 * - 用于管理员排查问题
 */
// 修改用户密码
adminRouter.post('/users/:id/password', zValidator('json', z.object({
  admin_password: z.string(),
  new_password: z.string().min(6)
})), async (c) => {
  const db = c.env.DB;
  const userId = c.req.param('id');
  const { admin_password, new_password } = c.req.valid('json');
  const currentUserId = c.get('userId');

  // 验证当前管理员的密码
  const currentUser = await db
    .prepare('SELECT id, password_hash FROM users WHERE id = ?')
    .bind(currentUserId)
    .first<{ id: string; password_hash: string }>();

  if (!currentUser) {
    return c.json({ error: 'User not found' }, 404);
  }

  const passwordValid = await verifyPassword(currentUser.password_hash, admin_password);
  if (!passwordValid) {
    return c.json({ error: 'Invalid admin password' }, 401);
  }

  // 检查目标用户是否存在
  const targetUser = await db
    .prepare('SELECT id FROM users WHERE id = ?')
    .bind(userId)
    .first();

  if (!targetUser) {
    return c.json({ error: 'User not found' }, 404);
  }

  // 更新密码
  const newPasswordHash = await hashPassword(new_password);
  await db
    .prepare('UPDATE users SET password_hash = ? WHERE id = ?')
    .bind(newPasswordHash, userId)
    .run();

  // 撤销该用户的所有 refresh token（强制重新登录）
  await db
    .prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL')
    .bind(new Date().toISOString(), userId)
    .run();

  // 返回更新后的用户信息
  const updatedUser = await db
    .prepare(
      `SELECT u.id, u.email, u.is_admin, u.is_enabled, u.created_at,
              p.display_name, p.avatar_file_id, p.avatar_version
       FROM users u
       LEFT JOIN user_profiles p ON p.user_id = u.id
       WHERE u.id = ?`
    )
    .bind(userId)
    .first<{
      id: string;
      email: string;
      is_admin: number;
      is_enabled: number;
      created_at: string;
      display_name: string | null;
      avatar_file_id: string | null;
      avatar_version: number | null;
    }>();

  if (!updatedUser) {
    return c.json({ error: 'User not found' }, 404);
  }

  const response: AdminUserOut = {
    id: updatedUser.id,
    email: updatedUser.email,
    is_admin: Boolean(updatedUser.is_admin),
    is_enabled: Boolean(updatedUser.is_enabled),
    created_at: updatedUser.created_at,
    display_name: updatedUser.display_name,
    avatar_url: updatedUser.avatar_file_id,
    avatar_version: updatedUser.avatar_version ?? 0,
  };

  return c.json(response);
});

adminRouter.get('/logs', async (c) => {
  const limit = Math.min(parseInt(c.req.query('limit') ?? '500', 10), 1000);
  const level = c.req.query('level');
  const q = c.req.query('q');
  const source = c.req.query('source');
  const sinceSeq = parseInt(c.req.query('since_seq') ?? '0', 10);

  // 从 LogBuffer DO（内存 ring buffer）读日志 —— 对齐原版「内存，重启清零」。
  // 审计事件（insertAuditLog）仍在 D1 持久化，但普通日志/请求日志只进内存。
  const doId = c.env.BEECOUNT_DO.idFromName('log-global');
  const stub = c.env.BEECOUNT_DO.get(doId);
  const params = new URLSearchParams({ limit: String(limit) });
  if (level && level !== 'ALL') params.set('level', level);
  if (source) params.set('source', source);
  if (sinceSeq > 0) params.set('since_seq', String(sinceSeq));
  const resp = await stub.fetch(`https://do/log/get?${params.toString()}`);
  const data = await resp.json() as {
    logs: Array<{ id: number; level: string; source: string; message: string; timestamp: string }>;
    total: number;
  };

  const items = data.logs
    .filter((l) => !q || l.message.includes(q) || l.source.includes(q))
    .map((l) => ({
      seq: l.id,
      ts: l.timestamp,
      level: l.level || 'INFO',
      logger: l.source || 'audit',
      message: l.message,
      ledger_id: null,
      user_id: null,
      device_id: null,
      metadata: {} as Record<string, unknown>,
    }));

  return c.json({
    items,
    capacity: 1000,
    latest_seq: items.length > 0 ? items[items.length - 1].seq : 0,
  });
});

// ---------------------------------------------------------------------------
// POST /admin/backups/create - 创建本地备份快照
// ---------------------------------------------------------------------------

const BackupCreateSchema = z.object({
  ledger_id: z.string().optional(),
  note: z.string().optional(),
});

adminRouter.post('/backups/create', zValidator('json', BackupCreateSchema), async (c) => {
  const db = c.env.DB;
  const userId = c.get('userId');
  const { ledger_id: ledgerId, note } = c.req.valid('json');
  const serverNow = nowUtc();

  if (!ledgerId) {
    return c.json({ error: 'ledger_id is required' }, 400);
  }

  const ledger = await db
    .prepare('SELECT id, external_id FROM ledgers WHERE user_id = ? AND external_id = ?')
    .bind(userId, ledgerId)
    .first<{ id: string; external_id: string }>();

  if (!ledger) {
    return c.json({ error: 'Ledger not found' }, 404);
  }

  const transactions = await db
    .prepare('SELECT * FROM read_tx_projection WHERE ledger_id = ?')
    .bind(ledger.id)
    .all();
  const accounts = await db
    .prepare('SELECT * FROM user_account_projection WHERE user_id = ?')
    .bind(userId)
    .all();
  const categories = await db
    .prepare('SELECT * FROM user_category_projection WHERE user_id = ?')
    .bind(userId)
    .all();
  const tags = await db
    .prepare('SELECT * FROM user_tag_projection WHERE user_id = ?')
    .bind(userId)
    .all();
  const budgets = await db
    .prepare('SELECT * FROM read_budget_projection WHERE ledger_id = ?')
    .bind(ledger.id)
    .all();

  const snapshotData = {
    ledger_external_id: ledger.external_id,
    transactions: transactions.results,
    accounts: accounts.results,
    categories: categories.results,
    tags: tags.results,
    budgets: budgets.results,
    exported_at: serverNow,
  };

  const snapshotJson = JSON.stringify(snapshotData);
  const snapshotId = randomUUID();

  await db
    .prepare(
      `INSERT INTO backup_snapshots (id, user_id, ledger_id, snapshot_json, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(snapshotId, userId, ledger.id, snapshotJson, note || `Admin backup ${serverNow}`, serverNow)
    .run();

  return c.json({
    snapshot_id: snapshotId,
    ledger_id: ledger.external_id,
    created_at: serverNow,
  }, 201);
});

// ---------------------------------------------------------------------------
// GET /admin/backups/artifacts - 列出备份产物（对齐原版，读 backup_artifacts 表）
// ---------------------------------------------------------------------------

adminRouter.get('/backups/artifacts', async (c) => {
  const db = c.env.DB;
  const userId = c.get('userId');
  const ledgerId = c.req.query('ledger_id') || undefined;
  const kind = c.req.query('kind') || undefined;
  const limit = Math.max(1, Math.min(parseInt(c.req.query('limit') || '100', 10) || 100, 500));

  let q = `SELECT a.id, a.user_id, a.ledger_id, a.kind, a.file_name, a.content_type,
                  a.checksum_sha256, a.size_bytes, a.metadata_json, a.created_at,
                  l.external_id
           FROM backup_artifacts a
           LEFT JOIN ledgers l ON l.id = a.ledger_id`;
  const conds = ['a.user_id = ?'];
  const p: unknown[] = [userId];

  if (ledgerId) {
    // ledger_id 是 external_id（前端传的），先查内部 id
    const led = await db.prepare('SELECT id FROM ledgers WHERE user_id = ? AND external_id = ?').bind(userId, ledgerId).first<{ id: string }>();
    if (!led) return c.json([]);
    conds.push('a.ledger_id = ?');
    p.push(led.id);
  }
  if (kind) {
    conds.push('a.kind = ?');
    p.push(kind);
  }
  q += ' WHERE ' + conds.join(' AND ');
  q += ' ORDER BY a.created_at DESC LIMIT ?';
  p.push(limit);

  const rows = await db.prepare(q).bind(...p).all<{
    id: string; ledger_id: string | null; kind: string; file_name: string; content_type: string | null;
    checksum_sha256: string; size_bytes: number; metadata_json: string | null;
    created_at: string; external_id: string | null; user_id: string;
  }>();

  const items = rows.results.map((row) => {
    let metadata: Record<string, unknown> = {};
    try { metadata = row.metadata_json ? JSON.parse(row.metadata_json) : {}; } catch { /* ignore */ }
    const meta = { ...metadata };
    const note = typeof meta.note === 'string' ? meta.note : null;
    delete meta.note;
    return {
      id: row.id,
      ledger_id: row.external_id || row.ledger_id || '',
      kind: row.kind,
      file_name: row.file_name,
      content_type: row.content_type,
      checksum: row.checksum_sha256,
      size: row.size_bytes,
      created_at: row.created_at,
      created_by: row.user_id,
      note,
      metadata: meta,
    };
  });

  return c.json(items);
});

// ---------------------------------------------------------------------------
// POST /admin/backups/restore - 恢复备份
// ---------------------------------------------------------------------------

const BackupRestoreSchema = z.object({
  snapshot_id: z.string(),
  device_id: z.string().optional(),
});

adminRouter.post('/backups/restore', zValidator('json', BackupRestoreSchema), async (c) => {
  const db = c.env.DB;
  const userId = c.get('userId');
  const { snapshot_id: artifact_id, device_id } = c.req.valid('json');
  const serverNow = nowUtc();

  const snapshot = await db
    .prepare('SELECT * FROM backup_snapshots WHERE id = ?')
    .bind(artifact_id)
    .first<{ id: string; user_id: string; ledger_id: string; snapshot_json: string }>();

  if (!snapshot) {
    return c.json({ error: 'Backup artifact not found' }, 404);
  }

  let snapshotData: Record<string, unknown>;
  try {
    snapshotData = JSON.parse(snapshot.snapshot_json);
  } catch {
    return c.json({ error: 'Invalid snapshot data' }, 400);
  }

  const ledgerExternalId = (snapshotData as { ledger_external_id?: string }).ledger_external_id;

  let targetLedger = await db
    .prepare('SELECT id, external_id FROM ledgers WHERE user_id = ? AND external_id = ?')
    .bind(userId, ledgerExternalId)
    .first<{ id: string; external_id: string }>();

  if (!targetLedger) {
    targetLedger = await db
      .prepare('SELECT id, external_id FROM ledgers WHERE user_id = ? LIMIT 1')
      .bind(userId)
      .first<{ id: string; external_id: string }>();
  }

  if (!targetLedger) {
    return c.json({ error: 'No ledger found to restore into' }, 404);
  }

  let restoredTransactions = 0;

  const transactions = (snapshotData as { transactions?: unknown[] }).transactions;
  if (Array.isArray(transactions)) {
    for (const tx of transactions) {
      const txRecord = tx as Record<string, unknown>;
      const syncId = txRecord.sync_id as string;
      if (!syncId) continue;

      // restore all transactions from snapshot

      await db
        .prepare('DELETE FROM read_tx_projection WHERE ledger_id = ? AND sync_id = ?')
        .bind(targetLedger.id, syncId)
        .run();

      await db
        .prepare(
          `INSERT OR REPLACE INTO read_tx_projection
           (ledger_id, sync_id, user_id, tx_type, amount, happened_at, note,
            category_sync_id, category_name, category_kind,
            account_sync_id, account_name,
            from_account_sync_id, from_account_name,
            to_account_sync_id, to_account_name,
            tags_csv, tag_sync_ids_json, attachments_json, tx_index, source_change_id,
            exclude_from_stats, exclude_from_budget,
            created_by_user_id, last_edited_by_user_id,
            currency_code, native_amount)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          targetLedger.id, syncId, userId,
          txRecord.tx_type, txRecord.amount, txRecord.happened_at, txRecord.note ?? null,
          txRecord.category_sync_id ?? null, txRecord.category_name ?? null, txRecord.category_kind ?? null,
          txRecord.account_sync_id ?? null, txRecord.account_name ?? null,
          txRecord.from_account_sync_id ?? null, txRecord.from_account_name ?? null,
          txRecord.to_account_sync_id ?? null, txRecord.to_account_name ?? null,
          txRecord.tags_csv ?? null, txRecord.tag_sync_ids_json ?? null, txRecord.attachments_json ?? null,
          txRecord.tx_index ?? 0, txRecord.source_change_id ?? 0,
          txRecord.exclude_from_stats != null ? (txRecord.exclude_from_stats ? 1 : 0) : null,
          txRecord.exclude_from_budget != null ? (txRecord.exclude_from_budget ? 1 : 0) : null,
          txRecord.created_by_user_id ?? null, txRecord.last_edited_by_user_id ?? null,
          txRecord.currency_code ?? null, txRecord.native_amount ?? null,
        )
        .run();

      restoredTransactions++;
    }
  }

  await insertAuditLog({
    db, userId, ledgerId: targetLedger.id, action: 'restore', entityType: 'backup_snapshot',
    details: { artifact_id, restored_transactions: restoredTransactions },
  });

  return c.json({
    restored: true,
    ledger_id: ledgerExternalId,
    change_id: 0,
  });
});

// ---------------------------------------------------------------------------
// GET /admin/sync/errors - 查看同步错误
// ---------------------------------------------------------------------------

adminRouter.get('/sync/errors', async (c) => {
  const db = c.env.DB;
  const limit = Math.min(parseInt(c.req.query('limit') ?? '100', 10), 1000);

  const rows = await db
    .prepare(
      `SELECT sc.change_id, sc.user_id, sc.ledger_id, sc.entity_type, sc.entity_sync_id,
              sc.action, sc.payload_json, sc.updated_at, sc.updated_by_device_id, sc.updated_by_user_id,
              l.external_id as ledger_external_id, l.name as ledger_name, u.email as user_email
       FROM sync_changes sc
       LEFT JOIN ledgers l ON l.id = sc.ledger_id
       LEFT JOIN users u ON u.id = sc.user_id
       WHERE sc.action = 'delete'
          OR sc.payload_json = '{}'
          OR sc.payload_json IS NULL
       ORDER BY sc.change_id DESC
       LIMIT ?`
    )
    .bind(limit)
    .all<{
      change_id: number;
      user_id: string;
      ledger_id: string;
      entity_type: string;
      entity_sync_id: string;
      action: string;
      payload_json: string;
      updated_at: string;
      updated_by_device_id: string | null;
      updated_by_user_id: string | null;
      ledger_external_id: string | null;
      ledger_name: string | null;
      user_email: string | null;
    }>();

  const errors = rows.results.map((row) => ({
    change_id: row.change_id,
    entity_type: row.entity_type,
    entity_sync_id: row.entity_sync_id,
    action: row.action,
    error_type: row.action === 'delete' ? 'delete_tombstone' : 'empty_payload',
    updated_at: row.updated_at,
    device_id: row.updated_by_device_id,
    user_id: row.user_id,
    user_email: row.user_email,
    ledger_id: row.ledger_external_id,
    ledger_name: row.ledger_name,
  }));

  return c.json({ errors, count: errors.length });
});

// Integrity scan endpoint
adminRouter.get('/integrity/scan', async (c) => {
  const db = c.env.DB;
  
  try {
    const ledgersTotal = await db
      .prepare('SELECT COUNT(*) as cnt FROM ledgers')
      .first<{ cnt: number }>();
    
    const orphanedSyncChanges = await db
      .prepare(
        `SELECT sc.ledger_id, sc.entity_sync_id, l.name as ledger_name, u.email as owner_email, COUNT(*) as cnt
         FROM sync_changes sc
         LEFT JOIN ledgers l ON l.id = sc.ledger_id
         LEFT JOIN users u ON u.id = l.user_id
         WHERE sc.ledger_id IS NOT NULL
           AND sc.entity_type NOT IN ('category', 'account', 'tag')
           AND NOT EXISTS (SELECT 1 FROM ledgers l WHERE l.id = sc.ledger_id)
         GROUP BY sc.ledger_id
         LIMIT 10`
      )
      .all<{ ledger_id: string; entity_sync_id: string; ledger_name: string | null; owner_email: string | null; cnt: number }>();
    
    const issues: any[] = [];
    
    if (orphanedSyncChanges.results.length > 0) {
      issues.push({
        issue_type: 'orphaned_sync_changes',
        ledger_id: '',
        ledger_name: 'Unknown',
        owner_email: null,
        count: orphanedSyncChanges.results.reduce((sum, r) => sum + r.cnt, 0),
        samples: orphanedSyncChanges.results.slice(0, 5).map(r => ({
          sync_id: r.entity_sync_id,
          label: r.entity_sync_id,
        })),
      });
    }
    
    return c.json({
      scanned_at: new Date().toISOString(),
      ledgers_total: ledgersTotal?.cnt ?? 0,
      issues_total: issues.reduce((sum, i) => sum + i.count, 0),
      issues,
    });
  } catch (error) {
    serverLogger.error('src.routers.admin', '[INTEGRITY] Scan error:', error);
    return c.json({
      scanned_at: new Date().toISOString(),
      ledgers_total: 0,
      issues_total: 0,
      issues: [],
    });
  }
});

// ---------------------------------------------------------------------------
// GET /admin/data-cleanup/scan - 扫描孤立数据
// ---------------------------------------------------------------------------

adminRouter.get('/data-cleanup/scan', async (c) => {
  const db = c.env.DB;
  const { scanAll } = await import('../services/data-cleanup/scanner');
  const report = await scanAll(db, c.env.R2);
  return c.json(report);
});

// ---------------------------------------------------------------------------
// POST /admin/data-cleanup/clean - 清理孤立数据
// ---------------------------------------------------------------------------

adminRouter.post('/data-cleanup/clean', async (c) => {
  const db = c.env.DB;
  const body = await c.req.json().catch(() => ({ records: [] }));
  const { clean } = await import('../services/data-cleanup/cleaner');
  const result = await clean(db, body.records || [], c.env.R2);
  return c.json(result);
});

// ---------------------------------------------------------------------------
// GET /admin/r2/attachment-orphans - 列出 R2 中无 DB 引用的附件孤儿（只读）
// 扫描 R2 的 attachments 前缀对象，与 attachment_files 表的 storage_path 比对，
// 返回 R2 有但 DB 无引用的孤儿文件清单（key / size / uploaded）。只读，不删除。
// ---------------------------------------------------------------------------

adminRouter.get('/r2/attachment-orphans', async (c) => {
  const r2 = c.env.R2;
  if (!r2) return c.json({ error: 'R2 not configured' }, 400);
  const db = c.env.DB;

  // 收集 DB 中所有附件 storage_path（去掉 beecount/ 前缀后作为已知 key 集合）
  const rows = await db
    .prepare(`SELECT storage_path FROM attachment_files WHERE storage_path IS NOT NULL AND storage_path != ''`)
    .all<{ storage_path: string }>();
  const knownKeys = new Set<string>();
  for (const r of rows.results) {
    knownKeys.add(r.storage_path.replace(/^beecount\//, ''));
  }

  // 列出 R2 中 attachments 前缀的对象（含新旧两种前缀；beecount/attachments/ 与
  // attachments/ 互不重叠，分别列取）
  const objects: { key: string; size: number; uploaded: string }[] = [];
  for (const prefix of ['beecount/attachments/', 'attachments/']) {
    let cursor: string | undefined;
    do {
      const listing = await r2.list({ prefix, limit: 1000, cursor });
      for (const obj of listing.objects) {
        objects.push({ key: obj.key, size: obj.size, uploaded: obj.uploaded.toISOString() });
      }
      cursor = listing.truncated ? listing.objects[listing.objects.length - 1].key : undefined;
    } while (cursor);
  }

  // 孤儿 = R2 有但 DB 无引用
  const orphans = objects.filter(o => !knownKeys.has(o.key.replace(/^beecount\//, '')));
  const totalSize = orphans.reduce((sum, o) => sum + o.size, 0);

  return c.json({
    total: orphans.length,
    total_size: totalSize,
    scanned: objects.length,
    orphans: orphans.sort((a, b) => a.key.localeCompare(b.key)),
  });
});

// ---------------------------------------------------------------------------
// GET /admin/attachments/integrity - 附件完整性检查（只读）
// 对每个被交易引用的附件 cloudFileId，核对：
//   A. attachment_files 表行是否存在
//   B. R2 原图（表行 storage_path / 约定 key）是否存在
//   C. R2 缩略图/分享图（_scaled_/_shared_）是否存在
// 输出分类统计，帮助判断：原图丢失 / 仅缺表行 / 表行+原图都在 / 真孤儿。
// 只读，不删除不修改。
// ---------------------------------------------------------------------------

adminRouter.get('/attachments/integrity', async (c) => {
  const r2 = c.env.R2;
  const db = c.env.DB;
  if (!r2) return c.json({ error: 'R2 not configured' }, 400);

  // 1. 收集所有 attachment_files 行（id → 元数据）
  const attRows = await db.prepare(
    `SELECT id, ledger_id, user_id, file_name, storage_path, sha256, size_bytes FROM attachment_files`
  ).all<{ id: string; ledger_id: string | null; user_id: string; file_name: string | null; storage_path: string; sha256: string | null; size_bytes: number | null }>();
  const attById = new Map<string, typeof attRows.results[number]>();
  for (const r of attRows.results) attById.set(r.id, r);

  // 2. 收集所有交易引用的 cloudFileId
  const txRows = await db.prepare(
    `SELECT ledger_id, sync_id, user_id, attachments_json FROM read_tx_projection WHERE attachments_json IS NOT NULL AND attachments_json != ''`
  ).all<{ ledger_id: string; sync_id: string; user_id: string; attachments_json: string }>();

  const referenced = new Map<string, { file_id: string; ledger_id: string; sync_id: string; user_id: string }>();
  for (const row of txRows.results) {
    try {
      const atts = JSON.parse(row.attachments_json);
      if (!Array.isArray(atts)) continue;
      for (const att of atts) {
        if (!att || typeof att !== 'object') continue;
        const fid = (att as Record<string, unknown>).cloudFileId;
        if (typeof fid === 'string' && fid && !referenced.has(fid)) {
          referenced.set(fid, { file_id: fid, ledger_id: row.ledger_id, sync_id: row.sync_id, user_id: row.user_id });
        }
      }
    } catch {}
  }

  // 3. 列出 R2 attachments 前缀对象（原图 + 缩略图）
  const r2Keys: string[] = [];
  for (const prefix of ['beecount/attachments/', 'attachments/']) {
    let cursor: string | undefined;
    do {
      const listing = await r2.list({ prefix, limit: 1000, cursor });
      for (const obj of listing.objects) r2Keys.push(obj.key);
      cursor = listing.truncated && listing.objects.length > 0
        ? listing.objects[listing.objects.length - 1].key
        : undefined;
    } while (cursor);
  }
  // 精确 key（去前缀）集合 + 按 fileId/sha 前缀索引缩略图
  const exactKeys = new Set(r2Keys.map(k => k.replace(/^beecount\//, '')));
  const thumbnailByPrefix = new Map<string, string[]>();
  for (const key of r2Keys) {
    const base = key.replace(/^beecount\//, '');
    const m = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/.exec(base.split('/').pop() || '');
    if (m) {
      const arr = thumbnailByPrefix.get(m[1]) || [];
      arr.push(key);
      thumbnailByPrefix.set(m[1], arr);
    }
  }

  // 4. 逐附件分类
  const result = {
    scanned_attachments: referenced.size,
    attachment_rows: attRows.results.length,
    r2_objects: r2Keys.length,
    by_status: {} as Record<string, number>,
    missing_original_samples: [] as Array<Record<string, unknown>>,
    missing_all_samples: [] as Array<Record<string, unknown>>,
    ok_samples: [] as Array<Record<string, unknown>>,
  };

  for (const [fileId, ref] of referenced) {
    const row = attById.get(fileId);
    // 原图存在判定：表行 storage_path 精确命中，或按约定 key 命中
    let originalExists = false;
    if (row) {
      const sp = row.storage_path.replace(/^beecount\//, '');
      if (exactKeys.has(sp)) originalExists = true;
      else {
        // 兼容：{ledgerId}/{fileId}_{fileName} 约定 key
        const ledgerExt = row.ledger_id ?? '';
        const fname = row.file_name ?? '';
        const alt1 = `attachments/${ledgerExt}/${fileId}_${fname}`;
        const alt2 = `attachments/${fileId}_${fname}`;
        if (exactKeys.has(alt1) || exactKeys.has(alt2)) originalExists = true;
      }
    }
    const thumbs = thumbnailByPrefix.get(fileId) || [];

    let status: string;
    if (!row) {
      status = originalExists ? 'missing_row_but_original_exists' : (thumbs.length > 0 ? 'missing_row_only_thumbnail' : 'missing_row_no_file');
    } else if (!originalExists) {
      status = 'row_exists_but_original_missing';
    } else {
      status = 'ok';
    }
    result.by_status[status] = (result.by_status[status] || 0) + 1;

    const sample = {
      file_id: fileId,
      ledger_id: ref.ledger_id,
      sync_id: ref.sync_id,
      user_id: ref.user_id,
      has_row: !!row,
      original_exists: originalExists,
      thumbnails: thumbs,
      storage_path: row?.storage_path ?? null,
    };
    if (status.startsWith('missing_row_but_original') || status === 'row_exists_but_original_missing') {
      if (result.missing_original_samples.length < 20) result.missing_original_samples.push(sample);
    } else if (status.startsWith('missing_row_no_file')) {
      if (result.missing_all_samples.length < 20) result.missing_all_samples.push(sample);
    } else if (status === 'ok') {
      if (result.ok_samples.length < 5) result.ok_samples.push(sample);
    }
  }

  return c.json(result);
});

// ---------------------------------------------------------------------------
// POST /admin/attachments/backfill - 补登缺失的 attachment_files 行（幂等）
// 扫描 read_tx_projection.attachments_json 引用的 cloudFileId，
// 对 attachment_files 无行的：从 R2 找到对应对象，读内容算 sha256 + size，
// 插入 attachment_files 行（id=cloudFileId, storage_path=R2 key）。
// 只补"缺行但 R2 有文件"的附件；完全无文件的不处理（那是真失效，走清理）。
// ---------------------------------------------------------------------------

adminRouter.post('/attachments/backfill', async (c) => {
  const r2 = c.env.R2;
  const db = c.env.DB;
  if (!r2) return c.json({ error: 'R2 not configured' }, 400);

  // 1. 现有 attachment_files 行 id 集合
  const idRows = await db.prepare('SELECT id FROM attachment_files').all<{ id: string }>();
  const existingIds = new Set(idRows.results.map(r => r.id));

  // 2. 收集所有交易引用的 cloudFileId（含缺失的）
  const txRows = await db.prepare(
    `SELECT ledger_id, sync_id, user_id, attachments_json FROM read_tx_projection WHERE attachments_json IS NOT NULL AND attachments_json != ''`
  ).all<{ ledger_id: string; sync_id: string; user_id: string; attachments_json: string }>();

  const missingRefs = new Map<string, { ledger_id: string; user_id: string }>();
  for (const row of txRows.results) {
    try {
      const atts = JSON.parse(row.attachments_json);
      if (!Array.isArray(atts)) continue;
      for (const att of atts) {
        if (!att || typeof att !== 'object') continue;
        const fid = (att as Record<string, unknown>).cloudFileId;
        if (typeof fid === 'string' && fid && !existingIds.has(fid) && !missingRefs.has(fid)) {
          missingRefs.set(fid, { ledger_id: row.ledger_id, user_id: row.user_id });
        }
      }
    } catch {}
  }

  // 3. 列出 R2 attachments 对象，按 fileId 前缀索引
  const objByPrefix = new Map<string, { key: string; size: number }[]>();
  for (const prefix of ['beecount/attachments/', 'attachments/']) {
    let cursor: string | undefined;
    do {
      const listing = await r2.list({ prefix, limit: 1000, cursor });
      for (const obj of listing.objects) {
        const m = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/.exec(obj.key.split('/').pop() || '');
        if (m) {
          const arr = objByPrefix.get(m[1]) || [];
          arr.push({ key: obj.key, size: obj.size });
          objByPrefix.set(m[1], arr);
        }
      }
      cursor = listing.truncated && listing.objects.length > 0
        ? listing.objects[listing.objects.length - 1].key
        : undefined;
    } while (cursor);
  }

  // 4. 逐缺失附件补登
  const backfilled: Array<Record<string, unknown>> = [];
  const failed: Array<{ file_id: string; reason: string }> = [];

  for (const [fileId, ref] of missingRefs) {
    const objects = objByPrefix.get(fileId) || [];
    // 优先选不带 _scaled_/_shared_ 的"主文件"，否则取第一个对象
    const main = objects.find(o => !/_scaled_\d+\.jpg$/.test(o.key) && !/_shared_\d+\.jpg$/.test(o.key)) || objects[0];
    if (!main) {
      failed.push({ file_id: fileId, reason: 'R2 无此文件' });
      continue;
    }
    try {
      // 读对象内容算 sha256（最终展示文件自身的 sha，满足 NOT NULL 且真实）
      const obj = await r2.get(main.key);
      if (!obj) {
        failed.push({ file_id: fileId, reason: 'R2 get 失败' });
        continue;
      }
      const buf = await obj.arrayBuffer();
      const digest = await crypto.subtle.digest('SHA-256', buf);
      const shaHex = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
      const fileName = main.key.split('/').pop() || fileId;
      const size = main.size || buf.byteLength;
      const mime = /\.png$/i.test(fileName) ? 'image/png' : /\.webp$/i.test(fileName) ? 'image/webp' : /\.gif$/i.test(fileName) ? 'image/gif' : /\.jpe?g$/i.test(fileName) ? 'image/jpeg' : 'application/octet-stream';

      await db.prepare(
        `INSERT OR IGNORE INTO attachment_files (id, ledger_id, user_id, sha256, size_bytes, mime_type, file_name, storage_path, attachment_kind, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'transaction', ?)`
      ).bind(fileId, ref.ledger_id, ref.user_id, shaHex, size, mime, fileName, main.key, new Date().toISOString()).run();

      backfilled.push({ file_id: fileId, storage_path: main.key, size, sha256: shaHex.slice(0, 12) + '…', ledger_id: ref.ledger_id, user_id: ref.user_id });
    } catch (err) {
      failed.push({ file_id: fileId, reason: (err as Error).message });
    }
  }

  return c.json({ backfilled, failed, backfilled_count: backfilled.length, failed_count: failed.length });
});

export default adminRouter;
