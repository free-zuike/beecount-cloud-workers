/**
 * 认证设备的增量同步失败连续计数（对齐上游 src/services/sync_health.py，1.10.x）。
 *
 * - push：非移动冲突的拒绝计入 changes_rejected；全部拒绝都来自「交易已移动」时不计数
 *   （那是终态，不是故障）；有任何接受则清零。
 * - pull：任一次成功拉取即清零。
 * - 服务端 5xx/异常：计 server_error（HTTP <500 的业务错误不计数）。
 * 连续 ≥3 次失败会出现在个人通知中心（device_sync_failure）。
 */

export type SyncDirection = 'push' | 'pull';
export type SyncFailureReason = 'changes_rejected' | 'server_error';

export const SYNC_FAILURE_THRESHOLD = 3;

function nowUtc(): string {
  return new Date().toISOString();
}

/** 失败一次：存在则累加并刷新时间/原因，不存在则以新 incident 起算。 */
export async function recordSyncFailure(
  db: D1Database,
  deviceId: string | null | undefined,
  direction: SyncDirection,
  reason: SyncFailureReason
): Promise<void> {
  if (!deviceId) return;
  const now = nowUtc();
  try {
    await db
      .prepare(
        `INSERT INTO device_sync_failures
           (device_id, direction, incident_id, failure_count, reason, first_failed_at, last_failed_at)
         VALUES (?, ?, ?, 1, ?, ?, ?)
         ON CONFLICT(device_id, direction) DO UPDATE SET
           failure_count = failure_count + 1,
           reason = excluded.reason,
           last_failed_at = excluded.last_failed_at`
      )
      .bind(deviceId, direction, crypto.randomUUID(), reason, now, now)
      .run();
  } catch (error) {
    // 计数失败绝不能拖垮同步主流程
    console.error('[sync-health] record failure error:', error);
  }
}

/** 成功一次：清空该方向的连续失败。 */
export async function recordSyncRecovery(
  db: D1Database,
  deviceId: string | null | undefined,
  direction: SyncDirection
): Promise<void> {
  if (!deviceId) return;
  try {
    await db
      .prepare('DELETE FROM device_sync_failures WHERE device_id = ? AND direction = ?')
      .bind(deviceId, direction)
      .run();
  } catch (error) {
    console.error('[sync-health] record recovery error:', error);
  }
}

/** 5xx/未捕获异常 → server_error；<500 的业务错误不计数。 */
export async function observeServerErrors<T>(
  db: D1Database,
  deviceId: string | null | undefined,
  direction: SyncDirection,
  fn: () => Promise<T>
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    const status = (error as { status?: number } | null)?.status;
    const isClientError = typeof status === 'number' && status < 500;
    if (deviceId && !isClientError) {
      await recordSyncFailure(db, deviceId, direction, 'server_error');
    }
    throw error;
  }
}

export interface SyncFailureDetail {
  direction: SyncDirection;
  count: number;
  reason: SyncFailureReason;
  first_failed_at: string;
  last_failed_at: string;
}

export async function listSyncFailures(
  db: D1Database,
  deviceId: string
): Promise<SyncFailureDetail[]> {
  const rows = await db
    .prepare(
      `SELECT direction, failure_count, reason, first_failed_at, last_failed_at
       FROM device_sync_failures WHERE device_id = ? ORDER BY direction`
    )
    .bind(deviceId)
    .all<{
      direction: string;
      failure_count: number;
      reason: string;
      first_failed_at: string;
      last_failed_at: string;
    }>();
  return (rows.results ?? []).map((row) => ({
    direction: row.direction as SyncDirection,
    count: row.failure_count,
    reason: row.reason as SyncFailureReason,
    first_failed_at: row.first_failed_at,
    last_failed_at: row.last_failed_at,
  }));
}
