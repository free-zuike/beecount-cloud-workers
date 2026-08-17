import { Hono } from 'hono';
import { serverLogger } from '../lib/logger';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { DEFAULT_AI_CONFIG } from '../lib/defaults';

interface DefaultCategory {
  name: string;
  kind: 'expense' | 'income';
  level: number;
  sort_order: number;
  icon: string;
  children?: Array<{
    name: string;
    icon: string;
  }>;
}

const DEFAULT_CATEGORIES: DefaultCategory[] = [
  // 支出分类
  { name: '餐饮', kind: 'expense', level: 1, sort_order: 1, icon: '🍜', children: [
    { name: '一日三餐', icon: '🍚' },
    { name: '零食', icon: '🍪' },
    { name: '外卖', icon: '🛵' },
    { name: '聚餐', icon: '🍻' },
  ]},
  { name: '购物', kind: 'expense', level: 1, sort_order: 2, icon: '🛒', children: [
    { name: '日用品', icon: '🧴' },
    { name: '服装', icon: '👕' },
    { name: '数码', icon: '📱' },
    { name: '美妆', icon: '💄' },
  ]},
  { name: '交通', kind: 'expense', level: 1, sort_order: 3, icon: '🚗', children: [
    { name: '公交', icon: '🚌' },
    { name: '地铁', icon: '🚇' },
    { name: '打车', icon: '🚕' },
    { name: '加油', icon: '⛽' },
    { name: '停车', icon: '🅿️' },
  ]},
  { name: '居住', kind: 'expense', level: 1, sort_order: 4, icon: '🏠', children: [
    { name: '房租', icon: '🏦' },
    { name: '水电', icon: '💡' },
    { name: '物业', icon: '🏢' },
  ]},
  { name: '通讯', kind: 'expense', level: 1, sort_order: 5, icon: '📱', children: [
    { name: '话费', icon: '📞' },
    { name: '流量', icon: '📶' },
  ]},
  { name: '娱乐', kind: 'expense', level: 1, sort_order: 6, icon: '🎮', children: [
    { name: '电影', icon: '🎬' },
    { name: '音乐', icon: '🎵' },
    { name: '游戏', icon: '🎮' },
    { name: '旅游', icon: '✈️' },
  ]},
  { name: '医疗', kind: 'expense', level: 1, sort_order: 7, icon: '🏥', children: [
    { name: '门诊', icon: '🩺' },
    { name: '买药', icon: '💊' },
  ]},
  { name: '教育', kind: 'expense', level: 1, sort_order: 8, icon: '📚', children: [
    { name: '培训', icon: '🎓' },
    { name: '书籍', icon: '📖' },
  ]},
  { name: '金融', kind: 'expense', level: 1, sort_order: 9, icon: '💰', children: [
    { name: '手续费', icon: '💳' },
    { name: '利息', icon: '📊' },
  ]},
  { name: '保险', kind: 'expense', level: 1, sort_order: 10, icon: '🏛️', children: [
    { name: '医保', icon: '🏥' },
    { name: '车险', icon: '🚗' },
  ]},
  { name: '其他支出', kind: 'expense', level: 1, sort_order: 11, icon: '📦', children: [
    { name: '其他', icon: '❓' },
  ]},
  // 收入分类
  { name: '工资', kind: 'income', level: 1, sort_order: 21, icon: '💵', children: [
    { name: '基本工资', icon: '💰' },
    { name: '加班费', icon: '⏰' },
    { name: '补贴', icon: '🎁' },
  ]},
  { name: '奖金', kind: 'income', level: 1, sort_order: 22, icon: '🏆', children: [
    { name: '年终奖', icon: '🎊' },
    { name: '绩效', icon: '📈' },
  ]},
  { name: '投资', kind: 'income', level: 1, sort_order: 23, icon: '📈', children: [
    { name: '股票', icon: '📉' },
    { name: '基金', icon: '📊' },
    { name: '利息', icon: '💵' },
  ]},
  { name: '理财', kind: 'income', level: 1, sort_order: 24, icon: '💎', children: [
    { name: '理财收益', icon: '💰' },
  ]},
  { name: '兼职', kind: 'income', level: 1, sort_order: 25, icon: '💼', children: [
    { name: '外快', icon: '💵' },
  ]},
  { name: '礼金', kind: 'income', level: 1, sort_order: 26, icon: '🎁', children: [
    { name: '红包', icon: '🧧' },
    { name: '礼物', icon: '🎀' },
  ]},
  { name: '其他收入', kind: 'income', level: 1, sort_order: 27, icon: '💴', children: [
    { name: '其他', icon: '❓' },
  ]},
];
import { hashPassword, verifyPassword, createAccessToken, createRefreshToken, validateAccessToken, decodeRefreshToken, revokeRefreshToken, sha256 } from '../auth';
import { isRateLimited } from '../lib/rate-limit';
import twoFactorRouter from './two_factor';

function nowUtc(): string { return new Date().toISOString(); }

/** 设备 upsert — 处理跨用户 device_id 冲突（与原版 _upsert_device 对齐） */
export async function upsertDevice(
  db: D1Database,
  userId: string,
  deviceId: string,
  deviceName: string,
  platform: string,
  appVersion?: string,
  osVersion?: string,
  deviceModel?: string,
  clientIp?: string | null
): Promise<string> {
  let targetId = deviceId;
  const now = new Date().toISOString();

  // 检查 device_id 是否被其他用户占用
  const existingAny = await db.prepare('SELECT id, user_id FROM devices WHERE id = ?').bind(targetId).first<{ id: string; user_id: string }>();
  if (existingAny && existingAny.user_id !== userId) {
    serverLogger.info('src.routers.auth', `[AUTH] device_id cross-user collision id=${targetId} prev_user=${existingAny.user_id} new_user=${userId} -> minting new device_id`);
    targetId = randomUUID();
  }

  const existingDevice = await db.prepare('SELECT id, revoked_at, name, platform, app_version, os_version, device_model, last_ip FROM devices WHERE id = ? AND user_id = ?').bind(targetId, userId).first<{ id: string; revoked_at: string | null; name: string | null; platform: string | null; app_version: string | null; os_version: string | null; device_model: string | null; last_ip: string | null }>();

  if (!existingDevice) {
    await db.prepare(
      `INSERT INTO devices (id, user_id, name, platform, app_version, os_version, device_model, last_ip, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(targetId, userId, deviceName, platform, appVersion || null, osVersion || null, deviceModel || null, clientIp, now).run();
  } else {
    // 对齐原版 _upsert_device：未传字段保留现有值（device_name or device.name 模式）
    await db.prepare(
      `UPDATE devices SET last_seen_at = ?, last_ip = ?, name = ?, platform = ?, app_version = ?, os_version = ?, device_model = ?${existingDevice.revoked_at ? ', revoked_at = NULL' : ''} WHERE id = ?`
    ).bind(
      now,
      clientIp ?? existingDevice.last_ip,
      deviceName ?? existingDevice.name,
      platform ?? existingDevice.platform,
      appVersion ?? existingDevice.app_version,
      osVersion ?? existingDevice.os_version,
      deviceModel ?? existingDevice.device_model,
      targetId
    ).run();
  }

  return targetId;
}

type Bindings = {
  DB: D1Database;
  JWT_SECRET: string;
};

const authRouter = new Hono<{ Bindings: Bindings; Variables: { userId: string } }>();

// Register
authRouter.post('/register', zValidator('json', z.object({
  email: z.string().email(),
  password: z.string().min(6),
  device_id: z.string().optional(),
  device_name: z.string().optional().default('Unknown Device'),
  platform: z.string().optional().default('unknown'),
  client_type: z.string().optional(),
  app_version: z.string().optional(),
  os_version: z.string().optional(),
  device_model: z.string().optional(),
})), async (c) => {
  const clientIp = c.req.header('CF-Connecting-IP') || 'unknown';
  if (isRateLimited('register', clientIp)) {
    return c.json({ error: 'Too many requests' }, 429);
  }

  // 检查注册是否启用（与原版对齐）
  const db = c.env.DB;
  // 检查注册是否启用（与原版对齐：使用环境变量 REGISTRATION_ENABLED）
  if (process.env.REGISTRATION_ENABLED === 'false') {
    return c.json({ error: 'Registration disabled' }, 403);
  }

  const { email: rawEmail, password, device_id: deviceId, device_name: deviceName, platform, client_type: clientType, app_version: appVersion, os_version: osVersion, device_model: deviceModel } = c.req.valid('json');
  const email = rawEmail.trim().toLowerCase();
  const resolvedDeviceId = deviceId || randomUUID();
  const jwtSecret = c.env.JWT_SECRET;
  const isApp = clientType !== 'web';
  const tokenScopes = isApp ? ['app_write'] : ['web_read', 'web_write', 'ops_write'];

  const existingUser = await db.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
  if (existingUser) {
    return c.json({ error: 'Email already exists' }, 409);
  }

  const userId = randomUUID();
  const passwordHash = await hashPassword(password);

  // users + user_profiles 同事务写入（对齐原版 db.commit() 单事务）
  await db.batch([
    db.prepare(
      `INSERT INTO users (id, email, password_hash, is_admin, is_enabled)
       VALUES (?, ?, ?, 0, 1)`
    ).bind(userId, email, passwordHash),
    db.prepare(
      `INSERT INTO user_profiles (user_id, display_name, ai_config_json)
       VALUES (?, ?, ?)`
    ).bind(userId, email, DEFAULT_AI_CONFIG),
  ]);

  // Create device（使用 upsert 处理跨用户冲突）
  const finalDeviceId = await upsertDevice(
    db, userId, resolvedDeviceId, deviceName, platform, appVersion, osVersion, deviceModel, c.req.header('CF-Connecting-IP')
  );

  const accessToken = await createAccessToken(userId, jwtSecret, isApp ? 'app' : 'web', tokenScopes);

  // 创建 refresh token（JWT + hash 在 batch 外计算，INSERT 与 users/profiles 同事务）
  const refreshExpiresIn = 30 * 24 * 60 * 60;
  const refreshTokenValue = await createAccessToken(userId, jwtSecret, isApp ? 'app' : 'web', tokenScopes, refreshExpiresIn, 'refresh');
  const refreshTokenHash = Array.from(new Uint8Array(await sha256(new TextEncoder().encode(refreshTokenValue)))).map(b => b.toString(16).padStart(2, '0')).join('');
  const refreshExpiresAt = new Date(Date.now() + refreshExpiresIn * 1000);
  const refreshTokenId = randomUUID();

  // users + user_profiles + refresh_tokens 同事务原子写入
  await db.batch([
    db.prepare(
      `INSERT INTO users (id, email, password_hash, is_admin, is_enabled)
       VALUES (?, ?, ?, 0, 1)`
    ).bind(userId, email, passwordHash),
    db.prepare(
      `INSERT INTO user_profiles (user_id, display_name, ai_config_json)
       VALUES (?, ?, ?)`
    ).bind(userId, email, DEFAULT_AI_CONFIG),
    db.prepare(
      `INSERT INTO refresh_tokens (id, user_id, device_id, token_hash, expires_at, client_type)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(refreshTokenId, userId, finalDeviceId, refreshTokenHash, refreshExpiresAt.toISOString(), isApp ? 'app' : 'web'),
  ]);

  // 不在注册时创建默认账本和分类 — 由 mobile push 时自动创建
  // 避免注册产生 124+ 次 DB 写入，以及 external_id 不匹配导致双账本

  return c.json({
    user: { id: userId, email, is_admin: false },
    access_token: accessToken,
    refresh_token: refreshTokenValue,
    expires_in: 3600,
    device_id: finalDeviceId,
    scopes: tokenScopes,
  });
});

// Login
authRouter.post('/login', zValidator('json', z.object({
  email: z.string().min(1),
  password: z.string(),
  device_id: z.string().optional(),
  device_name: z.string().optional().default('Unknown Device'),
  platform: z.string().optional().default('unknown'),
  client_type: z.string().optional(),
  app_version: z.string().optional(),
  os_version: z.string().optional(),
  device_model: z.string().optional()
})), async (c) => {
  const clientIp = c.req.header('CF-Connecting-IP') || 'unknown';
  if (isRateLimited('login', clientIp)) {
    return c.json({ error: 'Too many requests' }, 429);
  }
  const { email: rawEmail, password, device_id: deviceId, device_name: deviceName, platform, client_type: clientType, app_version: appVersion, os_version: osVersion, device_model: deviceModel } = c.req.valid('json');
  const email = rawEmail.trim().toLowerCase();
  const db = c.env.DB;
  const jwtSecret = c.env.JWT_SECRET;
  const isApp = clientType !== 'web';
  const tokenScopes = isApp ? ['app_write'] : ['web_read', 'web_write', 'ops_write'];

  const user = await db.prepare('SELECT id, email, password_hash, is_enabled, is_admin, totp_enabled FROM users WHERE email = ?').bind(email).first<{ id: string, email: string, password_hash: string, is_enabled: number, is_admin: number, totp_enabled: number }>();
  if (!user) {
    return c.json({ error: 'Invalid credentials' }, 401);
  }

  const passwordValid = await verifyPassword(user.password_hash, password);
  if (!passwordValid) {
    return c.json({ error: 'Invalid credentials' }, 401);
  }

  if (!user.is_enabled) {
    return c.json({ error: 'User disabled' }, 403);
  }

  if (user.totp_enabled) {
    // 与原版对齐：2FA challenge 时不创建设备，仅在 /2fa/verify 时创建
    const challengeToken = await createAccessToken(user.id, jwtSecret, isApp ? 'app' : 'web', [], 300, 'totp_challenge');
    return c.json({
      requires_2fa: true,
      challenge_token: challengeToken,
      available_methods: ['totp', 'recovery_code'],
    });
  }

  // 检查设备是否已被撤销（与原版对齐）
  if (deviceId) {
    const revokedDevice = await db
      .prepare('SELECT id FROM devices WHERE id = ? AND user_id = ? AND revoked_at IS NOT NULL')
      .bind(deviceId, user.id)
      .first();
    if (revokedDevice) {
      return c.json({ error: 'Device revoked' }, 401);
    }
  }

  // Create or update device（使用 upsert 处理跨用户冲突）
  const resolvedDeviceId = await upsertDevice(
    db, user.id, deviceId || randomUUID(), deviceName, platform, appVersion, osVersion, deviceModel, c.req.header('CF-Connecting-IP')
  );

  const accessToken = await createAccessToken(user.id, jwtSecret, isApp ? 'app' : 'web', tokenScopes);

  // 创建 refresh token + 清理旧 token 同事务原子写入（对齐原版单 commit）
  const refreshExpiresIn = 30 * 24 * 60 * 60;
  const refreshTokenValue = await createAccessToken(user.id, jwtSecret, isApp ? 'app' : 'web', tokenScopes, refreshExpiresIn, 'refresh');
  const refreshTokenHash = Array.from(new Uint8Array(await sha256(new TextEncoder().encode(refreshTokenValue)))).map(b => b.toString(16).padStart(2, '0')).join('');
  const refreshExpiresAt = new Date(Date.now() + refreshExpiresIn * 1000);
  const refreshTokenId = randomUUID();

  await db.batch([
    db.prepare(
      `INSERT INTO refresh_tokens (id, user_id, device_id, token_hash, expires_at, client_type)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(refreshTokenId, user.id, resolvedDeviceId, refreshTokenHash, refreshExpiresAt.toISOString(), isApp ? 'app' : 'web'),
    db.prepare(
      "DELETE FROM refresh_tokens WHERE user_id = ? AND device_id = ? AND (revoked_at IS NOT NULL OR expires_at < datetime('now'))"
    ).bind(user.id, resolvedDeviceId),
  ]);

  // 返回符合蜜蜂记账 APP 期望的格式
  return c.json({
    requires_2fa: false,
    user: {
      id: user.id,
      email: user.email || null,
      is_admin: Boolean((user as any).is_admin),
    },
    access_token: accessToken,
    refresh_token: refreshTokenValue,
    expires_in: 3600,
    device_id: resolvedDeviceId,
    scopes: tokenScopes,
  });
});

// Refresh token
authRouter.post('/refresh', zValidator('json', z.object({
  refresh_token: z.string()
})), async (c) => {
  const { refresh_token: refreshToken } = c.req.valid('json');
  const db = c.env.DB;
  const jwtSecret = c.env.JWT_SECRET;

  // 调试日志：追踪 refresh 请求
  const tokenPrefix = refreshToken.substring(0, 8);
  serverLogger.info('src.routers.auth', `[REFRESH] token=${tokenPrefix}...`);

  try {
    const decoded = await decodeRefreshToken(refreshToken, db, jwtSecret);
    if (!decoded.valid) {
      serverLogger.info('src.routers.auth', `[REFRESH] FAILED: ${decoded.reason}`);
      return c.json({ error: decoded.reason }, 401);
    }

    const { userId: tokenUserId, deviceId, clientType } = decoded;
    const tokenScopes = decoded.scopes;
    serverLogger.info('src.routers.auth', `[REFRESH] OK: user=${tokenUserId} device=${deviceId} client=${clientType}`);

    // 与原版对齐：从 JWT claims 获取 user_id（不信任 DB）
    const user = await db.prepare('SELECT id, email, is_admin, is_enabled FROM users WHERE id = ?').bind(tokenUserId).first<{ id: string; email: string; is_admin: number; is_enabled: number }>();
    if (!user) {
      return c.json({ error: 'User not found' }, 401);
    }
    if (!user.is_enabled) {
      return c.json({ error: 'User disabled' }, 403);
    }

    // 与原版对齐：检查设备状态 + 更新 last_seen_at
    const clientIp = c.req.header('CF-Connecting-IP') || 'unknown';
    const refreshStmts: any[] = [];
    if (deviceId) {
      const device = await db
        .prepare('SELECT id, revoked_at FROM devices WHERE id = ? AND user_id = ?')
        .bind(deviceId, tokenUserId)
        .first<{ id: string; revoked_at: string | null }>();
      if (device) {
        if (device.revoked_at) {
          return c.json({ error: 'Device revoked' }, 401);
        }
        refreshStmts.push(
          db.prepare('UPDATE devices SET last_seen_at = ?, last_ip = ? WHERE id = ?')
            .bind(nowUtc(), clientIp, deviceId),
        );
      }
      // 设备不存在时创建（与原版对齐，单条写入，保持 batch 外）
      if (!device) {
        await upsertDevice(db, tokenUserId, deviceId, 'Unknown Device', 'unknown', undefined, undefined, undefined, clientIp);
      }
    }

    const isApp = clientType !== 'web';
    const tokenScopesFinal = tokenScopes && tokenScopes.length > 0 ? tokenScopes : (isApp ? ['app_write'] : ['web_read', 'web_write', 'ops_write']);

    const accessToken = await createAccessToken(tokenUserId, jwtSecret, isApp ? 'app' : 'web', tokenScopesFinal);

    // 创建新 refresh token + 吊销旧 token（同事务原子写入，对齐原版单 commit）
    const refreshExpiresIn = 30 * 24 * 60 * 60;
    const newRefreshTokenValue = await createAccessToken(tokenUserId, jwtSecret, isApp ? 'app' : 'web', tokenScopesFinal, refreshExpiresIn, 'refresh');
    const newRefreshTokenHash = Array.from(new Uint8Array(await sha256(new TextEncoder().encode(newRefreshTokenValue)))).map(b => b.toString(16).padStart(2, '0')).join('');
    const refreshExpiresAt = new Date(Date.now() + refreshExpiresIn * 1000);
    const newRefreshTokenId = randomUUID();
    const oldRefreshTokenHash = Array.from(new Uint8Array(await sha256(new TextEncoder().encode(refreshToken)))).map(b => b.toString(16).padStart(2, '0')).join('');
    const nowIso = nowUtc();

    refreshStmts.push(
      db.prepare(
        `INSERT INTO refresh_tokens (id, user_id, device_id, token_hash, expires_at, client_type)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).bind(newRefreshTokenId, tokenUserId, deviceId, newRefreshTokenHash, refreshExpiresAt.toISOString(), clientType),
      db.prepare(
        `UPDATE refresh_tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL`
      ).bind(nowIso, oldRefreshTokenHash),
    );

    await db.batch(refreshStmts);

    return c.json({
      requires_2fa: false,
      user: { id: user.id, email: user.email || null, is_admin: Boolean(user.is_admin) },
      access_token: accessToken,
      refresh_token: newRefreshTokenValue,
      expires_in: 3600,
      device_id: deviceId || 'unknown',
      scopes: tokenScopesFinal,
    });
  } catch (error) {
    serverLogger.error('app', 'Refresh token error:', error);
    return c.json({ error: 'Invalid refresh token' }, 401);
  }
});

// Get current user (Web UI 使用) — 直接验证 token，因为 authMiddleware 跳过 auth 路由
authRouter.get('/me', async (c) => {
  const db = c.env.DB;
  const jwtSecret = c.env.JWT_SECRET;

  // 从 Authorization header 获取 userId
  let userId = c.get('userId');
  if (!userId) {
    const authHeader = c.req.header('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    const token = authHeader.slice(7);
    const result = await validateAccessToken(token, jwtSecret);
    if (!result || !('userId' in result)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    userId = result.userId;
  }
  
  const user = await db.prepare('SELECT id, email FROM users WHERE id = ?').bind(userId).first<{ id: string, email: string }>();
  
  if (!user) {
    return c.json({ error: 'User not found' }, 404);
  }
  
  return c.json({
    id: user.id,
    email: user.email
  });
});

// POST /auth/logout — 吊销 refresh token（与原版对齐：需有效 token 鉴权）
authRouter.post('/logout', zValidator('json', z.object({ refresh_token: z.string().optional() })), async (c) => {
  const db = c.env.DB;
  const jwtSecret = c.env.JWT_SECRET;
  const body = c.req.valid('json');
  const refreshToken = body.refresh_token;

  // 手动验证 token（authMiddleware 跳过 /api/v1/auth 路由）
  const authHeader = c.req.header('Authorization');
  let userId: string | undefined;
  if (authHeader?.startsWith('Bearer ')) {
    const result = await validateAccessToken(authHeader.slice(7), jwtSecret);
    if (result && 'userId' in result) {
      userId = result.userId;
    }
  }
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  let revoked = false;
  if (refreshToken) {
    const tokenHash = Buffer.from(await sha256(new TextEncoder().encode(refreshToken))).toString('hex');
    const tokenRecord = await db
      .prepare('SELECT id FROM refresh_tokens WHERE user_id = ? AND token_hash = ? AND revoked_at IS NULL')
      .bind(userId, tokenHash)
      .first<{ id: string }>();
    if (tokenRecord) {
      await db.prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE id = ?').bind(nowUtc(), tokenRecord.id).run();
      revoked = true;
    }
  }

  return c.json({ ok: true });
});

// 2FA 路由 — 挂在 /2fa 下，前端调用 /auth/2fa/*
authRouter.route('/2fa', twoFactorRouter);

export default authRouter;
