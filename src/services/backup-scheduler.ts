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
  r2?: R2Bucket,
  env?: { CLOUDFLARE_API_TOKEN?: string },
) {
  // 清理超时的 pending 备份
  await cleanupStalePendingBackups(db);

  // 日志收集
  const logLines: string[] = [];
  const logFn = (msg: string) => {
    const timestamp = new Date().toISOString();
    logLines.push(`[${timestamp}] ${msg}`);
    console.log(`[CRON] ${msg}`);
  };

  logFn(`Processing schedule ${schedule.id}: ${schedule.name}`);

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
    
    // 插入备份记录
    let runId: number | null = null;
    try {
      const runInsertResult = await db.prepare('INSERT INTO backup_runs (schedule_id, user_id, ledger_id, remote_id, status, started_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(schedule.id, schedule.user_id, ledger.id, remoteId, 'running', startedAt).run();
      // D1 可能不返回 lastRowId，尝试从 meta 获取
      runId = (runInsertResult as any).lastRowId || (runInsertResult as any).meta?.last_row_id;
      if (!runId) {
        // 如果获取不到 lastRowId，查询最新的记录
        const latestRun = await db.prepare('SELECT id FROM backup_runs WHERE schedule_id = ? ORDER BY id DESC LIMIT 1')
          .bind(schedule.id).first<{ id: number }>();
        runId = latestRun?.id || null;
      }
      console.log(`[CRON] Created backup run: id=${runId}`);
    } catch (insertErr) {
      console.error(`[CRON] Failed to insert backup_runs: ${(insertErr as Error).message}`);
      return;
    }

    try {
      console.log(`[CRON] Starting backup for schedule ${schedule.id}, run ${runId}...`);
      const backupResult = await performBackup(db, runId!, schedule.user_id, ledger.id, remoteConfig, shouldEncrypt, r2, logFn, env);
      const finishedAt = new Date().toISOString();

      console.log(`[CRON] Backup result: success=${backupResult.success}, size=${backupResult.backupSize}, path=${backupResult.backupPath}`);

      // 创建 backup_run_targets 记录
      if (remoteId) {
        try {
          await db.prepare(
            `INSERT INTO backup_run_targets (run_id, remote_id, status, started_at, finished_at, bytes_transferred)
             VALUES (?, ?, ?, ?, ?, ?)`
          ).bind(
            runId,
            remoteId,
            backupResult.success ? 'succeeded' : 'failed',
            startedAt,
            finishedAt,
            backupResult.backupSize || 0
          ).run();
          logFn(`Created backup_run_target for remote ${remoteId}`);
        } catch (targetErr) {
          console.error(`[CRON] Failed to create backup_run_target: ${(targetErr as Error).message}`);
        }
      }

      // 更新备份状态
      const logText = logLines.join('\n').slice(0, 1024 * 1024); // 最大 1MB
      const updateSql = backupResult.success
        ? 'UPDATE backup_runs SET status = ?, finished_at = ?, bytes_total = ?, backup_filename = ?, backup_path = ?, log_text = ? WHERE id = ?'
        : 'UPDATE backup_runs SET status = ?, finished_at = ?, error_message = ?, log_text = ? WHERE id = ?';
      
      const updateParams = backupResult.success
        ? ['succeeded', finishedAt, backupResult.backupSize, backupResult.backupPath?.split('/').pop() || null, backupResult.backupPath, logText, runId]
        : ['failed', finishedAt, backupResult.message, logText, runId];

      console.log(`[CRON] Updating backup_runs: id=${runId}, status=${backupResult.success ? 'succeeded' : 'failed'}`);
      
      try {
        await db.prepare(updateSql).bind(...updateParams).run();
        console.log(`[CRON] Backup status updated successfully for run ${runId}`);
      } catch (dbErr) {
        console.error(`[CRON] Failed to update backup_runs status: ${(dbErr as Error).message}`);
        console.error(`[CRON] Update SQL: ${updateSql}`);
        console.error(`[CRON] Update params: ${JSON.stringify(updateParams)}`);
      }

      // WebSocket 广播备份状态
      try {
        const { getWsManager } = await import('../lib/ws-manager');
        await getWsManager().broadcastToUser(schedule.user_id, {
          type: 'backup_status',
          status: backupResult.success ? 'succeeded' : 'failed',
          runId: runId,
          backupSize: backupResult.backupSize,
          backupPath: backupResult.backupPath,
        });
        logFn(`Broadcast backup status to user ${schedule.user_id}`);
      } catch (wsErr) {
        logFn(`WebSocket broadcast failed (non-fatal): ${(wsErr as Error).message}`);
      }

      // 更新调度状态
      try {
        const nextRun = calculateNextRun(schedule.cron_expr, timezoneOffset);
        await db.prepare('UPDATE backup_schedules SET last_run_at = ?, last_run_status = ?, next_run_at = ?, updated_at = ? WHERE id = ?')
          .bind(startedAt, backupResult.success ? 'succeeded' : 'failed', nextRun, startedAt, schedule.id).run();
        console.log(`[CRON] Schedule status updated for schedule ${schedule.id}`);
      } catch (schedErr) {
        console.error(`[CRON] Failed to update backup_schedules: ${(schedErr as Error).message}`);
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      const finishedAt = new Date().toISOString();
      console.error(`[CRON] Exception during backup for schedule ${schedule.id}:`, error);
      
      try {
        await db.prepare('UPDATE backup_runs SET status = ?, finished_at = ?, error_message = ? WHERE id = ?')
          .bind('failed', finishedAt, errorMsg, runId).run();
        const nextRun = calculateNextRun(schedule.cron_expr, timezoneOffset);
        await db.prepare('UPDATE backup_schedules SET last_run_at = ?, last_run_status = ?, next_run_at = ?, updated_at = ? WHERE id = ?')
          .bind(startedAt, 'failed', nextRun, startedAt, schedule.id).run();
      } catch (dbErr) {
        console.error(`[CRON] Failed to update status after error: ${(dbErr as Error).message}`);
      }
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
