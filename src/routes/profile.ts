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

/**
 * 将 mobile 端 (Kotlin) camelCase 外观字段名归一化为 snake_case。
 * 注意：header_decoration_style（mobile）和 header_skin（web）是独立字段，
 * 不做互映射，各自保留。
 */
const APPEARANCE_KEY_MAP: Record<string, string> = {
  compactAmount: 'compact_amount',
  showTransactionTime: 'show_transaction_time',
  noteDisplayMode: 'note_display_mode',
};

function normalizeAppearance(appearance: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(appearance)) {
    const normalized = APPEARANCE_KEY_MAP[key] ?? key;
    // 如果 snake_case key 已经存在（比如同时传了两种格式），优先用已有的
    if (!(normalized in out)) {
      out[normalized] = value;
    }
  }
  return out;
}

const ProfilePatchSchema = z.object({
  display_name: z.string().nullable().optional(),
  income_is_red: z.boolean().nullable().optional(),
  theme_primary_color: z.string().nullable().optional(),
  appearance: z.record(z.unknown()).nullable().optional(),
  ai_config: z.record(z.unknown()).nullable().optional(),
  primary_currency: z.string().nullable().optional(),
});

// GET /me
profileRouter.get('/me', async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const user = await db.prepare('SELECT email FROM users WHERE id = ?').bind(userId).first<{ email: string }>();
  const profile = await db.prepare('SELECT * FROM user_profiles WHERE user_id = ?').bind(userId).first() as any;

  return c.json({
    user_id: userId,
    email: user?.email || '',
    display_name: profile?.display_name || null,
    avatar_url: profile?.avatar_file_id ? `${c.req.url.split('/api')[0]}/api/v1/profile/avatar/${userId}?v=${profile.avatar_version}` : null,
    avatar_version: profile?.avatar_version || 0,
    income_is_red: profile?.income_is_red != null ? Boolean(profile.income_is_red) : null,
    theme_primary_color: profile?.theme_primary_color,
    appearance: profile?.appearance_json ? normalizeAppearance(JSON.parse(profile.appearance_json)) : null,
    ai_config: profile?.ai_config_json ? JSON.parse(profile.ai_config_json) : null,
    primary_currency: profile?.primary_currency || null,
  });
});

// PATCH /me
profileRouter.patch('/me', zValidator('json', ProfilePatchSchema), async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const body = c.req.valid('json');
  const serverNow = nowUtc();

  let profile = await db.prepare('SELECT * FROM user_profiles WHERE user_id = ?').bind(userId).first() as any;
  if (!profile) {
    await db.prepare('INSERT INTO user_profiles (user_id) VALUES (?)').bind(userId).run();
    profile = await db.prepare('SELECT * FROM user_profiles WHERE user_id = ?').bind(userId).first() as any;
  }

  const updates: string[] = [];
  const values: unknown[] = [];

  if (body.display_name !== undefined) { updates.push('display_name = ?'); values.push(body.display_name); }
  if (body.income_is_red !== undefined) { updates.push('income_is_red = ?'); values.push(body.income_is_red ? 1 : 0); }
  if (body.theme_primary_color !== undefined) { updates.push('theme_primary_color = ?'); values.push(body.theme_primary_color); }
  if (body.appearance !== undefined) { updates.push('appearance_json = ?'); values.push(body.appearance ? JSON.stringify(normalizeAppearance(body.appearance as Record<string, unknown>)) : null); }
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

  // 广播 profile_change 给其他端实时同步
  if (updates.length > 0) {
    try {
      const { getWsManager } = await import('../lib/ws-manager');
      await getWsManager().broadcastToUser(userId, { type: 'profile_change' });
    } catch {}
    try {
      const doId = c.env.BEECOUNT_DO.idFromName(`ws-${userId}`);
      const doStub = c.env.BEECOUNT_DO.get(doId);
      await doStub.fetch(new Request('https://dummy/broadcast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: JSON.stringify({ type: 'profile_change' }) }),
      }));
    } catch {}
  }

  return c.json({
    user_id: userId,
    email: user?.email || '',
    display_name: updated?.display_name || null,
    avatar_url: updated?.avatar_file_id ? `${c.req.url.split('/api')[0]}/api/v1/profile/avatar/${userId}?v=${updated.avatar_version}` : null,
    avatar_version: updated?.avatar_version || 0,
    income_is_red: updated?.income_is_red != null ? Boolean(updated.income_is_red) : null,
    theme_primary_color: updated?.theme_primary_color,
    appearance: updated?.appearance_json ? normalizeAppearance(JSON.parse(updated.appearance_json)) : null,
    ai_config: updated?.ai_config_json ? JSON.parse(updated.ai_config_json) : null,
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

const ALLOWED_MIME: Record<string, string> = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/heic': 'heic', 'image/heif': 'heif' };
const FILE_EXT_MIME: Record<string, string> = { 'jpg': 'jpg', 'jpeg': 'jpg', 'png': 'png', 'webp': 'webp', 'gif': 'gif', 'heic': 'heic', 'heif': 'heif' };
const MAX_AVATAR_BYTES = 1 * 1024 * 1024;

// POST /avatar - 上传头像
profileRouter.post('/avatar', async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const r2 = c.env.R2;
  if (!userId) return c.json({ error: 'Unauthorized' }, 401);

  try {
    const formData = await c.req.formData();
    const file = formData.get('file') as File | null;
    if (!file) return c.json({ error: 'No file provided' }, 400);

    const mimeLower = (file.type || '').toLowerCase();
    const fileName = (file.name || '').toLowerCase();
    const fileExt = fileName.includes('.') ? fileName.split('.').pop() || '' : '';
    const extFromMime = ALLOWED_MIME[mimeLower];
    const extFromFile = FILE_EXT_MIME[fileExt];
    const ext = extFromMime || extFromFile;
    const actualMime = extFromMime ? mimeLower : extFromFile ? `image/${extFromFile}` : '';
    console.log('[Avatar] Upload: name=', file.name, 'type=', file.type, 'ext=', fileExt, 'size=', file.size);
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
      try { await r2.delete(`avatars/${userId}/${oldProfile.avatar_file_id}`); } catch {}
    }

    await r2.put(storagePath, fileBuffer, { httpMetadata: { contentType: mimeLower } });

    const serverNow = nowUtc();
    await db.prepare('UPDATE user_profiles SET avatar_file_id = ?, avatar_version = avatar_version + 1, updated_at = ? WHERE user_id = ?').bind(fileId, serverNow, userId).run();

    const profile = await db.prepare('SELECT avatar_version FROM user_profiles WHERE user_id = ?').bind(userId).first<{ avatar_version: number }>();
    const ver = profile?.avatar_version ?? 1;

    // 广播 profile_change 给其他端实时同步
    try {
      const { getWsManager } = await import('../lib/ws-manager');
      await getWsManager().broadcastToUser(userId, { type: 'profile_change' });
    } catch {}
    try {
      const doId = c.env.BEECOUNT_DO.idFromName(`ws-${userId}`);
      const doStub = c.env.BEECOUNT_DO.get(doId);
      await doStub.fetch(new Request('https://dummy/broadcast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: JSON.stringify({ type: 'profile_change' }) }),
      }));
    } catch {}

    return c.json({ avatar_url: `${c.req.url.split('/api')[0]}/api/v1/profile/avatar/${userId}?v=${ver}`, avatar_version: ver });
  } catch (error) {
    console.error('[Avatar] Upload error:', error);
    return c.json({ error: 'Avatar upload failed' }, 500);
  }
});

export default profileRouter;
