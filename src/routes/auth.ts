import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { hashPassword, verifyPassword, createAccessToken, createRefreshToken, validateAccessToken } from '../auth';

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

  // Create user profile
  await db.prepare(`
    INSERT INTO user_profiles (user_id, display_name)
    VALUES (?, ?)
  `).bind(userId, email).run();

  return c.json({ success: true });
});

// Login
authRouter.post('/login', zValidator('json', z.object({
  email: z.string().email(),
  password: z.string(),
  device_id: z.string().optional(),
  device_name: z.string().optional().default('Unknown Device'),
  platform: z.string().optional().default('unknown')
})), async (c) => {
  const { email, password, device_id: deviceId, device_name: deviceName, platform } = c.req.valid('json');
  const resolvedDeviceId = deviceId || randomUUID();
  const db = c.env.DB;
  const jwtSecret = c.env.JWT_SECRET;

  const user = await db.prepare('SELECT id, password_hash, is_enabled, totp_enabled FROM users WHERE email = ?').bind(email).first<{ id: string, password_hash: string, is_enabled: number, totp_enabled: number }>();
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
  const existingDevice = await db.prepare('SELECT id FROM devices WHERE id = ? AND user_id = ?').bind(resolvedDeviceId, user.id).first();
  if (!existingDevice) {
    await db.prepare(`
      INSERT INTO devices (id, user_id, name, platform, last_ip, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(resolvedDeviceId, user.id, deviceName, platform, c.req.header('CF-Connecting-IP'), new Date().toISOString()).run();
  } else {
    await db.prepare(`
      UPDATE devices
      SET last_seen_at = ?, last_ip = ?, name = ?
      WHERE id = ?
    `).bind(new Date().toISOString(), c.req.header('CF-Connecting-IP'), deviceName, resolvedDeviceId).run();
  }

  const accessToken = await createAccessToken(user.id, jwtSecret);
  const refreshToken = await createRefreshToken(user.id, resolvedDeviceId, db);

  return c.json({
    access_token: accessToken,
    refresh_token: refreshToken.token,
    expires_in: 3600,
    token_type: 'Bearer',
    user_id: user.id
  });
});

// Refresh token
authRouter.post('/refresh', zValidator('json', z.object({
  refresh_token: z.string()
})), async (c) => {
  // TODO: Implement refresh token logic
  return c.json({ error: 'Not implemented' }, 501);
});

export default authRouter;
