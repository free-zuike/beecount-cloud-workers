/**
 * 个人资料路由模块
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { hashPassword } from '../auth';
import { DEFAULT_AI_CONFIG } from '../lib/defaults';

type Bindings = {
  DB: D1Database;
  JWT_SECRET: string;
  R2: R2Bucket;
};

type Variables = {
  userId: string;
  deviceId: string | null;
};

const profileRouter = new Hono<{ Bindings: Bindings; Variables: Variables }>();

function nowUtc(): string {
  return new Date().toISOString();
}

const ProfilePatchSchema = z.object({
  display_name: z.string().nullable().optional(),
  income_is_red: z.boolean().nullable().optional(),
  theme_primary_color: z.string().nullable().optional(),
  appearance: z.record(z.unknown()).nullable().optional(),
  ai_config: z.record(z.unknown()).nullable().optional(),
  primary_currency: z.string().nullable().optional(),
});

// GET /me - 获取当前用户资料
profileRouter.get('/me', async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;

  const user = await db.prepare('SELECT email FROM users WHERE id = ?').bind(userId).first<{ email: string }>();
  const profile = await db.prepare('SELECT * FROM user_profiles WHERE user_id = ?').bind(userId).first();

  if (!profile) {
    return c.json({
      user_id: userId,
      email: user?.email || '',
      display_name: null,
      avatar_url: null,
      avatar_version: 0,
      income_is_red: true,
      theme_primary_color: null,
      appearance: null,
      ai_config: DEFAULT_AI_CONFIG,
      primary_currency: null,
    });
  }

  const p = profile as any;
  return c.json({
    user_id: userId,
    email: user?.email || '',
    display_name: p.display_name,
    avatar_url: p.avatar_file_id ? `${c.req.url.split('/api')[0]}/api/v1/profile/avatar/${userId}?v=${p.avatar_version}` : null,
    avatar_version: p.avatar_version || 0,
    income_is_red: p.income_is_red,
    theme_primary_color: p.theme_primary_color,
    appearance: p.appearance_json ? JSON.parse(p.appearance_json) : null,
    ai_config: p.ai_config_json ? JSON.parse(p.ai_config_json) : DEFAULT_AI_CONFIG,
    primary_currency: p.primary_currency || null,
  });
});

// PATCH /me - 更新当前用户资料
profileRouter.patch('/me', zValidator('json', ProfilePatchSchema), async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const body = c.req.valid('json');
  const serverNow = nowUtc();

  let profile = await db.prepare('SELECT * FROM user_profiles WHERE user_id = ?').bind(userId).first() as any;
  if (!profile) {
    await db.prepare(`INSERT INTO user_profiles (user_id, display_name) VALUES (?, ?)`).bind(userId, body.display_name || null).run();
    profile = await db.prepare('SELECT * FROM user_profiles WHERE user_id = ?').bind(userId).first() as any;
  }

  const updates: string[] = [];
  const values: unknown[] = [];

  if (body.display_name !== undefined) { updates.push('display_name = ?'); values.push(body.display_name); }
  if (body.income_is_red !== undefined) { updates.push('income_is_red = ?'); values.push(body.income_is_red ? 1 : 0); }
  if (body.theme_primary_color !== undefined) { updates.push('theme_primary_color = ?'); values.push(body.theme_primary_color); }
  if (body.appearance !== undefined) { updates.push('appearance_json = ?'); values.push(body.appearance ? JSON.stringify(body.appearance) : null); }
  if (body.ai_config !== undefined) { updates.push('ai_config_json = ?'); values.push(body.ai_config ? JSON.stringify(body.ai_config) : null); }
  if (body.primary_currency !== undefined) { updates.push('primary_currency = ?'); values.push(body.primary_currency?.toUpperCase() || null); }

  if (updates.length > 0) {
    updates.push('updated_at = ?');
    values.push(serverNow);
    values.push(userId);
    await db.prepare(`UPDATE user_profiles SET ${updates.join(', ')} WHERE user_id = ?`).bind(...values).run();
  }

  const updated = await db.prepare('SELECT * FROM user_profiles WHERE user_id = ?').bind(userId).first() as any;
  const user = await db.prepare('SELECT email FROM users WHERE id = ?').bind(userId).first<{ email: string }>();

  return c.json({
    user_id: userId,
    email: user?.email || '',
    display_name: updated?.display_name || null,
    avatar_url: updated?.avatar_file_id ? `${c.req.url.split('/api')[0]}/api/v1/profile/avatar/${userId}?v=${updated.avatar_version}` : null,
    avatar_version: updated?.avatar_version || 0,
    income_is_red: updated?.income_is_red,
    theme_primary_color: updated?.theme_primary_color,
    appearance: updated?.appearance_json ? JSON.parse(updated.appearance_json) : null,
    ai_config: updated?.ai_config_json ? JSON.parse(updated.ai_config_json) : DEFAULT_AI_CONFIG,
    primary_currency: updated?.primary_currency || null,
  });
});

// POST /me/change-password
profileRouter.post('/me/change-password', zValidator('json', z.object({
  current_password: z.string(),
  new_password: z.string().min(8),
})), async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const { current_password, new_password } = c.req.valid('json');

  const user = await db.prepare('SELECT password_hash FROM users WHERE id = ?').bind(userId).first<{ password_hash: string }>();
  if (!user) return c.json({ error: 'User not found' }, 404);

  const { verifyPassword } = await import('../auth');
  const valid = await verifyPassword(user.password_hash, current_password);
  if (!valid) return c.json({ error: 'Invalid current password' }, 401);

  const hash = await hashPassword(new_password);
  await db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(hash, userId).run();

  return c.json({ success: true });
});

// POST /avatar - 上传头像 (R2)
profileRouter.post('/avatar', async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const r2 = c.env.R2;

  if (!userId) return c.json({ error: 'Unauthorized' }, 401);

  try {
    const formData = await c.req.formData();
    const file = formData.get('file') as File | null;
    if (!file) return c.json({ error: 'No file provided' }, 400);

    const fileId = crypto.randomUUID();
    const fileName = file.name || 'avatar';
    const mimeType = file.type || 'image/png';
    const fileBuffer = await file.arrayBuffer();
    const storagePath = `avatars/${userId}/${fileId}-${fileName}`;

    await r2.put(storagePath, fileBuffer, { httpMetadata: { contentType: mimeType } });

    const serverNow = nowUtc();
    await db.prepare('UPDATE user_profiles SET avatar_file_id = ?, avatar_version = avatar_version + 1, updated_at = ? WHERE user_id = ?').bind(fileId, serverNow, userId).run();

    const profile = await db.prepare('SELECT avatar_version FROM user_profiles WHERE user_id = ?').bind(userId).first<{ avatar_version: number }>();
    const ver = profile?.avatar_version ?? 1;

    return c.json({ avatar_url: `${c.req.url.split('/api')[0]}/api/v1/profile/avatar/${userId}?v=${ver}`, avatar_version: ver });
  } catch (error) {
    console.error('[Avatar] Upload error:', error);
    return c.json({ error: 'Avatar upload failed' }, 500);
  }
});

// POST /avatar - 兼容不带 /me 的路径
profileRouter.post('/avatar', async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const r2 = c.env.R2;

  if (!userId) return c.json({ error: 'Unauthorized' }, 401);

  try {
    const formData = await c.req.formData();
    const file = formData.get('file') as File | null;
    if (!file) return c.json({ error: 'No file provided' }, 400);

    const fileId = crypto.randomUUID();
    const fileName = file.name || 'avatar';
    const mimeType = file.type || 'image/png';
    const fileBuffer = await file.arrayBuffer();
    const storagePath = `avatars/${userId}/${fileId}-${fileName}`;

    await r2.put(storagePath, fileBuffer, { httpMetadata: { contentType: mimeType } });

    const serverNow = nowUtc();
    await db.prepare('UPDATE user_profiles SET avatar_file_id = ?, avatar_version = avatar_version + 1, updated_at = ? WHERE user_id = ?').bind(fileId, serverNow, userId).run();

    const profile = await db.prepare('SELECT avatar_version FROM user_profiles WHERE user_id = ?').bind(userId).first<{ avatar_version: number }>();
    const ver = profile?.avatar_version ?? 1;

    return c.json({ avatar_url: `${c.req.url.split('/api')[0]}/api/v1/profile/avatar/${userId}?v=${ver}`, avatar_version: ver });
  } catch (error) {
    console.error('[Avatar] Upload error:', error);
    return c.json({ error: 'Avatar upload failed' }, 500);
  }
});

// GET /avatar/:user_id - 下载头像
profileRouter.get('/avatar/:user_id', async (c) => {
  const userId = c.req.param('user_id');
  const db = c.env.DB;
  const r2 = c.env.R2;

  const profile = await db.prepare('SELECT avatar_file_id, avatar_version FROM user_profiles WHERE user_id = ?').bind(userId).first<{ avatar_file_id: string; avatar_version: number }>();
  if (!profile?.avatar_file_id) return c.json({ error: 'Avatar not found' }, 404);

  const storagePath = `avatars/${userId}/${profile.avatar_file_id}`;
  const obj = await r2.get(storagePath);
  if (!obj) return c.json({ error: 'Avatar not found' }, 404);

  return new Response(obj.body, {
    headers: {
      'Content-Type': obj.httpMetadata?.contentType || 'image/png',
      'Cache-Control': c.req.query('v') ? 'public, max-age=31536000, immutable' : 'no-cache',
    },
  });
});

export default profileRouter;
