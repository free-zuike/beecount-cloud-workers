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
  R2?: R2Bucket;
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
    
    // 获取系统设置的时区（可能是分钟或秒，需要兼容旧数据）
    let timezoneOffset = 0;
    try {
      const settings = await db.prepare('SELECT timezone_offset FROM system_settings WHERE id = ?').bind('default').first<{ timezone_offset: number }>();
      if (settings && settings.timezone_offset !== null) {
        // 如果值大于 1000，认为是秒（旧数据），转换为分钟
        timezoneOffset = settings.timezone_offset > 1000 
          ? Math.floor(settings.timezone_offset / 60) 
          : settings.timezone_offset;
      }
    } catch {}
    
    // 根据设置的时区调整时间：
    // 获取当前UTC时间，然后根据存储的时区偏移（分钟）计算目标时间
    const now = new Date();
    // 计算UTC时间加上时区偏移（分钟）后的时间
    const localTime = new Date(now.getTime() + timezoneOffset * 60 * 1000);
    
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
      time: localTime.toISOString(),
      timezone_offset: timezoneOffset,
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

  // 清理 R2 存储文件（avatars + category-icons + attachments）
  if (c.env.R2) {
    try {
      // 1. 清理头像
      const profile = await db.prepare('SELECT avatar_file_id FROM user_profiles WHERE user_id = ?')
        .bind(userId).first<{ avatar_file_id: string | null }>();
      if (profile?.avatar_file_id) {
        try { await c.env.R2.delete(`avatars/${userId}/${profile.avatar_file_id}`); } catch {}
      }

      // 2. 清理分类图标
      const iconFiles = await db.prepare(
        "SELECT storage_path FROM attachment_files WHERE user_id = ? AND attachment_kind = 'category_icon'"
      ).bind(userId).all<{ storage_path: string }>();
      for (const f of iconFiles.results) {
        try { await c.env.R2.delete(f.storage_path); } catch {}
      }

      // 3. 清理附件文件
      const attFiles = await db.prepare(
        "SELECT storage_path FROM attachment_files WHERE user_id = ? AND attachment_kind = 'transaction'"
      ).bind(userId).all<{ storage_path: string }>();
      for (const f of attFiles.results) {
        try { await c.env.R2.delete(f.storage_path); } catch {}
      }
    } catch (e) {
      console.log('[ADMIN] R2 cleanup failed (non-fatal):', e);
    }
  }

  // 撤销该用户的所有 refresh tokens（防止已删除用户的 token 仍可使用）
  await db
    .prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL')
    .bind(nowUtc(), userId)
    .run();

  // 物理删除（CASCADE 会删除关联数据）
  await db.prepare('DELETE FROM users WHERE id = ?').bind(userId).run();

  return c.json({ id: userId, email: null, is_admin: false, is_enabled: false, created_at: null });
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
  new_password: z.string().min(8)
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
    .prepare('SELECT * FROM read_account_projection WHERE ledger_id = ?')
    .bind(ledger.id)
    .all();
  const categories = await db
    .prepare('SELECT * FROM read_category_projection WHERE ledger_id = ?')
    .bind(ledger.id)
    .all();
  const tags = await db
    .prepare('SELECT * FROM read_tag_projection WHERE ledger_id = ?')
    .bind(ledger.id)
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
// GET /admin/backups/artifacts - 列出备份文件
// ---------------------------------------------------------------------------

adminRouter.get('/backups/artifacts', async (c) => {
  const db = c.env.DB;

  const rows = await db
    .prepare(
      `SELECT bs.id, bs.ledger_id, bs.created_at, bs.user_id, LENGTH(bs.snapshot_json) as size, bs.note
       FROM backup_snapshots bs
       ORDER BY bs.created_at DESC`
    )
    .all<{ id: string; ledger_id: string; created_at: string; user_id: string; size: number; note: string | null }>();

  const items = rows.results.map((row) => ({
    id: row.id,
    ledger_id: row.ledger_id,
    kind: 'snapshot',
    file_name: `${row.id}.json`,
    content_type: 'application/json',
    checksum: '',
    size: row.size,
    created_at: row.created_at,
    created_by: row.user_id,
    note: row.note,
    metadata: {},
  }));

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
            tags_csv, tag_sync_ids_json, attachments_json, tx_index, source_change_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
    console.error('[INTEGRITY] Scan error:', error);
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

  const dbOrphans: unknown[] = [];
  const fileOrphans: unknown[] = [];
  const syncOrphans: unknown[] = [];

  // 查找没有对应 sync_changes 的 projection 记录
  const orphanTx = await db.prepare(`
    SELECT p.sync_id, p.ledger_id FROM read_tx_projection p
    LEFT JOIN sync_changes c ON p.sync_id = c.entity_sync_id AND c.entity_type = 'transaction'
    WHERE c.change_id IS NULL LIMIT 100
  `).all();

  for (const row of orphanTx.results) {
    syncOrphans.push({ type: 'transaction', sync_id: (row as any).sync_id, ledger_id: (row as any).ledger_id });
  }

  return c.json({
    db_orphans: dbOrphans,
    file_orphans: fileOrphans,
    sync_orphans: syncOrphans,
    total_count: syncOrphans.length,
    total_size_bytes: 0,
  });
});

// ---------------------------------------------------------------------------
// POST /admin/data-cleanup/clean - 清理孤立数据
// ---------------------------------------------------------------------------

adminRouter.post('/data-cleanup/clean', async (c) => {
  const db = c.env.DB;
  const userId = c.get('userId');
  const body = await c.req.json().catch(() => ({ records: [] }));
  const records = (body.records || []) as Array<{ type: string; sync_id?: string; row_id?: string; file_path?: string }>;

  let successCount = 0;
  const failures: Array<{ record_key: string; error: string }> = [];

  for (const record of records) {
    try {
      if (record.sync_id && record.type === 'transaction') {
        await db.prepare('DELETE FROM read_tx_projection WHERE sync_id = ?').bind(record.sync_id).run();
        successCount++;
      } else {
        failures.push({ record_key: record.sync_id || record.row_id || 'unknown', error: 'Unsupported cleanup type' });
      }
    } catch (err) {
      failures.push({ record_key: record.sync_id || 'unknown', error: (err as Error).message });
    }
  }

  return c.json({ success_count: successCount, failures });
});

// ---------------------------------------------------------------------------
// GET /admin/debug/snapshot/:ledgerExternalId - 调试账本快照
// ---------------------------------------------------------------------------

adminRouter.get('/debug/snapshot/:ledgerExternalId', async (c) => {
  const db = c.env.DB;
  const ledgerExtId = c.req.param('ledgerExternalId');
  const recentChanges = parseInt(c.req.query('recent_changes') ?? '50', 10);

  const ledger = await db
    .prepare('SELECT id, external_id, name, user_id FROM ledgers WHERE external_id = ?')
    .bind(ledgerExtId)
    .first<{ id: string; external_id: string; name: string; user_id: string }>();

  if (!ledger) return c.json({ error: 'Ledger not found' }, 404);

  const changes = await db
    .prepare(`SELECT change_id, entity_type, entity_sync_id, action, updated_at
              FROM sync_changes WHERE ledger_id = ? ORDER BY change_id DESC LIMIT ?`)
    .bind(ledger.id, recentChanges)
    .all();

  return c.json({
    ledger: { id: ledger.external_id, name: ledger.name, user_id: ledger.user_id },
    recent_changes: changes.results,
  });
});

export default adminRouter;
