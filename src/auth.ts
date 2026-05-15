import { createJWT, validateJWT, JWTError } from 'oslo/jwt';
import { Argon2id } from 'oslo/password';
import { TimeSpan } from 'oslo';
import { sha256 } from 'oslo/crypto';
import { encodeHex } from 'oslo/encoding';
import { randomUUID } from 'crypto';

const argon2 = new Argon2id();

export async function hashPassword(password: string): Promise<string> {
  return await argon2.hash(password);
}

export async function verifyPassword(
  hash: string,
  password: string
): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

export async function createAccessToken(
  userId: string,
  secret: string
): Promise<string> {
  const payload = {
    sub: userId,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 60 * 60 // 1 hour
  };
  return await createJWT('HS256', secret, payload);
}

export async function createRefreshToken(
  userId: string,
  deviceId: string,
  db: D1Database
): Promise<{ id: string; token: string; expiresAt: Date }> {
  const token = randomUUID();
  const tokenHash = encodeHex(await sha256(new TextEncoder().encode(token)));
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days
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
    const result = await validateJWT('HS256', secret, token);
    return result.payload.sub as string;
  } catch (e) {
    if (e instanceof JWTError) {
      return null;
    }
    throw e;
  }
}
