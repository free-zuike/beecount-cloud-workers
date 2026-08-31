/**
 * 个人资料路由模块
 */
import { Hono } from 'hono';
import { serverLogger } from '../lib/logger';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { hashPassword, verifyPassword } from '../auth';
import { DEFAULT_AI_CONFIG } from '../lib/defaults';
import { uploadToStorage, downloadFromStorage, deleteFromStorage } from '../lib/storage-adapter';

type Bindings = {
  DB: D1Database;
  JWT_SECRET: string;
  R2?: R2Bucket;
  BEECOUNT_DO: DurableObjectNamespace;
};

type Variables = {
  userId: string;
  deviceId: string | null;
};

const profileRouter = new Hono<{ Bindings: Bindings; Variables: Variables }>();

function nowUtc(): string {
  return new Date().toISOString();
}

// appearance 做纯 JSON 透传，与原版 Python _dump_appearance_json / _parse_appearance_json 对齐
const APPEARANCE_KEYS = ['theme_primary_color', 'income_is_red', 'sidebar_collapsed', 'compact_mode'] as const;

profileRouter.get('/me', async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const user = await db.prepare(
    `SELECT id, email, display_name, income_is_red, theme_primary_color, appearance_json
     FROM users u JOIN user_profiles up ON u.id = up.user_id WHERE u.id = ?`,
  ).bind(userId).first<{ id: string; email: string; display_name: string | null; income_is_red: boolean | null; theme_primary_color: string | null; appearance_json: string | null }>();
  if (!user) return c.json({ error: 'User not found' }, 404);
  return c.json({
    id: user.id,
    email: user.email,
    display_name: user.display_name,
    income_is_red: user.income_is_red,
    theme_primary_color: user.theme_primary_color,
    appearance_json: user.appearance_json ? JSON.parse(user.appearance_json) : {},
    avatar_url: `${c.req.url.split('/api')[0]}/api/v1/profile/avatar/${userId}`,
  });
});

profileRouter.patch('/me', zValidator('json', z.object({
  display_name: z.string().min(1).max(50).optional(),
  income_is_red: z.boolean().optional(),
  theme_primary_color: z.string().optional(),
  appearance_json: z.record(z.string(), z.any()).optional(),
})), async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const body = c.req.valid('json');
  const fields: string[] = [];
  const values: unknown[] = [userId];
  if (body.display_name !== undefined) { fields.push('display_name = ?'); values.push(body.display_name); }
  if (body.income_is_red !== undefined) { fields.push('income_is_red = ?'); values.push(body.income_is_red); }
  if (body.theme_primary_color !== undefined) { fields.push('theme_primary_color = ?'); values.push(body.theme_primary_color); }
  if (body.appearance_json !== undefined) { fields.push('appearance_json = ?'); values.push(JSON.stringify(body.appearance_json)); }
  if (fields.length > 0) {
    fields.push('updated_at = ?');
    values.push(nowUtc());
    values.push(userId);
    await db.prepare(`UPDATE user_profiles SET ${fields.join(', ')} WHERE user_id = ?`).bind(...values).run();
  }
  const profile = await db.prepare(
    `SELECT id, display_name, income_is_red, theme_primary_color, appearance_json, avatar_version FROM user_profiles WHERE user_id = ?`,
  ).bind(userId).first();
  if (!profile) return c.json({ error: 'Profile not found' }, 404);
  return c.json({
    id: userId,
    display_name: profile.display_name,
    income_is_red: profile.income_is_red,
    theme_primary_color: profile.theme_primary_color,
    appearance_json: profile.appearance_json ? JSON.parse(profile.appearance_json as string) : {},
    avatar_url: `${c.req.url.split('/api')[0]}/api/v1/profile/avatar/${userId}?v=${profile.avatar_version ?? 1}`,
    avatar_version: profile.avatar_version ?? 1,
  });
});

profileRouter.put('/me', zValidator('json', z.object({
  email: z.string().email().optional(),
  display_name: z.string().min(1).max(50).optional(),
  income_is_red: z.boolean().optional(),
  theme_primary_color: z.string().optional(),
  appearance_json: z.record(z.string(), z.any()).optional(),
})), async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const body = c.req.valid('json');
  const fields: string[] = [];
  const values: unknown[] = [];
  if (body.email !== undefined) { fields.push('email = ?'); values.push(body.email); }
  if (body.display_name !== undefined) { fields.push('display_name = ?'); values.push(body.display_name); }
  if (body.income_is_red !== undefined) { fields.push('income_is_red = ?'); values.push(body.income_is_red); }
  if (body.theme_primary_color !== undefined) { fields.push('theme_primary_color = ?'); values.push(body.theme_primary_color); }
  if (body.appearance_json !== undefined) { fields.push('appearance_json = ?'); values.push(JSON.stringify(body.appearance_json)); }
  if (fields.length > 0) {
    fields.push('updated_at = ?');
    values.push(nowUtc());
    values.push(userId);
    await db.prepare(`UPDATE users SET ${fields.filter((_, i) => i % 2 === 0).join(', ')} WHERE id = ?`).bind(...values).run();
  }
  const profile = await db.prepare(
    `SELECT up.display_name, up.income_is_red, up.theme_primary_color, up.appearance_json, up.avatar_version, u.email
     FROM user_profiles up JOIN users u ON up.user_id = u.id WHERE up.user_id = ?`,
  ).bind(userId).first<{ display_name: string | null; income_is_red: boolean | null; theme_primary_color: string | null; appearance_json: string | null; avatar_version: number; email: string }>();
  if (!profile) return c.json({ error: 'Profile not found' }, 404);
  return c.json({
    id: userId,
    email: profile.email,
    display_name: profile.display_name,
    income_is_red: profile.income_is_red,
    theme_primary_color: profile.theme_primary_color,
    appearance_json: profile.appearance_json ? JSON.parse(profile.appearance_json as string) : {},
    avatar_url: `${c.req.url.split('/api')[0]}/api/v1/profile/avatar/${userId}?v=${profile.avatar_version ?? 1}`,
    avatar_version: profile.avatar_version ?? 1,
  });
});

profileRouter.post('/change-password', zValidator('json', z.object({
  current_password: z.string().min(1),
  new_password: z.string().min(6),
})), async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const body = c.req.valid('json');
  const user = await db.prepare('SELECT password_hash FROM users WHERE id = ?').bind(userId).first<{ password_hash: string }>();
  if (!user) return c.json({ error: 'User not found' }, 404);
  const valid = await verifyPassword(user.password_hash, body.current_password);
  if (!valid) return c.json({ error: 'Invalid current password' }, 401);
  const hash = await hashPassword(body.new_password);
  await db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(hash, userId).run();
  return c.json({ success: true });
});

const ALLOWED_MIME: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const FILE_EXT_MIME: Record<string, string> = { 'jpg': 'jpg', 'jpeg': 'jpg', 'png': 'png', 'webp': 'webp' };
const MAX_AVATAR_BYTES = 1 * 1024 * 1024;

// POST /avatar - 上传头像（支持 R2 + 所有备份远端）
profileRouter.post('/avatar', async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  if (!userId) return c.json({ error: 'Unauthorized' }, 401);

  try {
    const formData = await c.req.formData();
    const file = formData.get('file') as File | null;
    if (!file) return c.json({ error: 'No file provided' }, 400);

    const mimeLower = (file.type || '').toLowerCase();
    const fileName = (file.name || '').toLowerCase();
    const fileExt = fileName.includes('.') ? fileName.split('.').pop() || '' : '';
    const ext = ALLOWED_MIME[mimeLower] || FILE_EXT_MIME[fileExt];
    if (!ext) return c.json({ error: `Profile avatar format invalid: ${mimeLower || fileExt || 'unknown'}` }, 400);

    const fileBuffer = await file.arrayBuffer();
    if (fileBuffer.byteLength > MAX_AVATAR_BYTES) {
      return c.json({ error: 'Profile avatar upload too large (max 1MB)' }, 413);
    }

    const fileId = crypto.randomUUID();
    const storagePath = `avatars/${userId}/${fileId}`;

    // 删除旧头像
    const oldProfile = await db.prepare('SELECT avatar_file_id FROM user_profiles WHERE user_id = ?').bind(userId).first<{ avatar_file_id: string }>();
    if (oldProfile?.avatar_file_id) {
      await deleteFromStorage(db, c.env, `avatars/${userId}/${oldProfile.avatar_file_id}`);
    }

    // 上传到新位置
    const uploadResult = await uploadToStorage(db, c.env, storagePath, new Uint8Array(fileBuffer), mimeLower);
    if (!uploadResult.ok) return c.json({ error: 'Avatar upload failed (no available storage)' }, 503);

    const serverNow = nowUtc();
    await db.prepare('UPDATE user_profiles SET avatar_file_id = ?, avatar_version = avatar_version + 1, updated_at = ? WHERE user_id = ?').bind(fileId, serverNow, userId).run();

    const profile = await db.prepare('SELECT avatar_version FROM user_profiles WHERE user_id = ?').bind(userId).first<{ avatar_version: number }>();
    const ver = profile?.avatar_version ?? 1;

    // 广播 profile_change
    const profileData = await db.prepare('SELECT display_name, income_is_red, theme_primary_color, appearance_json FROM user_profiles WHERE user_id = ?').bind(userId).first();
    const avatarPayload = {
      avatar_version: ver,
      display_name: profileData?.display_name ?? null,
      income_is_red: profileData?.income_is_red ?? null,
      theme_primary_color: profileData?.theme_primary_color ?? null,
    };
    try {
      const { getWsManager } = await import('../lib/ws-manager');
      await getWsManager().broadcastToUser(userId, { type: 'profile_change', ...avatarPayload });
    } catch {}
    try {
      const doId = c.env.BEECOUNT_DO.idFromName(`ws-${userId}`);
      const doStub = c.env.BEECOUNT_DO.get(doId);
      await doStub.fetch(new Request('https://dummy/broadcast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: JSON.stringify({ type: 'profile_change', ...avatarPayload }) }),
      }));
    } catch {}

    return c.json({ avatar_url: `${c.req.url.split('/api')[0]}/api/v1/profile/avatar/${userId}?v=${ver}`, avatar_version: ver });
  } catch (error) {
    serverLogger.error('src.routers.profile', '[Avatar] Upload error:', error);
    return c.json({ error: 'Avatar upload failed' }, 500);
  }
});

export default profileRouter;
