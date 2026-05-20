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
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { hashPassword } from '../auth';

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

/** 管理员设备输出 */
interface AdminDeviceOut {
  id: string;
  name: string;
  platform: string;
  app_version: string | null;
  os_version: string | null;
  device_model: string | null;
  last_ip: string | null;
  created_at: string;
  last_seen_at: string;
  is_online: boolean;
  user_id: string;
  user_email: string;
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

// ---------------------------------------------------------------------------
// GET /admin/overview - 获取系统概览
// ---------------------------------------------------------------------------

/**
 * 获取系统统计概览
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
    db.prepare('SELECT COUNT(DISTINCT sync_id) as cnt FROM read_account_projection').first<{ cnt: number }>(),
    db.prepare('SELECT COUNT(DISTINCT sync_id) as cnt FROM read_category_projection').first<{ cnt: number }>(),
    db.prepare('SELECT COUNT(DISTINCT sync_id) as cnt FROM read_tag_projection').first<{ cnt: number }>(),
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
  const limit = Math.min(parseInt(c.req.query('limit') ?? '100', 10), 1000);
  const offset = parseInt(c.req.query('offset') ?? '0', 10);

  const rows = await db
    .prepare(
      `SELECT u.id, u.email, u.is_admin, u.is_enabled, u.created_at,
              p.display_name, p.avatar_file_id, p.avatar_version
       FROM users u
       LEFT JOIN user_profiles p ON p.user_id = u.id
       ORDER BY u.created_at DESC
       LIMIT ? OFFSET ?`
    )
    .bind(limit, offset)
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
    .bind(userId, req.email.toLowerCase(), passwordHash, req.is_admin ? 1 : 0, req.is_enabled ? 1 : 0, serverNow)
    .run();

  // 创建用户 profile
  await db
    .prepare(
      `INSERT INTO user_profiles (user_id, display_name, avatar_version)
       VALUES (?, ?, 0)`
    )
    .bind(userId, req.email.split('@')[0])
    .run();

  return c.json({
    id: userId,
    email: req.email.toLowerCase(),
    is_admin: req.is_admin,
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

  // 物理删除（CASCADE 会删除关联数据）
  await db.prepare('DELETE FROM users WHERE id = ?').bind(userId).run();

  return c.json({ success: true });
});

// ---------------------------------------------------------------------------
// GET /admin/devices - 列出所有设备
// ---------------------------------------------------------------------------

/**
 * 获取所有设备列表
 *
 * 功能说明：
 * - 返回所有未撤销的设备
 * - 包含关联的用户信息
 */
adminRouter.get('/devices', async (c) => {
  const db = c.env.DB;
  const limit = Math.min(parseInt(c.req.query('limit') ?? '100', 10), 1000);
  const offset = parseInt(c.req.query('offset') ?? '0', 10);

  const rows = await db
    .prepare(
      `SELECT d.id, d.name, d.platform, d.app_version, d.os_version, d.device_model,
              d.last_ip, d.created_at, d.last_seen_at,
              u.id as user_id, u.email as user_email
       FROM devices d
       JOIN users u ON d.user_id = u.id
       WHERE d.revoked_at IS NULL
       ORDER BY d.last_seen_at DESC
       LIMIT ? OFFSET ?`
    )
    .bind(limit, offset)
    .all<{
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

  // 判断在线状态（5 分钟内有活动视为在线）
  const onlineThreshold = new Date(Date.now() - 5 * 60 * 1000).toISOString();

  const items: AdminDeviceOut[] = rows.results.map((row) => ({
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
  }));

  return c.json({ total: items.length, items });
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
adminRouter.get('/logs', async (c) => {
  const db = c.env.DB;
  const limit = Math.min(parseInt(c.req.query('limit') ?? '100', 10), 1000);

  const rows = await db
    .prepare(
      `SELECT id, user_id, ledger_id, action, metadata_json, created_at
       FROM audit_logs
       ORDER BY id DESC
       LIMIT ?`
    )
    .bind(limit)
    .all<{
      id: number;
      user_id: string | null;
      ledger_id: string | null;
      action: string;
      metadata_json: string;
      created_at: string;
    }>();

  const items = rows.results.map((row) => ({
    seq: row.id,
    ts: row.created_at,
    level: 'INFO',
    logger: 'audit',
    message: row.action,
    ledger_id: row.ledger_id,
    user_id: row.user_id,
    device_id: null,
    metadata: JSON.parse(row.metadata_json || '{}'),
  }));

  return c.json({
    items,
    capacity: 1000,
    latest_seq: rows.results[0]?.id ?? 0,
  });
});

export default adminRouter;
