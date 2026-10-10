import { randomUUID } from 'crypto'
import { serverLogger } from './logger'

/** Device upsert with cross-user device-id collision protection. */
export async function upsertDevice(
  db: D1Database,
  userId: string,
  deviceId: string,
  deviceName: string,
  platform: string,
  appVersion?: string,
  osVersion?: string,
  deviceModel?: string,
  clientIp?: string | null,
): Promise<string> {
  let targetId = deviceId
  const now = new Date().toISOString()

  const existingAny = await db.prepare('SELECT id, user_id FROM devices WHERE id = ?')
    .bind(targetId).first<{ id: string; user_id: string }>()
  if (existingAny && existingAny.user_id !== userId) {
    serverLogger.info('src.routers.auth', `[AUTH] device_id cross-user collision id=${targetId} prev_user=${existingAny.user_id} new_user=${userId} -> minting new device_id`)
    targetId = randomUUID()
  }

  const existingDevice = await db.prepare(
    'SELECT id, revoked_at, name, platform, app_version, os_version, device_model, last_ip FROM devices WHERE id = ? AND user_id = ?'
  ).bind(targetId, userId).first<{
    id: string
    revoked_at: string | null
    name: string | null
    platform: string | null
    app_version: string | null
    os_version: string | null
    device_model: string | null
    last_ip: string | null
  }>()

  if (!existingDevice) {
    await db.prepare(
      `INSERT INTO devices (id, user_id, name, platform, app_version, os_version, device_model, last_ip, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(targetId, userId, deviceName, platform, appVersion || null, osVersion || null, deviceModel || null, clientIp, now).run()
  } else {
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
      targetId,
    ).run()
  }

  return targetId
}
