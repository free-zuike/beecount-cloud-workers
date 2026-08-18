import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from 'cloudflare:workers';
import { performBackupFanOut } from '../services/backup-executor';
import { exportD1Init, exportD1InsertBatch, DEFAULT_EXCLUDED_TABLES } from '../lib/sqlite-writer';

type Env = {
  DB: D1Database;
  R2: R2Bucket;
  BEECOUNT_DO: DurableObjectNamespace;
  JWT_SECRET: string;
};

type BackupParams = {
  runId: number;
  userId: string;
  ledgerId: string;
  remoteConfigs: Array<{ remoteId: string; config: Record<string, string> }>;
  shouldEncrypt: boolean;
  retentionDays?: number;
  scheduleId?: number | null;
  serverNow: string;
};

export class BackupWorkflow extends WorkflowEntrypoint<Env, BackupParams> {
  async run(event: WorkflowEvent<BackupParams>, step: WorkflowStep) {
    const { runId, userId, ledgerId, remoteConfigs, shouldEncrypt, retentionDays, scheduleId, serverNow } = event.payload;
    const db = this.env.DB;
    const logLines: string[] = [];
    const logFn = (msg: string) => logLines.push(`[${new Date().toISOString()}] ${msg}`);
    const broadcast = async (message: Record<string, unknown>) => {
      try {
        const doId = this.env.BEECOUNT_DO.idFromName(`ws-${userId}`);
        const stub = this.env.BEECOUNT_DO.get(doId);
        await stub.fetch(new URL('/broadcast', 'http://do'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: JSON.stringify(message) }),
        });
      } catch { /* non-critical */ }
    };

    // 1. 重建远端配置
    const effectiveConfigs: Array<{ remoteId: string; config: Record<string, string> }> = remoteConfigs.map((rc) =>
      rc.config.backend_type === 'r2' && this.env.R2
        ? { ...rc, config: { ...rc.config, _r2Bucket: this.env.R2 } as unknown as Record<string, string> }
        : rc,
    );

    await broadcast({ type: 'backup_progress', phase: 'starting', runId, bytesTransferred: 0, bytesTotal: 0 });

    try {
      // ============================================================
      // 拆分 SQLite 生成为多个 step.do，每步独立 CPU 预算
      // ============================================================

      // Step A: 初始化 sql.js + 执行 DDL
      let sqliteState = await step.do(
        'sqlite-init',
        { retries: { limit: 2, delay: '30 seconds', backoff: 'exponential' } },
        async () => exportD1Init(db, logFn),
      );

      // Step B: 获取所有业务表，分批插入（每批 5 张表）
      const allTables = await db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%' ORDER BY name`,
      ).all<{ name: string }>();
      const tableNames = ((allTables.results || []).map(x => x.name)).filter(n => !DEFAULT_EXCLUDED_TABLES.includes(n));
      const BATCH = 5;
      for (let i = 0; i < tableNames.length; i += BATCH) {
        const batch = tableNames.slice(i, i + BATCH);
        sqliteState = await step.do(
          `sqlite-insert-${i / BATCH}`,
          { retries: { limit: 2, delay: '30 seconds', backoff: 'exponential' } },
          async () => exportD1InsertBatch(db, sqliteState, batch, logFn),
        );
      }
      logFn(`[SQLite] db.sqlite3 built: ${sqliteState.length} bytes`);

      // Step C: 执行备份（传入预生成的 SQLite 字节）
      await broadcast({ type: 'backup_progress', phase: 'fan_out_start', runId });
      const backupResult = await step.do(
        'backup-fan-out',
        { retries: { limit: 1, delay: '1 minute', backoff: 'exponential' } },
        async () =>
          await performBackupFanOut(
            db, runId, userId, ledgerId, effectiveConfigs, shouldEncrypt,
            this.env.R2, logFn, retentionDays,
            (phase) => { broadcast({ type: 'backup_progress', phase, runId }).catch(() => {}); },
            { scheduleId: scheduleId ?? null, scheduleName: null },
            sqliteState,
          ),
      );

      const finishedAt = new Date().toISOString();
      const finalStatus = backupResult.success ? 'succeeded' : 'failed';
      logFn(`backup ${finalStatus}, size=${backupResult.backupSize || 0} bytes`);

      // 2. 更新 backup_runs 状态
      await db.prepare(
        `UPDATE backup_runs SET status = ?, finished_at = ?, bytes_total = ?, backup_filename = ?, backup_path = ?, error_message = ?, log_text = ?
         WHERE id = ?`,
      ).bind(finalStatus, finishedAt, backupResult.backupSize || null,
            backupResult.backupPath?.split('/').pop() || null, backupResult.backupPath || null,
            backupResult.success ? null : backupResult.message, logLines.join('\n'), runId).run();

      // 3. 每个远端创建 backup_run_targets 记录
      for (const rc of effectiveConfigs) {
        try {
          await db.prepare(
            `INSERT INTO backup_run_targets (run_id, remote_id, status, started_at, finished_at, bytes_transferred, error_message)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          ).bind(runId, rc.remoteId, finalStatus, serverNow, finishedAt,
                backupResult.backupSize || null, backupResult.success ? null : backupResult.message).run();
        } catch { /* ignore */ }
      }

      // 4. 广播最终状态
      await broadcast({ type: 'backup_status', status: finalStatus, runId, scheduleId: scheduleId ?? undefined });

      // 5. 更新调度最后状态
      if (scheduleId) {
        try {
          await db.prepare(
            'UPDATE backup_schedules SET last_run_at = ?, last_run_status = ? WHERE id = ?',
          ).bind(finishedAt, finalStatus, scheduleId).run();
        } catch { /* ignore */ }
      }
    } catch (err) {
      const finishedAt = new Date().toISOString();
      const errorMsg = err instanceof Error ? err.message : String(err);
      await db.prepare(
        `UPDATE backup_runs SET status = 'failed', finished_at = ?, error_message = ?, log_text = ? WHERE id = ?`,
      ).bind(finishedAt, errorMsg, logLines.join('\n'), runId).run();
      for (const rc of effectiveConfigs) {
        try {
          await db.prepare(
            `INSERT INTO backup_run_targets (run_id, remote_id, status, started_at, finished_at, error_message)
             VALUES (?, ?, 'failed', ?, ?, ?)`,
          ).bind(runId, rc.remoteId, serverNow, finishedAt, errorMsg).run();
        } catch { /* ignore */ }
      }
      await broadcast({ type: 'backup_status', status: 'failed', runId, scheduleId: scheduleId ?? undefined });
      if (scheduleId) {
        try {
          await db.prepare(
            'UPDATE backup_schedules SET last_run_at = ?, last_run_status = ? WHERE id = ?',
          ).bind(finishedAt, 'failed', scheduleId).run();
        } catch { /* ignore */ }
      }
    }
  }
}