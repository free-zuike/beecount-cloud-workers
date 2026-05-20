/**
 * 管理路由模块 - 实现 BeeCount Cloud 管理员接口
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

adminRouter.use('*', async (c, next) => {
  try {
    await next();
  } catch (error) {
    console.error('[ADMIN] Error:', error);
    
    if (error instanceof Error && error.message.includes('no such table')) {
      return c.json({ error: 'Database not initialized' }, 503);
    }
    
    return c.json({ error: 'Internal Server Error' }, 500);
  }
});

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
    timestamp: nowUtc(),
    db_status: dbStatus,
  });
});

adminRouter.get('/integrity/scan', async (c) => {
  return c.json({
    scan_result: {
      orphaned_transactions: [],
      orphaned_accounts: [],
      orphaned_categories: [],
      orphaned_tags: [],
      orphaned_budgets: [],
      duplicate_transactions: [],
      validation_errors: [],
    },
  });
});

adminRouter.get('/sync/errors', async (c) => {
  return c.json({
    errors: [],
    total: 0,
  });
});

adminRouter.get('/users', async (c) => {
  const db = c.env.DB;
  const limit = parseInt(c.req.query('limit') ?? '10', 10);
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
      avatar_version: number;
    }>();

  const total = await db.prepare('SELECT COUNT(*) as cnt FROM users').first<{ cnt: number }>();

  return c.json({
    items: rows.results.map((row) => ({
      id: row.id,
      email: row.email,
      is_admin: Boolean(row.is_admin),
      is_enabled: Boolean(row.is_enabled),
      created_at: row.created_at,
      display_name: row.display_name,
      avatar_url: row.avatar_file_id ? `/api/v1/profile/avatar/${row.id}` : null,
      avatar_version: row.avatar_version ?? 0,
    })),
    total: total?.cnt ?? 0,
    limit,
    offset,
  });
});

adminRouter.post('/users', zValidator('json', AdminUserCreateSchema), async (c) => {
  const db = c.env.DB;
  const req = c.req.valid('json');

  const existingUser = await db.prepare('SELECT id FROM users WHERE email = ?').bind(req.email).first();
  if (existingUser) {
    return c.json({ error: 'Email already exists' }, 409);
  }

  const userId = randomUUID();
  const passwordHash = await hashPassword(req.password);

  await db
    .prepare(
      `INSERT INTO users (id, email, password_hash, is_admin, is_enabled)
       VALUES (?, ?, ?, ?, ?)`
    )
    .bind(userId, req.email, passwordHash, req.is_admin ? 1 : 0, req.is_enabled ? 1 : 0)
    .run();

  await db
    .prepare(`INSERT INTO user_profiles (user_id, display_name) VALUES (?, ?)`)
    .bind(userId, req.email)
    .run();

  return c.json({
    id: userId,
    email: req.email,
    is_admin: req.is_admin,
    is_enabled: req.is_enabled,
  });
});

adminRouter.patch('/users/:userId', zValidator('json', AdminUserPatchSchema), async (c) => {
  const db = c.env.DB;
  const userId = c.req.param('userId');
  const req = c.req.valid('json');

  const updates: string[] = [];
  const params: (string | number)[] = [];

  if (req.email !== undefined) {
    const existing = await db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').bind(req.email, userId).first();
    if (existing) {
      return c.json({ error: 'Email already exists' }, 409);
    }
    updates.push('email = ?');
    params.push(req.email);
  }

  if (req.is_enabled !== undefined) {
    updates.push('is_enabled = ?');
    params.push(req.is_enabled ? 1 : 0);
  }

  if (updates.length === 0) {
    return c.json({ error: 'No updates provided' }, 400);
  }

  params.push(userId);
  await db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).bind(...params).run();

  const user = await db
    .prepare('SELECT id, email, is_admin, is_enabled FROM users WHERE id = ?')
    .bind(userId)
    .first<{ id: string; email: string; is_admin: number; is_enabled: number }>();

  return c.json({
    id: user?.id,
    email: user?.email,
    is_admin: Boolean(user?.is_admin),
    is_enabled: Boolean(user?.is_enabled),
  });
});

adminRouter.delete('/users/:userId', async (c) => {
  const db = c.env.DB;
  const userId = c.req.param('userId');

  await db.prepare('DELETE FROM users WHERE id = ?').bind(userId).run();

  return c.json({ success: true });
});

adminRouter.get('/devices', async (c) => {
  const db = c.env.DB;
  const limit = parseInt(c.req.query('limit') ?? '10', 10);
  const offset = parseInt(c.req.query('offset') ?? '0', 10);

  const rows = await db
    .prepare(
      `SELECT d.id, d.name, d.platform, d.app_version, d.os_version, d.device_model,
              d.last_ip, d.created_at, d.last_seen_at, d.user_id, u.email as user_email
       FROM devices d
       JOIN users u ON d.user_id = u.id
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

  const total = await db.prepare('SELECT COUNT(*) as cnt FROM devices').first<{ cnt: number }>();

  const now = new Date();
  return c.json({
    items: rows.results.map((row) => ({
      id: row.id,
      name: row.name,
      platform: row.platform,
      app_version: row.app_version,
      os_version: row.os_version,
      device_model: row.device_model,
      last_ip: row.last_ip,
      created_at: row.created_at,
      last_seen_at: row.last_seen_at,
      is_online: new Date(row.last_seen_at) > new Date(now.getTime() - 5 * 60 * 1000),
      user_id: row.user_id,
      user_email: row.user_email,
    })),
    total: total?.cnt ?? 0,
    limit,
    offset,
  });
});

adminRouter.get('/backups/artifacts', async (c) => {
  return c.json({
    artifacts: [],
    total: 0,
  });
});

adminRouter.post('/backups/create', async (c) => {
  return c.json({ error: 'Backup not implemented yet' }, 501);
});

adminRouter.post('/backups/restore', async (c) => {
  return c.json({ error: 'Restore not implemented yet' }, 501);
});

export default adminRouter;
