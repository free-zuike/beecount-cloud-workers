import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { hashPassword, verifyPassword, createAccessToken, createRefreshToken, validateAccessToken, sha256 } from '../auth';

type Bindings = {
  DB: D1Database;
  JWT_SECRET: string;
};

const authRouter = new Hono<{ Bindings: Bindings }>();

// Register
authRouter.post('/register', zValidator('json', z.object({
  email: z.string().email(),
  password: z.string().min(8)
})), async (c) => {
  const { email, password } = c.req.valid('json');
  const db = c.env.DB;

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
  const defaultAiConfig = JSON.stringify({
    providers: [
      {
        id: 'zhipu_glm',
        name: '智谱GLM',
        isBuiltIn: true,
        apiKey: '',
        baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
        textModel: 'glm-4-flash',
        visionModel: 'glm-4v-flash',
        audioModel: 'glm-4-voice'
      }
    ],
    binding: {
      textProviderId: 'zhipu_glm',
      visionProviderId: 'zhipu_glm',
      speechProviderId: 'zhipu_glm'
    },
    strategy: 'cloud_first',
    custom_prompt: ''
  });
  
  await db.prepare(`
    INSERT INTO user_profiles (user_id, display_name, ai_config_json)
    VALUES (?, ?, ?)
  `).bind(userId, email, defaultAiConfig).run();

  return c.json({ success: true });
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

  const user = await db.prepare('SELECT id, email, password_hash, is_enabled, totp_enabled FROM users WHERE email = ?').bind(email).first<{ id: string, email: string, password_hash: string, is_enabled: number, totp_enabled: number }>();
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
    return c.json({ requires_totp: true }, 401);
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
    user: {
      id: user.id,
      email: user.email || null
    },
    access_token: accessToken,
    refresh_token: refreshToken.token,
    expires_in: 3600,
    device_id: resolvedDeviceId
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
    // 计算 token 的哈希值（与存储时相同）
    const tokenHash = Buffer.from(await sha256(new TextEncoder().encode(refreshToken))).toString('hex');

    // 查找 refresh token
    const tokenRecord = await db
      .prepare('SELECT id, user_id, device_id, expires_at FROM refresh_tokens WHERE token_hash = ?')
      .bind(tokenHash)
      .first<{ id: string; user_id: string; device_id: string; expires_at: string }>();

    if (!tokenRecord) {
      return c.json({ error: 'Invalid refresh token' }, 401);
    }

    // 检查 token 是否过期
    const expiresAt = new Date(tokenRecord.expires_at);
    if (expiresAt < new Date()) {
      // 删除过期的 token
      await db.prepare('DELETE FROM refresh_tokens WHERE id = ?').bind(tokenRecord.id).run();
      return c.json({ error: 'Refresh token expired' }, 401);
    }

    // 创建新的 access token
    const accessToken = await createAccessToken(tokenRecord.user_id, jwtSecret);

    // 创建新的 refresh token（刷新 token）
    const newRefreshToken = await createRefreshToken(tokenRecord.user_id, tokenRecord.device_id, db);

    // 删除旧的 refresh token
    await db.prepare('DELETE FROM refresh_tokens WHERE id = ?').bind(tokenRecord.id).run();

    return c.json({
      access_token: accessToken,
      refresh_token: newRefreshToken.token,
      expires_at: Math.floor(Date.now() / 1000) + 60 * 60
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
  const userId = await validateAccessToken(token, jwtSecret);
  
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  
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
  const userId = await validateAccessToken(token, jwtSecret);
  
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  
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
