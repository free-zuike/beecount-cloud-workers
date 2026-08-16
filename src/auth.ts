import bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';

const JWT_ALG = 'HS256';
// 对齐原版 passlib pbkdf2_sha256 默认 rounds（passlib 1.7: 29000）
const PBKDF2_ITERATIONS = 29000;
// 对齐原版 passlib 默认 salt 长度（16 字节）
const SALT_BYTES = 16;

/** passlib ab64 编码：标准 base64 `+` → `.`，无 padding。 */
function ab64Encode(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary)
    .replace(/\+/g, '.')
    .replace(/=+$/, '');
}

/** passlib ab64 解码：`.` → `+`，补 padding 后标准 base64 解码。 */
function ab64Decode(str: string): Uint8Array | null {
  try {
    const base64 = str.replace(/\./g, '+');
    let padded = base64;
    while (padded.length % 4) padded += '=';
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

function hexToBytes(hex: string): Uint8Array | null {
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

// 兼容旧格式检测：我们此前的实现是 `$pbkdf2-sha256$<rounds>$<16位hex盐>$<64位hex哈希>`。
// passlib 原生格式：`$pbkdf2-sha256$<rounds>$<22位ab64盐>$<43位ab64哈希>`。
function isLegacyHexPbkdf2(hash: string): boolean {
  const parts = hash.split('$');
  if (parts.length !== 5 || parts[1] !== 'pbkdf2-sha256') return false;
  return /^[0-9a-f]{16}$/i.test(parts[3]) && /^[0-9a-f]{64}$/i.test(parts[4]);
}

async function pbkdf2Sha256(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const derivedBits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    keyMaterial, 256
  );
  return new Uint8Array(derivedBits);
}

/** 恒定时比较，防时序攻击。Web Crypto 的 SubtleCrypto 没有 timingSafeEqual
 * （那是 Node crypto 模块专属），Workers 运行时调用会抛错，这里手动实现：
 * 先比长度，再做逐字节 XOR 累积，耗时与内容无关。 */
function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

async function verifyPbkdf2Sha256(hash: string, password: string): Promise<boolean> {
  const parts = hash.split('$');
  if (parts.length !== 5 || parts[1] !== 'pbkdf2-sha256') return false;
  const iterations = parseInt(parts[2], 10);
  if (!Number.isFinite(iterations) || iterations <= 0) return false;

  let salt: Uint8Array | null;
  let storedHash: Uint8Array | null;
  if (isLegacyHexPbkdf2(hash)) {
    salt = hexToBytes(parts[3]);
    storedHash = hexToBytes(parts[4]);
  } else {
    salt = ab64Decode(parts[3]);
    storedHash = ab64Decode(parts[4]);
  }
  if (!salt || !storedHash) return false;

  const computed = await pbkdf2Sha256(password, salt, iterations);
  return timingSafeEqualBytes(computed, storedHash);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const digest = await pbkdf2Sha256(password, salt, PBKDF2_ITERATIONS);
  // passlib pbkdf2_sha256 格式：$pbkdf2-sha256$rounds$ab64_salt$ab64_checksum
  return `$pbkdf2-sha256$${PBKDF2_ITERATIONS}$${ab64Encode(salt)}$${ab64Encode(digest)}`;
}

export async function verifyPassword(
  hash: string,
  password: string
): Promise<boolean> {
  try {
    if (hash.startsWith('$pbkdf2-sha256$')) {
      return await verifyPbkdf2Sha256(hash, password);
    }
    return await bcrypt.compare(password, hash);
  } catch {
    return false;
  }
}

/** 检查密码哈希是否需要迁移到 passlib pbkdf2 格式（bcrypt 旧格式 或 我们此前的 hex pbkdf2）。 */
export function isLegacyPasswordHash(hash: string): boolean {
  return hash.startsWith('$2b$') || hash.startsWith('$2a$') || isLegacyHexPbkdf2(hash);
}

function base64urlEncode(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

export function base64urlDecode(str: string): string | null {
  try {
    str = str.replace(/-/g, '+').replace(/_/g, '/');
    while (str.length % 4) str += '=';
    const binary = atob(str);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data));
}

function uint8ArrayToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function uint8ArrayToBase64url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

async function hmacSHA256(key: string, data: string): Promise<string> {
  const keyBytes = new TextEncoder().encode(key);
  const dataBytes = new TextEncoder().encode(data);
  
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, dataBytes);
  return uint8ArrayToBase64url(new Uint8Array(signature));
}

/** 解码并验证 JWT（与原版 decode_token 对齐） */
async function decodeJwtPayload(token: string, secret: string): Promise<Record<string, unknown> | null> {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [headerB64, payloadB64, signature] = parts;
    const expectedSig = await hmacSHA256(secret, `${headerB64}.${payloadB64}`);
    const encoder = new TextEncoder();
    if (!timingSafeEqualBytes(encoder.encode(signature), encoder.encode(expectedSig))) {
      return null;
    }
    const payloadStr = base64urlDecode(payloadB64);
    if (!payloadStr) return null;
    return JSON.parse(payloadStr);
  } catch {
    return null;
  }
}

export async function createAccessToken(
  userId: string,
  secret: string,
  clientType: string = 'app',
  scopes: string[] = ['app_write'],
  expiresIn: number = 3600,
  tokenType: string = 'access'
): Promise<string> {
  const header = JSON.stringify({ alg: JWT_ALG, typ: 'JWT' });
  const payload = JSON.stringify({
    sub: userId,
    type: tokenType,
    client_type: clientType,
    scopes: scopes,
    jti: randomUUID().replace(/-/g, ''),
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + expiresIn
  });
  
  const headerB64 = base64urlEncode(header);
  const payloadB64 = base64urlEncode(payload);
  const signature = await hmacSHA256(secret, `${headerB64}.${payloadB64}`);
  
  return `${headerB64}.${payloadB64}.${signature}`;
}

export async function createRefreshToken(
  userId: string,
  deviceId: string,
  db: D1Database,
  clientType: string = 'app',
  scopes: string[] = ['app_write'],
  jwtSecret: string = ''
): Promise<{ id: string; token: string; expiresAt: Date }> {
  // 与原版对齐：refresh token 也是 JWT（type=refresh），不是随机 UUID
  const expiresIn = 30 * 24 * 60 * 60; // 30 天
  const token = await createAccessToken(userId, jwtSecret, clientType, scopes, expiresIn, 'refresh');
  const tokenHash = uint8ArrayToHex(await sha256(new TextEncoder().encode(token)));
  const expiresAt = new Date(Date.now() + expiresIn * 1000);
  const id = randomUUID();

  await db.prepare(`
    INSERT INTO refresh_tokens (id, user_id, device_id, token_hash, expires_at, client_type)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(id, userId, deviceId, tokenHash, expiresAt.toISOString(), clientType).run();

  return { id, token, expiresAt };
}

export async function decodeRefreshToken(
  token: string,
  db: D1Database,
  jwtSecret?: string
): Promise<{ valid: true; userId: string; deviceId: string; clientType: string; scopes: string[] } | { valid: false; reason: string }> {
  try {
    // 与原版对齐：先解码 JWT 获取 claims，再查 DB 做吊销检查
    const secret = jwtSecret || '';
    if (!secret) {
      return { valid: false, reason: 'JWT secret not configured' };
    }

    // 尝试解码 JWT，失败时仍然通过 DB 查找（兼容旧版空 payload）
    let payload: Record<string, unknown> | null = null;
    let userIdFromJwt: string | null = null;
    let clientTypeFromJwt: string | null = null;
    let scopesFromJwt: string[] | null = null;

    try {
      const decoded = await decodeJwtPayload(token, secret);
      if (decoded) {
        payload = decoded;
        // 只取标准 JWT 的 sub 字段
        if (payload.sub) {
          userIdFromJwt = String(payload.sub);
        }
        if (payload.client_type) {
          clientTypeFromJwt = String(payload.client_type);
        }
        if (payload.type && payload.type === 'access') {
          return { valid: false, reason: 'Invalid token type' };
        }
        if (payload.scopes && Array.isArray(payload.scopes)) {
          scopesFromJwt = payload.scopes as string[];
        }
      }
    } catch {
      // JWT 解码失败，继续通过 DB 查找
    }

    const tokenHash = uint8ArrayToHex(await sha256(new TextEncoder().encode(token)));
    const now = new Date().toISOString();
    const gracePeriodMs = 60 * 1000;
    const graceCutoff = new Date(Date.now() - gracePeriodMs).toISOString();

    // 查 DB 检查吊销和过期（与原版对齐：JWT + DB 混合验证）
    let result = await db.prepare(`
      SELECT user_id, device_id, expires_at, client_type
      FROM refresh_tokens
      WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?
    `).bind(tokenHash, now).first<{ user_id: string; device_id: string; expires_at: string; client_type: string | null }>();

    if (!result) {
      const graceResult = await db.prepare(`
        SELECT user_id, device_id, expires_at, client_type
        FROM refresh_tokens
        WHERE token_hash = ? AND revoked_at IS NOT NULL AND revoked_at > ? AND expires_at > ?
      `).bind(tokenHash, graceCutoff, now).first<{ user_id: string; device_id: string; expires_at: string; client_type: string | null }>();
      if (graceResult) {
        result = graceResult;
      }
    }

    if (!result) {
      return { valid: false, reason: 'Refresh token expired' };
    }

    // 用 DB 记录的 user_id 兜底（兼容 JWT payload 为空的情况）
    const userId = userIdFromJwt || result.user_id;
    const isApp = result.client_type === 'web' ? false : true;
    const defaultScopes = isApp ? ['app_write'] : ['web_read', 'web_write', 'ops_write'];
    const scopes = scopesFromJwt || defaultScopes;

    return {
      valid: true,
      userId: userId,
      deviceId: result.device_id,
      clientType: clientTypeFromJwt || result.client_type || (isApp ? 'app' : 'web'),
      scopes: scopes,
    };
  } catch (err) {
    return { valid: false, reason: (err as Error).message };
  }
}

export async function revokeRefreshToken(
  token: string,
  db: D1Database
): Promise<boolean> {
  try {
    const tokenHash = uint8ArrayToHex(await sha256(new TextEncoder().encode(token)));
    const now = new Date().toISOString();
    
    const result = await db.prepare(`
      UPDATE refresh_tokens 
      SET revoked_at = ? 
      WHERE token_hash = ? AND revoked_at IS NULL
    `).bind(now, tokenHash).run();
    
    return (result as any).changes > 0;
  } catch (error) {
    return false;
  }
}

export async function validateAccessToken(
  token: string,
  secret: string
): Promise<{ userId: string } | { expired: true } | null> {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    
    const [headerB64, payloadB64, signature] = parts;
    
    const expectedSignature = await hmacSHA256(secret, `${headerB64}.${payloadB64}`);
    
    const encoder = new TextEncoder();
    const sig1 = encoder.encode(signature);
    const sig2 = encoder.encode(expectedSignature);
    if (!timingSafeEqualBytes(sig1, sig2)) return null;
    
    const payloadStr = base64urlDecode(payloadB64);
    if (!payloadStr) return null;
    
    const payload = JSON.parse(payloadStr);
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
      return { expired: true };
    }
    
    return { userId: payload.sub as string };
  } catch {
    return null;
  }
}
