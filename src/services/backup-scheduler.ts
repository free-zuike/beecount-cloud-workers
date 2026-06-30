import { performBackup, calculateNextRun } from './backup-executor';

export async function processBackupSchedule(
  db: D1Database,
  schedule: any,
  taskLock?: DurableObjectNamespace
) {
  console.log(`[CRON] Processing schedule ${schedule.id}: ${schedule.name}`);

  // Use TaskLock DO to prevent concurrent execution
  if (taskLock) {
    try {
      const lockId = taskLock.idFromName(`backup-${schedule.id}`);
      const stub = taskLock.get(lockId);
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

    const runId = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    await db.prepare('INSERT INTO backup_runs (id, schedule_id, ledger_id, remote_id, status, started_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(runId, schedule.id, ledger.id, remoteId, 'pending', startedAt).run();

    try {
      const backupResult = await performBackup(db, runId, ledger.id, remoteConfig, shouldEncrypt);
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
    if (taskLock) {
      try {
        const lockId = taskLock.idFromName(`backup-${schedule.id}`);
        const stub = taskLock.get(lockId);
        await stub.fetch(new URL('/unlock', 'http://do'), { method: 'POST' });
      } catch { /* non-critical */ }
    }
  }
}
