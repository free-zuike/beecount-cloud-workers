import { performBackup, calculateNextRun } from './backup-executor';

/**
 * 清理超时的 pending 状态备份记录
 * 如果备份卡在 pending 状态超过 5 分钟，标记为 failed
 */
async function cleanupStalePendingBackups(db: D1Database): Promise<void> {
  try {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const result = await db
      .prepare(
        `UPDATE backup_runs SET status = 'failed', error_message = 'Backup timed out (page refresh or connection lost)'
         WHERE status = 'pending' AND started_at < ?`
      )
      .bind(fiveMinutesAgo)
      .run();
    if (result.meta.changes > 0) {
      console.log(`[CRON] Cleaned up ${result.meta.changes} stale pending backups`);
    }
  } catch (err) {
    console.error('[CRON] Failed to cleanup stale pending backups:', err);
  }
}

export async function processBackupSchedule(
  db: D1Database,
  schedule: any,
  beeCountDO?: DurableObjectNamespace,
  r2?: R2Bucket
) {
  // 清理超时的 pending 备份
  await cleanupStalePendingBackups(db);

  console.log(`[CRON] Processing schedule ${schedule.id}: ${schedule.name}`);

  // Use BeeCount DO for distributed locking
  if (beeCountDO) {
    try {
      const lockId = beeCountDO.idFromName(`lock-${schedule.id}`);
      const stub = beeCountDO.get(lockId);
      const lockResult = await stub.fetch(new URL('/lock', 'http://do'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ holder: `cron-${schedule.id}`, ttlMs: 30 * 60 * 1000 }),
      }).then(r => r.json()) as { acquired: boolean };
      if (!lockResult.acquired) {
        console.log(`[CRON] Schedule ${schedule.id} is already locked, skipping`);
        return;
      }
    } catch (e) {
      console.log(`[CRON] TaskLock unavailable, proceeding without lock:`, e);
    }
  }

  try {
    const timezoneOffset = schedule.timezone_offset || 0;

    if (!schedule.next_run_at) {
      const nextRun = calculateNextRun(schedule.cron_expr, timezoneOffset);
      await db.prepare('UPDATE backup_schedules SET next_run_at = ? WHERE id = ?')
        .bind(nextRun, schedule.id).run();
      console.log(`[CRON] Set initial next_run_at for schedule ${schedule.id}: ${nextRun}`);
      return;
    }

    const now = new Date().toISOString();
    if (now < schedule.next_run_at) {
      console.log(`[CRON] Schedule ${schedule.id} not due yet. Next run: ${schedule.next_run_at}`);
      return;
    }

    console.log(`[CRON] Executing schedule ${schedule.id}: ${schedule.name}`);

    // 先更新 next_run_at 防止重复触发
    const nextRun = calculateNextRun(schedule.cron_expr, timezoneOffset);
    await db.prepare('UPDATE backup_schedules SET next_run_at = ? WHERE id = ?')
      .bind(nextRun, schedule.id).run();

    const ledger = await db.prepare('SELECT id FROM ledgers WHERE user_id = ? LIMIT 1')
      .bind(schedule.user_id).first<{ id: string }>();
    if (!ledger) {
      console.log(`[CRON] No ledger found for schedule ${schedule.id}, skipping`);
      return;
    }

    let remoteId: string | null = null;
    let remoteConfig: Record<string, string> = { backend_type: 'local' };
    let shouldEncrypt = false;

    if (schedule.remote_ids) {
      try {
        const remoteIds = JSON.parse(schedule.remote_ids);
        if (remoteIds.length > 0) {
          remoteId = String(remoteIds[0]);
          const remote = await db.prepare('SELECT backend_type, config_summary, encrypted FROM backup_remotes WHERE id = ?')
            .bind(remoteId).first<{ backend_type: string; config_summary: string; encrypted: number }>();
          if (remote) {
            const parsedConfig = JSON.parse(remote.config_summary || '{}');
            remoteConfig = { backend_type: remote.backend_type, ...parsedConfig,
              savePath: parsedConfig.root_path ? parsedConfig.root_path.replace(/^\/+|\/+$/g, '') : 'custom' };
            shouldEncrypt = remote.encrypted === 1;
          }
        }
      } catch (e) {
        console.log(`[CRON] Failed to parse remote config for schedule ${schedule.id}:`, e);
      }
    }

    const startedAt = new Date().toISOString();
    const runInsertResult = await db.prepare('INSERT INTO backup_runs (schedule_id, ledger_id, remote_id, status, started_at) VALUES (?, ?, ?, ?, ?)')
      .bind(schedule.id, ledger.id, remoteId, 'pending', startedAt).run();
    const runId = (runInsertResult as any).lastRowId;

    try {
      const backupResult = await performBackup(db, runId, schedule.user_id, ledger.id, remoteConfig, shouldEncrypt, r2);
      const finishedAt = new Date().toISOString();

      if (backupResult.success) {
        await db.prepare('UPDATE backup_runs SET status = ?, finished_at = ?, bytes_total = ?, backup_filename = ?, backup_path = ? WHERE id = ?')
          .bind('completed', finishedAt, backupResult.backupSize, backupResult.backupPath?.split('/').pop() || null, backupResult.backupPath, runId).run();
        console.log(`[CRON] Backup completed for schedule ${schedule.id}`);
      } else {
        await db.prepare('UPDATE backup_runs SET status = ?, finished_at = ?, error_message = ? WHERE id = ?')
          .bind('failed', finishedAt, backupResult.message, runId).run();
        console.log(`[CRON] Backup failed for schedule ${schedule.id}:`, backupResult.message);
      }

      const nextRun = calculateNextRun(schedule.cron_expr, timezoneOffset);
      await db.prepare('UPDATE backup_schedules SET last_run_at = ?, last_run_status = ?, next_run_at = ?, updated_at = ? WHERE id = ?')
        .bind(startedAt, backupResult.success ? 'completed' : 'failed', nextRun, startedAt, schedule.id).run();
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      const finishedAt = new Date().toISOString();
      await db.prepare('UPDATE backup_runs SET status = ?, finished_at = ?, error_message = ? WHERE id = ?')
        .bind('failed', finishedAt, errorMsg, runId).run();
      const nextRun = calculateNextRun(schedule.cron_expr, timezoneOffset);
      await db.prepare('UPDATE backup_schedules SET last_run_at = ?, last_run_status = ?, next_run_at = ?, updated_at = ? WHERE id = ?')
        .bind(startedAt, 'failed', nextRun, startedAt, schedule.id).run();
      console.error(`[CRON] Exception during backup for schedule ${schedule.id}:`, error);
    }
  } finally {
    if (beeCountDO) {
      try {
        const lockId = beeCountDO.idFromName(`lock-${schedule.id}`);
        const stub = beeCountDO.get(lockId);
        await stub.fetch(new URL('/unlock', 'http://do'), { method: 'POST' });
      } catch { /* non-critical */ }
    }
  }
}
