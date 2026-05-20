/**
 * 个人资料路由模块 - 实现 BeeCount Cloud 用户资料接口
 *
 * @module routes/profile
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { hashPassword, verifyPassword } from '../auth';

function nowUtc(): string {
  return new Date().toISOString();
}

function safeJsonParse<T = Record<string, unknown>>(jsonStr: string | null): T | null {
  if (!jsonStr) return null;
  try {
    return JSON.parse(jsonStr) as T;
  } catch {
    return null;
  }
}

function safeJsonStringify(obj: unknown): string | null {
  if (obj === null || obj === undefined) return null;
  try {
    return JSON.stringify(obj);
  } catch {
    return null;
  }
}

const ProfilePatchSchema = z.object({
  display_name: z.string().min(1).max(32).optional(),
  income_is_red: z.boolean().nullable().optional(),
  theme_primary_color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).nullable().optional(),
  appearance: z.record(z.unknown()).nullable().optional(),
  ai_config: z.record(z.unknown()).nullable().optional(),
});

interface UserProfileOut {
  user_id: string;
  email: string;
  display_name: string | null;
  avatar_url: string | null;
  avatar_version: number;
  income_is_red: boolean | null;
  theme_primary_color: string | null;
  appearance: Record<string, unknown> | null;
  ai_config: Record<string, unknown> | null;
}

type Bindings = {
  DB: D1Database;
  JWT_SECRET: string;
};

type Variables = {
  userId: string;
};

const profileRouter = new Hono<{ Bindings: Bindings; Variables: Variables }>();

profileRouter.use('*', async (c, next) => {
  try {
    await next();
  } catch (error) {
    console.error('[PROFILE] Error:', error);
    
    if (error instanceof Error && error.message.includes('no such table')) {
      return c.json({ error: 'Database not initialized' }, 503);
    }
    
    return c.json({ error: 'Internal server error' }, 500);
  }
});

profileRouter.get('/me', async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;

  const row = await db
    .prepare(
      `SELECT u.id, u.email,
              p.display_name, p.avatar_file_id, p.avatar_version,
              p.income_is_red, p.theme_primary_color,
              p.appearance_json, p.ai_config_json
       FROM users u
       LEFT JOIN user_profiles p ON p.user_id = u.id
       WHERE u.id = ?`
    )
    .bind(userId)
    .first<{
      id: string;
      email: string;
      display_name: string | null;
      avatar_file_id: string | null;
      avatar_version: number;
      income_is_red: number | null;
      theme_primary_color: string | null;
      appearance_json: string | null;
      ai_config_json: string | null;
    }>();

  if (!row) {
    return c.json({ error: 'User not found' }, 404);
  }

  const response: UserProfileOut = {
    user_id: row.id,
    email: row.email,
    display_name: row.display_name,
    avatar_url: row.avatar_file_id ? `/api/v1/profile/avatar/${row.id}` : null,
    avatar_version: row.avatar_version ?? 0,
    income_is_red: row.income_is_red !== null ? Boolean(row.income_is_red) : null,
    theme_primary_color: row.theme_primary_color,
    appearance: safeJsonParse(row.appearance_json),
    ai_config: safeJsonParse(row.ai_config_json),
  };

  return c.json(response);
});

profileRouter.patch('/me', zValidator('json', ProfilePatchSchema), async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const req = c.req.valid('json');
  const serverNow = nowUtc();

  const existing = await db
    .prepare('SELECT id FROM user_profiles WHERE user_id = ?')
    .bind(userId)
    .first<{ id: number }>();

  if (!existing) {
    await db
      .prepare(
        `INSERT INTO user_profiles (user_id, display_name, avatar_version, income_is_red,
                                    theme_primary_color, appearance_json, ai_config_json, updated_at)
         VALUES (?, ?, 0, ?, ?, ?, ?, ?)`
      )
      .bind(
        userId,
        req.display_name ?? null,
        req.income_is_red ?? null,
        req.theme_primary_color ?? null,
        safeJsonStringify(req.appearance ?? null),
        safeJsonStringify(req.ai_config ?? null),
        serverNow,
      )
      .run();
  } else {
    const updates: string[] = ['updated_at = ?'];
    const params: (string | number | null)[] = [serverNow];

    if (req.display_name !== undefined) {
      updates.push('display_name = ?');
      params.push(req.display_name);
    }
    if (req.income_is_red !== undefined) {
      updates.push('income_is_red = ?');
      params.push(req.income_is_red === null ? null : req.income_is_red ? 1 : 0);
    }
    if (req.theme_primary_color !== undefined) {
      updates.push('theme_primary_color = ?');
      params.push(req.theme_primary_color);
    }
    if (req.appearance !== undefined) {
      updates.push('appearance_json = ?');
      params.push(safeJsonStringify(req.appearance));
    }
    if (req.ai_config !== undefined) {
      updates.push('ai_config_json = ?');
      params.push(safeJsonStringify(req.ai_config));
    }

    params.push(userId);

    await db
      .prepare(`UPDATE user_profiles SET ${updates.join(', ')} WHERE user_id = ?`)
      .bind(...params)
      .run();
  }

  const row = await db
    .prepare(
      `SELECT u.id, u.email,
              p.display_name, p.avatar_file_id, p.avatar_version,
              p.income_is_red, p.theme_primary_color,
              p.appearance_json, p.ai_config_json
       FROM users u
       LEFT JOIN user_profiles p ON p.user_id = u.id
       WHERE u.id = ?`
    )
    .bind(userId)
    .first<{
      id: string;
      email: string;
      display_name: string | null;
      avatar_file_id: string | null;
      avatar_version: number;
      income_is_red: number | null;
      theme_primary_color: string | null;
      appearance_json: string | null;
      ai_config_json: string | null;
    }>();

  if (!row) {
    return c.json({ error: 'User not found' }, 404);
  }

  const response: UserProfileOut = {
    user_id: row.id,
    email: row.email,
    display_name: row.display_name,
    avatar_url: row.avatar_file_id ? `/api/v1/profile/avatar/${row.id}` : null,
    avatar_version: row.avatar_version ?? 0,
    income_is_red: row.income_is_red !== null ? Boolean(row.income_is_red) : null,
    theme_primary_color: row.theme_primary_color,
    appearance: safeJsonParse(row.appearance_json),
    ai_config: safeJsonParse(row.ai_config_json),
  };

  return c.json(response);
});

profileRouter.post('/me/change-password', zValidator('json', z.object({
  current_password: z.string(),
  new_password: z.string().min(8)
})), async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const { current_password, new_password } = c.req.valid('json');

  const user = await db
    .prepare('SELECT password_hash FROM users WHERE id = ?')
    .bind(userId)
    .first<{ password_hash: string }>();

  if (!user) {
    return c.json({ error: 'User not found' }, 404);
  }

  const passwordValid = await verifyPassword(user.password_hash, current_password);
  if (!passwordValid) {
    return c.json({ error: 'Current password is incorrect' }, 400);
  }

  const newPasswordHash = await hashPassword(new_password);
  await db
    .prepare('UPDATE users SET password_hash = ? WHERE id = ?')
    .bind(newPasswordHash, userId)
    .run();

  return c.json({ success: true, message: 'Password changed successfully' });
});

profileRouter.post('/me/avatar', async (c) => {
  return c.json({ error: 'Avatar upload not implemented yet' }, 501);
});

profileRouter.get('/avatar/:user_id', async (c) => {
  const version = c.req.query('v');

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100">
    <circle cx="50" cy="50" r="50" fill="#FF9800"/>
    <circle cx="50" cy="40" r="20" fill="#FFE0B2"/>
    <path d="M20 85 Q50 55 80 85 Z" fill="#FFE0B2"/>
  </svg>`;

  return c.html(svg, 200, {
    'Content-Type': 'image/svg+xml',
    'Cache-Control': version ? 'public, max-age=31536000, immutable' : 'public, max-age=86400',
  });
});

export default profileRouter;
