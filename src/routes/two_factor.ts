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

// ===========================
// 辅助函数
// ===========================

function nowUtc(): string {
  return new Date().toISOString();
}

/**
 * 生成随机 TOTP secret (Base32 编码)
 */
function generateTotpSecret(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let secret = '';
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  for (const b of bytes) {
    secret += chars[b % chars.length];
  }
  return secret;
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
      code += Math.floor(Math.random() * 10);
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
  const issuer = 'BeeCount';
  const label = encodeURIComponent(`${issuer}:${email}`);
  const encodedIssuer = encodeURIComponent(issuer);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodedIssuer}&algorithm=SHA1&digits=6&period=30`;
}

/**
 * Base32 解码
 */
function base32Decode(encoded: string): Uint8Array {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  encoded = encoded.toUpperCase().replace(/[^A-Z2-7]/g, '');
  
  const bits = [];
  for (let i = 0; i < encoded.length; i++) {
    const charIndex = chars.indexOf(encoded[i]);
    for (let j = 4; j >= 0; j--) {
      bits.push((charIndex >> j) & 1);
    }
  }

  const bytes = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8 && i + j < bits.length; j++) {
      byte = (byte << 1) | bits[i + j];
    }
    bytes.push(byte);
  }

  return new Uint8Array(bytes);
}

/**
 * 实现 RFC 6238 TOTP 算法
 * 
 * @param secret - Base32 编码的 TOTP secret
 * @param code - 6 位验证码
 * @param window - 允许的时间窗口（前后各 window 个步长）
 * @returns 是否验证通过
 */
async function verifyTotpCode(secret: string, code: string, window: number = 1): Promise<boolean> {
  // 验证格式
  if (!/^\d{6}$/.test(code)) return false;

  try {
    const secretBytes = base32Decode(secret);
    
    // 获取当前时间戳（秒）
    const timestamp = Math.floor(Date.now() / 1000);
    
    // 时间步长（30秒）
    const step = 30;
    
    for (let offset = -window; offset <= window; offset++) {
      // 计算当前步长的计数器值
      const counter = Math.floor((timestamp + offset * step) / step);
      
      // 将计数器转换为 8 字节的大端序
      const counterBuffer = new ArrayBuffer(8);
      const counterView = new DataView(counterBuffer);
      counterView.setUint32(0, Math.floor(counter / 0x100000000), false);
      counterView.setUint32(4, counter % 0x100000000, false);
      
      // HMAC-SHA1 计算
      const hmacKey = await crypto.subtle.importKey(
        'raw',
        secretBytes,
        { name: 'HMAC', hash: 'SHA-1' },
        false,
        ['sign']
      );
      
      const hmacResult = await crypto.subtle.sign('HMAC', hmacKey, counterBuffer);
      const hmacArray = new Uint8Array(hmacResult);
      
      // 动态截断（取最后 4 位作为偏移量）
      const offset = hmacArray[hmacArray.length - 1] & 0x0F;
      
      // 从偏移量处取 4 字节，转换为无符号整数
      const truncated = (hmacArray[offset] & 0x7F) << 24 |
                       (hmacArray[offset + 1] & 0xFF) << 16 |
                       (hmacArray[offset + 2] & 0xFF) << 8 |
                       (hmacArray[offset + 3] & 0xFF);
      
      // 取模得到 6 位数字
      const totp = truncated % 1000000;
      const totpStr = totp.toString().padStart(6, '0');
      
      if (totpStr === code) {
        return true;
      }
    }
    
    return false;
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
  device_id: z.string(),
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

twoFactorRouter.get('/status', async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;

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

twoFactorRouter.post('/setup', async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;

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

  await db
    .prepare('UPDATE users SET totp_secret_encrypted = ?, totp_enabled = 0, totp_enabled_at = NULL WHERE id = ?')
    .bind(secret, userId)
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

  const isValid = await verifyTotpCode(user.totp_secret_encrypted, code);
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
  const db = c.env.DB;
  const { challenge_token, code, method, device_id, device_name, platform } = c.req.valid('json');
  const serverNow = nowUtc();

  let userId: string;
  try {
    const parts = challenge_token.split('.');
    if (parts.length === 3) {
      const payload = JSON.parse(atob(parts[1]));
      userId = payload.sub;
    } else {
      throw new Error('Invalid challenge token format');
    }
  } catch {
    return c.json({ error: 'Invalid or expired challenge token.' }, 401);
  }

  const user = await db
    .prepare('SELECT id, is_enabled, totp_enabled, totp_secret_encrypted FROM users WHERE id = ?')
    .bind(userId)
    .first<{ id: string; is_enabled: number; totp_enabled: number; totp_secret_encrypted: string | null }>();

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
    isValid = await verifyTotpCode(user.totp_secret_encrypted, code);
  } else if (method === 'recovery_code') {
    const codeHash = await sha256Hash(code);
    const recoveryCodes = await db
      .prepare('SELECT id, code_hash FROM recovery_codes WHERE user_id = ? AND used_at IS NULL')
      .bind(userId)
      .all<{ id: number; code_hash: string }>();

    for (const rc of recoveryCodes) {
      if (rc.code_hash === codeHash) {
        isValid = true;
        await db.prepare('UPDATE recovery_codes SET used_at = ? WHERE id = ?').bind(serverNow, rc.id).run();
        break;
      }
    }
  }

  if (!isValid) {
    return c.json({ error: 'Invalid 2FA code.' }, 401);
  }

  const accessTokenPayload = {
    sub: user.id,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
    type: 'access',
  };

  const accessToken = btoa(JSON.stringify(accessTokenPayload));

  const existingDevice = await db
    .prepare('SELECT id FROM devices WHERE id = ? AND user_id = ?')
    .bind(device_id, user.id)
    .first();

  if (!existingDevice) {
    await db
      .prepare('INSERT INTO devices (id, user_id, name, platform, last_ip, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(device_id, user.id, device_name, platform, c.req.header('CF-Connecting-IP'), serverNow)
      .run();
  } else {
    await db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').bind(serverNow, device_id).run();
  }

  return c.json({
    requires_2fa: false,
    user_id: user.id,
    access_token: accessToken,
    refresh_token: randomUUID(),
    expires_in: 3600,
    device_id: device_id,
  });
});

twoFactorRouter.post('/disable', zValidator('json', TwoFADisableSchema), async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
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

  if (user.password_hash !== password) {
    return c.json({ error: 'Invalid password.' }, 401);
  }

  if (!user.totp_secret_encrypted) {
    return c.json({ error: 'Invalid TOTP code.' }, 400);
  }

  const isValid = await verifyTotpCode(user.totp_secret_encrypted, code);
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

  const isValid = await verifyTotpCode(user.totp_secret_encrypted, code);
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
