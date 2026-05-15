import bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';

const JWT_ALG = 'HS256';

export async function hashPassword(password: string): Promise<string> {
  const salt = await bcrypt.genSalt(10);
  return await bcrypt.hash(password, salt);
}

export async function verifyPassword(
  hash: string,
  password: string
): Promise<boolean> {
  try {
    return await bcrypt.compare(password, hash);
  } catch {
    return false;
  }
}

function base64urlEncode(str: string): string {
  return Buffer.from(str).toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

function base64urlDecode(str: string): string {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64').toString('utf8');
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data));
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
  return Buffer.from(signature).toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

export async function createAccessToken(
  userId: string,
  secret: string
): Promise<string> {
  const header = JSON.stringify({ alg: JWT_ALG, typ: 'JWT' });
  const payload = JSON.stringify({
    sub: userId,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 60 * 60
  });
  
  const headerB64 = base64urlEncode(header);
  const payloadB64 = base64urlEncode(payload);
  const signature = await hmacSHA256(secret, `${headerB64}.${payloadB64}`);
  
  return `${headerB64}.${payloadB64}.${signature}`;
}

export async function createRefreshToken(
  userId: string,
  deviceId: string,
  db: D1Database
): Promise<{ id: string; token: string; expiresAt: Date }> {
  const token = randomUUID();
  const tokenHash = Buffer.from(await sha256(new TextEncoder().encode(token))).toString('hex');
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  const id = randomUUID();

  await db.prepare(`
    INSERT INTO refresh_tokens (id, user_id, device_id, token_hash, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `).bind(id, userId, deviceId, tokenHash, expiresAt.toISOString()).run();

  return { id, token, expiresAt };
}

export async function validateAccessToken(
  token: string,
  secret: string
): Promise<string | null> {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    
    const [headerB64, payloadB64, signature] = parts;
    
    const expectedSignature = await hmacSHA256(secret, `${headerB64}.${payloadB64}`);
    if (signature !== expectedSignature) return null;
    
    const payload = JSON.parse(base64urlDecode(payloadB64));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }
    
    return payload.sub as string;
  } catch {
    return null;
  }
}