import { Hono } from 'hono';
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
import { hashPassword, verifyPassword, createAccessToken, createRefreshToken, validateAccessToken, decodeRefreshToken, revokeRefreshToken } from '../auth';

type Bindings = {
  DB: D1Database;
  JWT_SECRET: string;
};

const authRouter = new Hono<{ Bindings: Bindings; Variables: { userId: string } }>();

// Register
authRouter.post('/register', zValidator('json', z.object({
  email: z.string().email(),
  password: z.string().min(8),
  device_id: z.string().optional(),
  device_name: z.string().optional().default('Unknown Device'),
  platform: z.string().optional().default('unknown'),
  client_type: z.string().optional(),
  app_version: z.string().optional(),
  os_version: z.string().optional(),
  device_model: z.string().optional(),
})), async (c) => {
  const { email, password, device_id: deviceId, device_name: deviceName, platform } = c.req.valid('json');
  const resolvedDeviceId = deviceId || randomUUID();
  const db = c.env.DB;
  const jwtSecret = c.env.JWT_SECRET;

  const existingUser = await db.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
  if (existingUser) {
    return c.json({ error: 'Email already registered' }, 409);
  }

  const userId = randomUUID();
  const passwordHash = await hashPassword(password);

  await db.prepare(`
    INSERT INTO users (id, email, password_hash, is_admin, is_enabled)
    VALUES (?, ?, ?, 0, 1)
  `).bind(userId, email, passwordHash).run();

  // Create user profile with default AI config
  await db.prepare(`
    INSERT INTO user_profiles (user_id, display_name, ai_config_json)
    VALUES (?, ?, ?)
  `).bind(userId, email, DEFAULT_AI_CONFIG).run();

  // Create device
  const now = new Date().toISOString();
  await db.prepare(`
    INSERT INTO devices (id, user_id, name, platform, last_ip, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(resolvedDeviceId, userId, deviceName, platform, c.req.header('CF-Connecting-IP'), now).run();

  const accessToken = await createAccessToken(userId, jwtSecret);
  const refreshTokenObj = await createRefreshToken(userId, resolvedDeviceId, db);

  // 自动创建默认账本（与原版保持一致）
  const ledgerId = randomUUID();
  const ledgerExternalId = randomUUID();

  await db.prepare(`
    INSERT INTO ledgers (id, user_id, external_id, name, currency, created_at)
    VALUES (?, ?, ?, ?, 'CNY', ?)
  `).bind(ledgerId, userId, ledgerExternalId, '默认账本', now).run();

  // 自动创建默认分类（防重复）
  const serverNow = now;
  const existingCategories = await db
    .prepare('SELECT name, kind FROM read_category_projection WHERE ledger_id = ? AND level = 1')
    .bind(ledgerId)
    .all<{ name: string; kind: string }>();

  const existingNames = new Set(existingCategories.results.map(c => `${c.kind}:${c.name}`));
  const parentSyncIds: Record<string, string> = {};

  for (const cat of DEFAULT_CATEGORIES) {
    const key = `${cat.kind}:${cat.name}`;
    if (existingNames.has(key)) {
      continue;
    }

    const parentSyncId = randomUUID();
    parentSyncIds[cat.name] = parentSyncId;

    const payload: Record<string, unknown> = {
      name: cat.name,
      kind: cat.kind,
      level: 1,
      sort_order: cat.sort_order,
      icon: cat.icon,
      icon_type: 'emoji',
      parent_name: null,
    };

    await db
      .prepare(
        `INSERT INTO sync_changes
         (user_id, ledger_id, entity_type, entity_sync_id, action, payload_json, updated_at, updated_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(userId, ledgerId, 'category', parentSyncId, 'upsert', JSON.stringify(payload), serverNow, userId)
      .run();

    await db
      .prepare(
        `INSERT INTO read_category_projection
         (ledger_id, sync_id, user_id, name, kind, level, sort_order,
          icon, icon_type, custom_icon_path, icon_cloud_file_id, icon_cloud_sha256,
          parent_name, source_change_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        ledgerId, parentSyncId, userId, cat.name, cat.kind, 1,
        cat.sort_order, cat.icon, 'emoji', null, null, null, null, 0,
      )
      .run();

    if (cat.children) {
      for (const child of cat.children) {
        const childSyncId = randomUUID();
        const childPayload: Record<string, unknown> = {
          name: child.name,
          kind: cat.kind,
          level: 2,
          sort_order: cat.sort_order * 100 + (cat.children.indexOf(child) + 1),
          icon: child.icon,
          icon_type: 'emoji',
          parent_name: cat.name,
        };

        await db
          .prepare(
            `INSERT INTO sync_changes
             (user_id, ledger_id, entity_type, entity_sync_id, action, payload_json, updated_at, updated_by_user_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(userId, ledgerId, 'category', childSyncId, 'upsert', JSON.stringify(childPayload), serverNow, userId)
          .run();

        await db
          .prepare(
            `INSERT INTO read_category_projection
             (ledger_id, sync_id, user_id, name, kind, level, sort_order,
              icon, icon_type, custom_icon_path, icon_cloud_file_id, icon_cloud_sha256,
              parent_name, source_change_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(
            ledgerId, childSyncId, userId, child.name, cat.kind, 2,
            cat.sort_order * 100 + (cat.children.indexOf(child) + 1),
            child.icon, 'emoji', null, null, null, cat.name, 0,
          )
          .run();
      }
    }
  }

  return c.json({
    requires_2fa: false,
    user: { id: userId, email, is_admin: false },
    access_token: accessToken,
    refresh_token: refreshTokenObj.token,
    expires_in: 3600,
    device_id: resolvedDeviceId,
    scopes: ['web:read', 'web:write', 'ops:write'],
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
  const { email, password, device_id: deviceId, device_name: deviceName, platform } = c.req.valid('json');
  const resolvedDeviceId = deviceId || randomUUID();
  const db = c.env.DB;
  const jwtSecret = c.env.JWT_SECRET;

  const user = await db.prepare('SELECT id, email, password_hash, is_enabled, is_admin, totp_enabled FROM users WHERE email = ?').bind(email).first<{ id: string, email: string, password_hash: string, is_enabled: number, is_admin: number, totp_enabled: number }>();
  if (!user) {
    return c.json({ error: 'Invalid credentials' }, 401);
  }

  if (!user.is_enabled) {
    return c.json({ error: 'Account disabled' }, 403);
  }

  const passwordValid = await verifyPassword(user.password_hash, password);
  if (!passwordValid) {
    return c.json({ error: 'Invalid credentials' }, 401);
  }

  if (user.totp_enabled) {
    return c.json({
      requires_2fa: true,
      available_methods: ['totp', 'recovery_code'],
    });
  }

  // Create or update device
  const existingDevice = await db.prepare('SELECT id, revoked_at FROM devices WHERE id = ? AND user_id = ?').bind(resolvedDeviceId, user.id).first<{ id: string, revoked_at: string | null }>();
  if (!existingDevice) {
    await db.prepare(`
      INSERT INTO devices (id, user_id, name, platform, last_ip, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(resolvedDeviceId, user.id, deviceName, platform, c.req.header('CF-Connecting-IP'), new Date().toISOString()).run();
  } else {
    if (existingDevice.revoked_at) {
      // 如果设备被撤销了，重新激活它
      await db.prepare(`
        UPDATE devices
        SET last_seen_at = ?, last_ip = ?, name = ?, revoked_at = NULL
        WHERE id = ?
      `).bind(new Date().toISOString(), c.req.header('CF-Connecting-IP'), deviceName, resolvedDeviceId).run();
    } else {
      await db.prepare(`
        UPDATE devices
        SET last_seen_at = ?, last_ip = ?, name = ?
        WHERE id = ?
      `).bind(new Date().toISOString(), c.req.header('CF-Connecting-IP'), deviceName, resolvedDeviceId).run();
    }
  }

  const accessToken = await createAccessToken(user.id, jwtSecret);
  const refreshToken = await createRefreshToken(user.id, resolvedDeviceId, db);

  // 返回符合蜜蜂记账 APP 期望的格式
  return c.json({
    requires_2fa: false,
    user: {
      id: user.id,
      email: user.email || null,
      is_admin: Boolean((user as any).is_admin),
    },
    access_token: accessToken,
    refresh_token: refreshToken.token,
    expires_in: 3600,
    device_id: resolvedDeviceId,
    scopes: ['web:read', 'web:write', 'ops:write'],
  });
});

// Refresh token
authRouter.post('/refresh', zValidator('json', z.object({
  refresh_token: z.string()
})), async (c) => {
  const { refresh_token: refreshToken } = c.req.valid('json');
  const db = c.env.DB;
  const jwtSecret = c.env.JWT_SECRET;

  try {
    const decoded = await decodeRefreshToken(refreshToken, db);
    if (!decoded.valid) {
      return c.json({ error: decoded.reason }, 401);
    }

    const { userId, deviceId } = decoded;

    const accessToken = await createAccessToken(userId, jwtSecret);
    const newRefreshToken = await createRefreshToken(userId, deviceId, db);

    await revokeRefreshToken(refreshToken, db);

    return c.json({
      requires_2fa: false,
      user: { id: userId },
      access_token: accessToken,
      refresh_token: newRefreshToken.token,
      expires_in: 3600,
      device_id: deviceId,
      scopes: ['web:read', 'web:write', 'ops:write'],
    });
  } catch (error) {
    console.error('Refresh token error:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// Get current user (Web UI 使用)
authRouter.get('/me', async (c) => {
  const db = c.env.DB;
  const userId = c.get('userId');
  
  const user = await db.prepare('SELECT id, email FROM users WHERE id = ?').bind(userId).first<{ id: string, email: string }>();
  
  if (!user) {
    return c.json({ error: 'User not found' }, 404);
  }
  
  return c.json({
    id: user.id,
    email: user.email
  });
});

// Get 2FA status
authRouter.get('/2fa/status', async (c) => {
  const db = c.env.DB;
  const jwtSecret = c.env.JWT_SECRET;
  
  // 手动验证 token
  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  
  const token = authHeader.slice(7);
  const validationResult = await validateAccessToken(token, jwtSecret);
  
  if (!validationResult || !('userId' in validationResult)) {
    if (validationResult && 'expired' in validationResult && validationResult.expired) {
      return c.json({ error: 'Token expired' }, 401);
    }
    return c.json({ error: 'Unauthorized' }, 401);
  }
  
  const userId = validationResult.userId;
  
  const user = await db
    .prepare('SELECT totp_enabled, totp_enabled_at FROM users WHERE id = ?')
    .bind(userId)
    .first<{ totp_enabled: number; totp_enabled_at: string | null }>();
  
  if (!user) {
    return c.json({ error: 'User not found' }, 404);
  }
  
  return c.json({
    enabled: Boolean(user.totp_enabled),
    enabled_at: user.totp_enabled_at,
  });
});

// Setup 2FA - generate TOTP secret
authRouter.post('/2fa/setup', async (c) => {
  const db = c.env.DB;
  const jwtSecret = c.env.JWT_SECRET;
  
  // 手动验证 token
  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  
  const token = authHeader.slice(7);
  const validationResult = await validateAccessToken(token, jwtSecret);
  
  if (!validationResult || !('userId' in validationResult)) {
    if (validationResult && 'expired' in validationResult && validationResult.expired) {
      return c.json({ error: 'Token expired' }, 401);
    }
    return c.json({ error: 'Unauthorized' }, 401);
  }
  
  const userId = validationResult.userId;
  
  const user = await db
    .prepare('SELECT totp_enabled, email FROM users WHERE id = ?')
    .bind(userId)
    .first<{ totp_enabled: number; email: string }>();
  
  if (!user) {
    return c.json({ error: 'User not found' }, 404);
  }
  
  if (user.totp_enabled) {
    return c.json({ error: '2FA already enabled' }, 409);
  }
  
  // 生成 TOTP secret
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let secret = '';
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  for (const b of bytes) {
    secret += chars[b % chars.length];
  }
  
  await db
    .prepare('UPDATE users SET totp_secret_encrypted = ?, totp_enabled = 0 WHERE id = ?')
    .bind(secret, userId)
    .run();
  
  // 生成 otpauth URI
  const issuer = 'BeeCount';
  const label = encodeURIComponent(`${issuer}:${user.email}`);
  const encodedIssuer = encodeURIComponent(issuer);
  const qrUri = `otpauth://totp/${label}?secret=${secret}&issuer=${encodedIssuer}&algorithm=SHA1&digits=6&period=30`;
  
  return c.json({
    secret,
    qr_code_uri: qrUri,
    expires_in: 300,
  });
});

export default authRouter;
