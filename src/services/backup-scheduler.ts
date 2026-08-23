import { performBackupFanOut, calculateNextRun } from './backup-executor';

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
    // 也清理卡在 running 状态超过 10 分钟的备份
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const runningResult = await db
      .prepare(
        `UPDATE backup_runs SET status = 'failed', error_message = 'Backup timed out (stuck in running)'
         WHERE status = 'running' AND started_at < ?`
      )
      .bind(tenMinutesAgo)
      .run();
    if (runningResult.meta.changes > 0) {
      console.log(`[CRON] Cleaned up ${runningResult.meta.changes} stale running backups`);
    }
  } catch (err) {
    console.error('[CRON] Failed to cleanup stale pending backups:', err);
  }
}

/**
 * 广播进度事件到 WebSocket（对齐原版 _job_fn 的 on_progress 回调）
 */
async function broadcastProgress(
  beeCountDO: DurableObjectNamespace | undefined,
  userId: string,
  event: Record<string, unknown>,
  type: string = 'backup_status',
): Promise<void> {
  if (!beeCountDO || !userId) return;
  try {
    const doId = beeCountDO.idFromName(`ws-${userId}`);
    const stub = beeCountDO.get(doId);
    const fetchPromise = stub.fetch(new URL('/broadcast', 'http://do'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: JSON.stringify({ type, ...event }) }),
    });
    const timeoutPromise = new Promise<Response>((_, reject) =>
      setTimeout(() => reject(new Error('broadcast timeout')), 5000)
    );
    await Promise.race([fetchPromise, timeoutPromise]);
  } catch { /* non-critical */ }
}

/**
 * 解析时区偏移 — 优先使用 schedule 自身的偏移，否则从 system_settings 读取
 */
async function resolveTimezoneOffset(db: D1Database, scheduleOffset: number | null | undefined): Promise<number> {
  if (scheduleOffset) return scheduleOffset;
  try {
    const sysSetting = await db
      .prepare('SELECT timezone_offset FROM system_settings WHERE id = ?')
      .bind('default')
      .first<{ timezone_offset: number }>();
    if (sysSetting?.timezone_offset) return sysSetting.timezone_offset;
  } catch { /* ignore */ }
  return 0;
}

export async function processBackupSchedule(
  db: D1Database,
  schedule: any,
  beeCountDO?: DurableObjectNamespace,
  r2?: R2Bucket,
  env?: { CLOUDFLARE_API_TOKEN?: string; BEECOUNT_DO?: DurableObjectNamespace; BACKUP_WORKFLOW?: any },
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
    const timezoneOffset = await resolveTimezoneOffset(db, schedule.timezone_offset);

    if (!schedule['next_run_at']) {
      const nextRun = calculateNextRun(schedule['cron_expr'], await resolveTimezoneOffset(db, schedule['timezone_offset']));
      await db.prepare('UPDATE backup_schedules SET next_run_at = ? WHERE id = ?')
        .bind(nextRun, schedule['id']).run();
      console.log(`[CRON] Set initial next_run_at for schedule ${schedule['id']}: ${nextRun}`);
      return;
    }

    const now = new Date();
    // 直接查询数据库获取 next_run_at，避免 Row 对象属性访问问题
    const scheduleRow = await db.prepare('SELECT next_run_at FROM backup_schedules WHERE id = ?')
      .bind(schedule['id']).first<{ next_run_at: string }>();
    console.log(`[CRON] Schedule ${schedule['id']}: DB next_run_at=${JSON.stringify(scheduleRow)}, now=${now.toISOString()}`);
    const nextRunAt = scheduleRow?.next_run_at ? new Date(scheduleRow.next_run_at) : null;
    if (nextRunAt && now < nextRunAt) {
      console.log(`[CRON] Schedule ${schedule['id']} not due yet. Next run: ${scheduleRow?.next_run_at}`);
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
    let remoteConfigs: Array<{ remoteId: string; config: Record<string, string> }> = [];
    let shouldEncrypt = false;

    // remote_ids 优先从 M2M 表读（对齐原版），回退 remote_ids JSON 列
    let remoteIds: Array<string | number> = [];
    try {
      const m2m = await db.prepare('SELECT remote_id FROM backup_schedule_remotes WHERE schedule_id = ? ORDER BY sort_order ASC')
        .bind(schedule.id).all<{ remote_id: number }>();
      if (m2m.results.length > 0) {
        remoteIds = m2m.results.map(r => r.remote_id);
      } else if (schedule.remote_ids) {
        const parsed = JSON.parse(schedule.remote_ids);
        remoteIds = Array.isArray(parsed) ? parsed : [];
      }
    } catch (e) {
      console.log(`[CRON] Failed to resolve remote ids for schedule ${schedule.id}:`, e);
    }
    for (const rid of remoteIds) {
      const remote = await db.prepare('SELECT id, backend_type, config_summary, encrypted FROM backup_remotes WHERE id = ?')
        .bind(String(rid)).first<{ id: string; backend_type: string; config_summary: string; encrypted: number }>();
      if (remote) {
        const parsedConfig = (() => { try { return JSON.parse(remote.config_summary || '{}'); } catch { return {}; } })();
        if (remote.backend_type === 'r2' && r2) parsedConfig._r2Bucket = r2;
        remoteConfigs.push({ remoteId: remote.id, config: { backend_type: remote.backend_type, ...parsedConfig } });
        if (remote.encrypted === 1) shouldEncrypt = true;
        if (!remoteId) remoteId = remote.id;
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

    // 广播开始事件（对齐原版 on_progress）
    await broadcastProgress(beeCountDO, schedule.user_id, {
      phase: 'starting', runId, scheduleId: schedule.id,
    }, 'backup_progress');

    try {
      if (env?.BACKUP_WORKFLOW) {
        // 自动备份与手动路径一致：Workflow（sqlite-export + DO 打包 + fan-out）
        await env.BACKUP_WORKFLOW.create({
          params: {
            runId: runId!,
            userId: schedule.user_id,
            ledgerId: ledger.id,
            remoteConfigs: remoteConfigs.map(({ remoteId, config }) => {
              const { _r2Bucket, ...rest } = config;
              return { remoteId, config: rest };
            }),
            shouldEncrypt,
            retentionDays: schedule.retention_days ?? undefined,
            scheduleId: schedule.id,
            serverNow: startedAt,
          },
        });
        console.log(`[CRON] Backup workflow triggered for schedule ${schedule.id}, run ${runId}`);
      } else {
        console.log(`[CRON] Starting legacy backup for schedule ${schedule.id}, run ${runId}...`);
        const backupResult = await performBackupFanOut(db, runId!, schedule.user_id, ledger.id, remoteConfigs, shouldEncrypt, r2, logFn, schedule.retention_days ?? undefined, (phase) => {
          broadcastProgress(beeCountDO, schedule.user_id, { phase, runId, scheduleId: schedule.id }, 'backup_progress').catch(() => {});
        });
        const finishedAt = new Date().toISOString();
        const logText = logLines.join('\n').slice(0, 1024 * 1024);
        const updateSql = backupResult.success
          ? 'UPDATE backup_runs SET status = ?, finished_at = ?, bytes_total = ?, backup_filename = ?, backup_path = ?, log_text = ? WHERE id = ?'
          : 'UPDATE backup_runs SET status = ?, finished_at = ?, error_message = ?, log_text = ? WHERE id = ?';
        const updateParams = backupResult.success
          ? ['succeeded', finishedAt, backupResult.backupSize || null, backupResult.backupPath?.split('/').pop() || null, backupResult.backupPath || null, logText, runId]
          : ['failed', finishedAt, backupResult.message || null, logText, runId];
        await db.prepare(updateSql).bind(...updateParams).run();
        await broadcastProgress(beeCountDO, schedule.user_id, {
          status: backupResult.success ? 'succeeded' : 'failed', runId, scheduleId: schedule.id,
          backupSize: backupResult.backupSize, backupPath: backupResult.backupPath,
        });
        try {
          const nextRun = calculateNextRun(schedule.cron_expr, timezoneOffset);
          await db.prepare('UPDATE backup_schedules SET last_run_at = ?, last_run_status = ?, next_run_at = ?, updated_at = ? WHERE id = ?')
            .bind(startedAt, backupResult.success ? 'succeeded' : 'failed', nextRun, startedAt, schedule.id).run();
        } catch (schedErr) {
          console.error(`[CRON] Failed to update backup_schedules: ${(schedErr as Error).message}`);
        }
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      const finishedAt = new Date().toISOString();
      console.error(`[CRON] Exception during backup trigger for schedule ${schedule.id}:`, error);
      await broadcastProgress(beeCountDO, schedule.user_id, {
        status: 'failed', runId, scheduleId: schedule.id, error: errorMsg,
      });
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

