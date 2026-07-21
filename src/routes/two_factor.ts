/**
 * 2FA (TOTP) 路由模块 - 实现双因素认证接口
 *
 * 参考原版 BeeCount-Cloud (Python/FastAPI) 的 /2fa 端点：
 * - GET  /2fa/status                      - 获取 2FA 状态
 * - POST /2fa/setup                       - 开启 2FA：生成 TOTP secret
 * - POST /2fa/confirm                    - 确认 2FA：验证 6 位码 + 生成恢复码
 * - POST /2fa/verify                      - 登录第二步：challenge_token + code → 真 token
 * - POST /2fa/disable                     - 关闭 2FA：验证密码 + TOTP
 * - POST /2fa/recovery-codes/regenerate  - 重新生成恢复码
 *
 * 安全说明：
 * - TOTP secret 使用 Base32 编码存储
 * - 恢复码使用 SHA256 哈希存储
 * - /verify 端点有速率限制：同一 IP + challenge 每分钟最多 5 次失败
 *
 * @module routes/two_factor
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { validateAccessToken, createAccessToken, createRefreshToken, verifyPassword, base64urlDecode } from '../auth';
import { isRateLimited } from '../lib/rate-limit';

// ===========================
// 辅助函数
// ===========================

function nowUtc(): string {
  return new Date().toISOString();
}

import * as OTPAuth from 'otpauth';

async function deriveKey(secret: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', encoder.encode(secret), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: encoder.encode('totp-encryption-salt'), iterations: 100000, hash: 'SHA-256' },
    keyMaterial, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
  );
}

export async function encryptTotpSecret(plaintext: string, jwtSecret: string): Promise<string> {
  const key = await deriveKey(jwtSecret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(encrypted), iv.length);
  return btoa(String.fromCharCode(...combined));
}

export async function decryptTotpSecret(ciphertext: string, jwtSecret: string): Promise<string> {
  const key = await deriveKey(jwtSecret);
  const combined = Uint8Array.from(atob(ciphertext), c => c.charCodeAt(0));
  const iv = combined.slice(0, 12);
  const encrypted = combined.slice(12);
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, encrypted);
  return new TextDecoder().decode(decrypted);
}

/** 获取解密后的 TOTP secret — 兼容旧明文和新加密格式 */
async function getDecryptedTotpSecret(encrypted: string, jwtSecret: string): Promise<string> {
  // 尝试解密；如果失败说明是旧明文格式，直接返回
  try {
    return await decryptTotpSecret(encrypted, jwtSecret);
  } catch {
    return encrypted;
  }
}

/**
 * 生成随机 TOTP secret (Base32 编码)
 */
function generateTotpSecret(): string {
  const totp = new OTPAuth.TOTP({ issuer: 'BeeCount', algorithm: 'SHA1', digits: 6, period: 30 });
  return totp.secret.base32;
}

/**
 * 生成 10 个恢复码
 * 格式：XXXX-XXXX-XXXX (3组4位数字)
 */
function generateRecoveryCodes(): string[] {
  const codes: string[] = [];
  for (let i = 0; i < 10; i++) {
    let code = '';
    for (let j = 0; j < 12; j++) {
      if (j > 0 && j % 4 === 0) code += '-';
      const randDigit = crypto.getRandomValues(new Uint8Array(1))[0] % 10;
      code += randDigit.toString();
    }
    codes.push(code);
  }
  return codes;
}

/**
 * SHA256 哈希
 */
async function sha256Hash(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = new Uint8Array(hashBuffer);
  return Array.from(hashArray)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * 生成 TOTP URI (用于二维码)
 */
function buildOtpauthUri(secret: string, email: string): string {
  const totp = new OTPAuth.TOTP({ issuer: 'BeeCount', label: email, secret: OTPAuth.Secret.fromBase32(secret) });
  return totp.toString();
}

/**
 * 实现 RFC 6238 TOTP 算法
 * 
 * @param secret - Base32 编码的 TOTP secret
 * @param code - 6 位验证码
 * @param window - 允许的时间窗口（前后各 window 个步长）
 * @returns 是否验证通过
 */
async function verifyTotpCode(secret: string, code: string, window: number = 2): Promise<boolean> {
  if (!/^\d{6}$/.test(code)) return false;
  try {
    const totp = new OTPAuth.TOTP({ issuer: 'BeeCount', secret: OTPAuth.Secret.fromBase32(secret) });
    const delta = totp.validate({ token: code, window });
    return delta !== null;
  } catch {
    return false;
  }
}

// ===========================
// Schema 定义
// ===========================

const TwoFAConfirmSchema = z.object({
  code: z.string().regex(/^\d{6}$/, '必须是6位数字'),
});

const TwoFAVerifySchema = z.object({
  challenge_token: z.string(),
  code: z.string(),
  method: z.enum(['totp', 'recovery_code']).default('totp'),
  device_id: z.string().optional(),
  device_name: z.string().optional().default('Unknown Device'),
  platform: z.string().optional().default('unknown'),
  app_version: z.string().optional(),
  os_version: z.string().optional(),
  device_model: z.string().optional(),
  client_type: z.string().optional().default('mobile'),
});

const TwoFADisableSchema = z.object({
  password: z.string(),
  code: z.string().regex(/^\d{6}$/, '必须是6位数字'),
});

const TwoFARegenerateSchema = z.object({
  code: z.string().regex(/^\d{6}$/, '必须是6位数字'),
});

// ===========================
// 路由定义
// ===========================

type Bindings = {
  DB: D1Database;
  JWT_SECRET: string;
};

type Variables = {
  userId: string;
};

const twoFactorRouter = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// 2FA 路由挂载在 authRouter 下，auth 中间件不会运行，需要手动验证 JWT
// /verify 使用 body 中的 challenge_token 认证，不需要 Bearer token
twoFactorRouter.use('*', async (c, next) => {
  // /verify 使用 body 中的 challenge_token 认证，跳过 Bearer token 检查
  if (c.req.path.endsWith('/verify')) return next();

  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  const token = authHeader.slice(7);
  const jwtSecret = c.env.JWT_SECRET;
  const validationResult = await validateAccessToken(token, jwtSecret);
  if (!validationResult || !('userId' in validationResult)) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  c.set('userId', validationResult.userId);
  return next();
});

twoFactorRouter.get('/status', async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  
  console.log('[2FA] Status request - userId:', userId);

  if (!userId) {
    console.log('[2FA] No userId found in context');
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const user = await db
    .prepare('SELECT totp_enabled, totp_enabled_at FROM users WHERE id = ?')
    .bind(userId)
    .first<{ totp_enabled: number; totp_enabled_at: string | null }>();

  console.log('[2FA] User query result:', user);

  if (!user) {
    return c.json({ error: 'User not found' }, 404);
  }

  return c.json({
    enabled: Boolean(user.totp_enabled),
    enabled_at: user.totp_enabled_at,
  });
});

twoFactorRouter.post('/setup', async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const jwtSecret = c.env.JWT_SECRET;

  const user = await db
    .prepare('SELECT totp_enabled, email FROM users WHERE id = ?')
    .bind(userId)
    .first<{ totp_enabled: number; email: string }>();

  if (!user) {
    return c.json({ error: 'User not found' }, 404);
  }

  if (user.totp_enabled) {
    return c.json({ error: '2FA already enabled. Disable first to re-setup.' }, 409);
  }

  const secret = generateTotpSecret();

  // 与原版对齐：加密存储 TOTP secret
  const encryptedSecret = await encryptTotpSecret(secret, jwtSecret);
  await db
    .prepare('UPDATE users SET totp_secret_encrypted = ?, totp_enabled = 0, totp_enabled_at = NULL WHERE id = ?')
    .bind(encryptedSecret, userId)
    .run();

  const qrUri = buildOtpauthUri(secret, user.email);

  return c.json({
    secret,
    qr_code_uri: qrUri,
    expires_in: 300,
  });
});

twoFactorRouter.post('/confirm', zValidator('json', TwoFAConfirmSchema), async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const jwtSecret = c.env.JWT_SECRET;
  const { code } = c.req.valid('json');
  const serverNow = nowUtc();

  const user = await db
    .prepare('SELECT totp_enabled, totp_secret_encrypted FROM users WHERE id = ?')
    .bind(userId)
    .first<{ totp_enabled: number; totp_secret_encrypted: string | null }>();

  if (!user) {
    return c.json({ error: 'User not found' }, 404);
  }

  if (user.totp_enabled) {
    return c.json({ error: '2FA already enabled.' }, 409);
  }

  if (!user.totp_secret_encrypted) {
    return c.json({ error: 'No pending 2FA setup. Call /2fa/setup first.' }, 400);
  }

  const decryptedSecret = await getDecryptedTotpSecret(user.totp_secret_encrypted, jwtSecret);
  const isValid = await verifyTotpCode(decryptedSecret, code, 10);
  console.log('[2FA] confirm: isValid=', isValid, 'server_ts=', Math.floor(Date.now() / 1000));
  if (!isValid) {
    return c.json({ error: 'Invalid TOTP code.' }, 400);
  }

  await db
    .prepare('UPDATE users SET totp_enabled = 1, totp_enabled_at = ? WHERE id = ?')
    .bind(serverNow, userId)
    .run();

  const recoveryCodes = generateRecoveryCodes();

  await db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').bind(userId).run();

  for (const plainCode of recoveryCodes) {
    const codeHash = await sha256Hash(plainCode);
    await db
      .prepare('INSERT INTO recovery_codes (user_id, code_hash, created_at) VALUES (?, ?, ?)')
      .bind(userId, codeHash, serverNow)
      .run();
  }

  return c.json({
    enabled: true,
    recovery_codes: recoveryCodes,
  });
});

twoFactorRouter.post('/verify', zValidator('json', TwoFAVerifySchema), async (c) => {
  const clientIp = c.req.header('CF-Connecting-IP') || 'unknown';
  console.log(`[2FA-VERIFY] called from ${clientIp}`);
  if (isRateLimited('2fa-verify', clientIp, 60, 5)) {
    return c.json({ error: 'Too many requests. Try again later.' }, 429);
  }
  const db = c.env.DB;
  const jwtSecret = c.env.JWT_SECRET;
  const body = c.req.valid('json');
  // challenge_token 可能在请求体中，也可能在 Authorization header 中
  const authHeader = c.req.header('Authorization');
  const challenge_token = body.challenge_token
    || (authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined);
  const { code, method, device_id, device_name, platform, client_type: clientType } = body;
  const serverNow = nowUtc();

  if (!challenge_token) {
    return c.json({ error: 'Missing challenge token.' }, 400);
  }

  // 验证 challenge_token 签名（防止伪造）
  const challengeResult = await validateAccessToken(challenge_token, jwtSecret);
  if (!challengeResult || !('userId' in challengeResult)) {
    return c.json({ error: 'Invalid or expired challenge token.' }, 401);
  }
  // 验证 token type 必须是 totp_challenge（防止用 access token 绕过 2FA）
  const challengeParts = challenge_token.split('.');
  if (challengeParts.length === 3) {
    try {
      const payloadStr = base64urlDecode(challengeParts[1]);
      if (!payloadStr) { return c.json({ error: 'Invalid or expired challenge token.' }, 401); }
      const payload = JSON.parse(payloadStr);
      if (payload.type !== 'totp_challenge') {
        return c.json({ error: 'Invalid or expired challenge token.' }, 401);
      }
    } catch { return c.json({ error: 'Invalid or expired challenge token.' }, 401); }
  }
  const userId = challengeResult.userId;

  const user = await db
    .prepare('SELECT id, is_enabled, totp_enabled, totp_secret_encrypted, email FROM users WHERE id = ?')
    .bind(userId)
    .first<{ id: string; is_enabled: number; totp_enabled: number; totp_secret_encrypted: string | null; email: string }>();

  if (!user) {
    return c.json({ error: 'User not found' }, 401);
  }

  if (!user.is_enabled) {
    return c.json({ error: 'User disabled' }, 403);
  }

  if (!user.totp_enabled || !user.totp_secret_encrypted) {
    return c.json({ error: '2FA not enabled for this account.' }, 400);
  }

  let isValid = false;

  if (method === 'totp') {
    const decryptedSecret = await getDecryptedTotpSecret(user.totp_secret_encrypted, jwtSecret);
    isValid = await verifyTotpCode(decryptedSecret, code);
  } else if (method === 'recovery_code') {
    const codeHash = await sha256Hash(code);
    const recoveryCodes = await db
      .prepare('SELECT id, code_hash FROM recovery_codes WHERE user_id = ? AND used_at IS NULL')
      .bind(userId)
      .all<{ id: number; code_hash: string }>();

    for (const rc of recoveryCodes.results) {
      const rcBuf = new TextEncoder().encode(rc.code_hash);
      const chBuf = new TextEncoder().encode(codeHash);
      if (rcBuf.length === chBuf.length && await crypto.subtle.timingSafeEqual(rcBuf, chBuf)) {
        isValid = true;
        await db.prepare('UPDATE recovery_codes SET used_at = ? WHERE id = ?').bind(serverNow, rc.id).run();
        break;
      }
    }
  }

  if (!isValid) {
    return c.json({ error: 'Invalid 2FA code.' }, 401);
  }

  // 生成真正的签名 JWT access token（设备 upsert 前需要，冲突时提前返回）
  const isApp = clientType !== 'web';
  const tokenScopes = isApp ? ['app:write'] : ['web:read', 'web:write', 'ops:write'];
  const accessToken = await createAccessToken(user.id, jwtSecret, isApp ? 'app' : 'web', tokenScopes);

  // 创建/更新设备 — 与原版 _upsert_device 对齐：处理跨用户 device_id 冲突
  const resolvedDeviceId = device_id || randomUUID();
  const existingDevice = await db
    .prepare('SELECT id, user_id FROM devices WHERE id = ?')
    .bind(resolvedDeviceId)
    .first<{ id: string; user_id: string }>();

  if (existingDevice) {
    if (existingDevice.user_id !== user.id) {
      // 跨用户冲突：生成新 device_id 避免覆盖
      const newDeviceId = randomUUID();
      await db
        .prepare('INSERT INTO devices (id, user_id, name, platform, last_ip, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(newDeviceId, user.id, device_name || 'Unknown Device', platform || 'unknown', c.req.header('CF-Connecting-IP'), serverNow)
        .run();
      const newRefreshToken = await createRefreshToken(user.id, newDeviceId, db, isApp ? 'app' : 'web');
      return c.json({
        requires_2fa: false,
        user: { id: user.id, email: user.email, is_admin: Boolean((user as any).is_admin) },
        access_token: accessToken,
        refresh_token: newRefreshToken.token,
        expires_in: 3600,
        device_id: newDeviceId,
        scopes: tokenScopes,
      });
    }
    // 同一用户：更新设备信息
    await db.prepare('UPDATE devices SET last_seen_at = ?, name = COALESCE(?, name), platform = COALESCE(?, platform) WHERE id = ?')
      .bind(serverNow, device_name, platform, resolvedDeviceId).run();
  } else {
    await db
      .prepare('INSERT INTO devices (id, user_id, name, platform, last_ip, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(resolvedDeviceId, user.id, device_name || 'Unknown Device', platform || 'unknown', c.req.header('CF-Connecting-IP'), serverNow)
      .run();
  }

  // 创建 DB-backed refresh token
  const refreshToken = await createRefreshToken(user.id, resolvedDeviceId, db, isApp ? 'app' : 'web');

  // 清理该设备的旧 token（过期 + 已撤销），防止无限堆积
  await db.prepare(
    "DELETE FROM refresh_tokens WHERE user_id = ? AND device_id = ? AND (revoked_at IS NOT NULL OR expires_at < datetime('now'))"
  ).bind(user.id, resolvedDeviceId).run();

  return c.json({
    requires_2fa: false,
    user: { id: user.id, email: user.email, is_admin: Boolean((user as any).is_admin) },
    access_token: accessToken,
    refresh_token: refreshToken.token,
    expires_in: 3600,
    device_id: resolvedDeviceId,
    scopes: tokenScopes,
  });
});

twoFactorRouter.post('/disable', zValidator('json', TwoFADisableSchema), async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const jwtSecret = c.env.JWT_SECRET;
  const { password, code } = c.req.valid('json');
  const serverNow = nowUtc();

  const user = await db
    .prepare('SELECT password_hash, totp_enabled, totp_secret_encrypted FROM users WHERE id = ?')
    .bind(userId)
    .first<{ password_hash: string; totp_enabled: number; totp_secret_encrypted: string | null }>();

  if (!user) {
    return c.json({ error: 'User not found' }, 404);
  }

  if (!user.totp_enabled) {
    return c.json({ error: '2FA not enabled.' }, 400);
  }

  const passwordValid = await verifyPassword(user.password_hash, password);
  if (!passwordValid) {
    return c.json({ error: 'Invalid password.' }, 401);
  }

  if (!user.totp_secret_encrypted) {
    return c.json({ error: 'Invalid TOTP code.' }, 400);
  }

  const decryptedSecret = await getDecryptedTotpSecret(user.totp_secret_encrypted, jwtSecret);
  const isValid = await verifyTotpCode(decryptedSecret, code);
  if (!isValid) {
    return c.json({ error: 'Invalid TOTP code.' }, 400);
  }

  await db
    .prepare('UPDATE users SET totp_secret_encrypted = NULL, totp_enabled = 0, totp_enabled_at = NULL WHERE id = ?')
    .bind(userId)
    .run();

  await db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').bind(userId).run();

  return c.json({ disabled: true });
});

twoFactorRouter.post('/recovery-codes/regenerate', zValidator('json', TwoFARegenerateSchema), async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const jwtSecret = c.env.JWT_SECRET;
  const { code } = c.req.valid('json');
  const serverNow = nowUtc();

  const user = await db
    .prepare('SELECT totp_enabled, totp_secret_encrypted FROM users WHERE id = ?')
    .bind(userId)
    .first<{ totp_enabled: number; totp_secret_encrypted: string | null }>();

  if (!user) {
    return c.json({ error: 'User not found' }, 404);
  }

  if (!user.totp_enabled || !user.totp_secret_encrypted) {
    return c.json({ error: '2FA not enabled.' }, 400);
  }

  const decryptedSecret = await getDecryptedTotpSecret(user.totp_secret_encrypted, jwtSecret);
  const isValid = await verifyTotpCode(decryptedSecret, code);
  if (!isValid) {
    return c.json({ error: 'Invalid TOTP code.' }, 400);
  }

  await db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').bind(userId).run();

  const newCodes = generateRecoveryCodes();

  for (const plainCode of newCodes) {
    const codeHash = await sha256Hash(plainCode);
    await db
      .prepare('INSERT INTO recovery_codes (user_id, code_hash, created_at) VALUES (?, ?, ?)')
      .bind(userId, codeHash, serverNow)
      .run();
  }

  return c.json({ recovery_codes: newCodes });
});

export default twoFactorRouter;
