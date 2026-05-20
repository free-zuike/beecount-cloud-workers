/**
 * 管理路由模块 - 实现 BeeCount Cloud 管理员接口
 *
 * 参考原版 BeeCount-Cloud (Python/FastAPI) 的 /admin 端点：
 * - GET  /admin/overview        - 获取系统概览
 * - GET  /admin/health         - 健康检查
 * - GET  /admin/integrity/scan - 数据完整性扫描
 * - GET  /admin/sync/errors    - 同步错误列表
 * - GET  /admin/users           - 列出所有用户
 * - POST /admin/users           - 创建用户
 * - PATCH /admin/users/:id     - 更新用户
 * - DELETE /admin/users/:id    - 删除用户
 * - GET  /admin/devices         - 列出所有设备
 * - GET  /admin/logs            - 获取最近日志
 * - GET  /admin/backups/artifacts - 备份列表
 * - POST /admin/backups/create  - 创建备份
 * - POST /admin/backups/restore - 恢复备份
 *
 * @module routes/admin
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { hashPassword } from '../auth';

function nowUtc(): string {
  return new Date().toISOString();
}

const AdminUserCreateSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  is_admin: z.boolean().default(false),
  is_enabled: z.boolean().default(true),
});

const AdminUserPatchSchema = z.object({
  email: z.string().email().optional(),
  is_enabled: z.boolean().optional(),
});

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

interface AdminOverviewOut {
  users_total: number;
  users_enabled_total: number;
  ledgers_total: number;
  transactions_total: number;
  accounts_total: number;
  categories_total: number;
  tags_total: number;
}

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

type Bindings = {
  DB: D1Database;
  JWT_SECRET: string;
};

type Variables = {
  userId: string;
};

const adminRouter = new Hono<{ Bindings: Bindings; Variables: Variables }>();

adminRouter.post('/grant-me-admin', async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;

  await db
    .prepare('UPDATE users SET is_admin = 1 WHERE id = ?')
    .bind(userId)
    .run();

  const user = await db
    .prepare('SELECT id, email, is_admin FROM users WHERE id = ?')
    .bind(userId)
    .first<{ id: string; email: string; is_admin: number }>();

  return c.json({
    success: true,
    user: {
      id: user?.id,
      email: user?.email,
      is_admin: Boolean(user?.is_admin),
    },
  });
});

adminRouter.use('/*', async (c, next) => {
  if (c.req.path === '/grant-me-admin') {
    await next();
    return;
  }

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

  return c.json({
    users_total: usersTotal?.cnt ?? 0,
    users_enabled_total: usersEnabled?.cnt ?? 0,
    ledgers_total: ledgersTotal?.cnt ?? 0,
    transactions_total: transactionsTotal?.cnt ?? 0,
    accounts_total: accountsTotal?.cnt ?? 0,
    categories_total: categoriesTotal?.cnt ?? 0,
    tags_total: tagsTotal?.cnt ?? 0,
  } as AdminOverviewOut);
});

adminRouter.get('/health', async (c) => {
  const db = c.env.DB;
  let dbStatus = 'ok';

  try {
    await db.prepare('SELECT 1').first();
  } catch {
    dbStatus = 'error';
  }

  return c.json({
    status: dbStatus === 'ok' ? 'healthy' : 'degraded',
    db: dbStatus,
    online_ws_users: 0,
    time: new Date().toISOString(),
  });
});

adminRouter.get('/integrity/scan', async (c) => {
  const db = c.env.DB;

  const issues: Array<{
    issue_type: string;
    ledger_id: string;
    ledger_name: string;
    owner_email: string | null;
    count: number;
    samples: Array<{ sync_id: string; label: string; extra: Record<string, unknown> | null }>;
  }> = [];

  try {
    const orphanedTxs = await db
      .prepare(
        `SELECT t.sync_id, t.happened_at, l.id as ledger_id, l.name as ledger_name, u.email as owner_email
         FROM read_tx_projection t
         JOIN ledgers l ON t.ledger_id = l.id
         JOIN users u ON l.user_id = u.id
         WHERE t.happened_at IS NULL OR t.amount IS NULL
         LIMIT 5`
      )
      .all<{ sync_id: string; ledger_id: string; ledger_name: string; owner_email: string | null }>();

    if (orphanedTxs.results.length > 0) {
      const countResult = await db
        .prepare(
          `SELECT COUNT(*) as cnt
           FROM read_tx_projection t
           WHERE t.happened_at IS NULL OR t.amount IS NULL`
        )
        .first<{ cnt: number }>();

      issues.push({
        issue_type: 'orphan_transactions',
        ledger_id: orphanedTxs.results[0].ledger_id,
        ledger_name: orphanedTxs.results[0].ledger_name,
        owner_email: orphanedTxs.results[0].owner_email,
        count: countResult?.cnt ?? orphanedTxs.results.length,
        samples: orphanedTxs.results.map((r) => ({
          sync_id: r.sync_id,
          label: 'Transaction with null happened_at or amount',
          extra: null,
        })),
      });
    }
  } catch (err) {
    console.error('[Integrity] Error scanning transactions:', err);
  }

  const ledgersResult = await db.prepare('SELECT COUNT(*) as cnt FROM ledgers').first<{ cnt: number }>();

  return c.json({
    scanned_at: new Date().toISOString(),
    ledgers_total: ledgersResult?.cnt ?? 0,
    issues_total: issues.length,
    issues,
  });
});

adminRouter.get('/sync/errors', async (c) => {
  const limit = Math.min(parseInt(c.req.query('limit') ?? '50', 10), 500);

  return c.json({
    count: 0,
    items: [],
  });
});

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
    avatar_url: row.avatar_file_id ? `/api/v1/profile/avatar/${row.id}` : null,
    avatar_version: row.avatar_version ?? 0,
  }));

  return c.json({ total: totalRow?.cnt ?? 0, items });
});

adminRouter.post('/users', zValidator('json', AdminUserCreateSchema), async (c) => {
  const db = c.env.DB;
  const req = c.req.valid('json');
  const serverNow = nowUtc();

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

adminRouter.patch('/users/:id', zValidator('json', AdminUserPatchSchema), async (c) => {
  const db = c.env.DB;
  const userId = c.req.param('id');
  const req = c.req.valid('json');

  const user = await db.prepare('SELECT id FROM users WHERE id = ?').bind(userId).first();

  if (!user) {
    return c.json({ error: 'User not found' }, 404);
  }

  if (req.email) {
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

  return c.json({
    id: row.id,
    email: row.email,
    is_admin: Boolean(row.is_admin),
    is_enabled: Boolean(row.is_enabled),
    created_at: row.created_at,
    display_name: row.display_name,
    avatar_url: row.avatar_file_id ? `/api/v1/profile/avatar/${row.id}` : null,
    avatar_version: row.avatar_version ?? 0,
  } as AdminUserOut);
});

adminRouter.delete('/users/:id', async (c) => {
  const db = c.env.DB;
  const userId = c.req.param('id');

  const currentUserId = c.get('userId');
  if (userId === currentUserId) {
    return c.json({ error: 'Cannot delete yourself' }, 400);
  }

  const user = await db.prepare('SELECT id FROM users WHERE id = ?').bind(userId).first();

  if (!user) {
    return c.json({ error: 'User not found' }, 404);
  }

  await db.prepare('DELETE FROM users WHERE id = ?').bind(userId).run();

  return c.json({ success: true });
});

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

adminRouter.get('/logs', async (c) => {
  return c.json({
    items: [],
    capacity: 1000,
    latest_seq: 0,
  });
});

adminRouter.get('/backups/artifacts', async (c) => {
  return c.json([]);
});

adminRouter.post('/backups/create', async (c) => {
  return c.json({ error: 'Backup not yet implemented' }, 501);
});

adminRouter.post('/backups/restore', async (c) => {
  return c.json({ error: 'Restore not yet implemented' }, 501);
});

export default adminRouter;
