import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from 'cloudflare:workers';
import { uploadPreparedBackup } from '../services/backup-executor';
import { exportD1ToSqlite } from '../lib/sqlite-writer';

type Env = {
  DB: D1Database;
  R2: R2Bucket;
  BEECOUNT_DO: DurableObjectNamespace;
  JWT_SECRET: string;
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  D1_DATABASE_ID?: string;
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
    /** 将当前日志写入 DB，备份过程中刷新详情页可见逐步更新的日志 */
    const flushLogs = async () => {
      try {
        await db.prepare('UPDATE backup_runs SET log_text = ? WHERE id = ?')
          .bind(logLines.join('\n').slice(0, 1024 * 1024), runId).run();
      } catch { /* non-critical */ }
    };
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
      // 生成 db.sqlite3（D1 Export API 单步 I/O 操作）
      // 保存到 R2 临时对象避免 step.do 输出 > 1MB 限制
      // ============================================================
      let sqliteR2Key: string | null = null;
      try {
        logFn(`[SQLite] Export API token available: ${!!this.env.CLOUDFLARE_API_TOKEN}`);
        await step.do(
          'sqlite-export',
          { retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' } },
          async () => {
            // 在 step 内保存到 R2，避免 step 返回 > 1MB 的数据
            const bytes = await exportD1ToSqlite(
              db, undefined, logFn,
              this.env.CLOUDFLARE_API_TOKEN,
              this.env.CLOUDFLARE_ACCOUNT_ID as string,
              this.env.D1_DATABASE_ID as string,
            );
            const key = `temp/backup-${runId}/db.sqlite3`;
            await this.env.R2.put(key, bytes, { httpMetadata: { contentType: 'application/octet-stream' } });
            logFn(`[SQLite] db.sqlite3 saved to R2: ${bytes.length} bytes`);
            return 'ok'; // 返回小字符串，避免 1MB 限制
          },
        );
        sqliteR2Key = `temp/backup-${runId}/db.sqlite3`;
        await flushLogs();
      } catch (err) {
        logFn(`[SQLite] db.sqlite3 generation failed: ${(err as Error).message}`);
      }

      // ============================================================
      // 打包：调用 Durable Object（DO 每次请求 30s CPU 预算，绕开
      // Workflow 步骤 10ms CPU 限制）。DO 内生成 db.json + 附件 +
      // tar.gz / AES zip，存回 R2，返回小 key。
      // ============================================================
      let pactR2Key: string | null = null;
      const outKey = `temp/backup-${runId}/backup${shouldEncrypt ? '.zip' : '.tar.gz'}`;
      if (sqliteR2Key) {
        try {
          await step.do(
            'backup-pack',
            { retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' } },
            async () => {
              const stub = this.env.BEECOUNT_DO.get(this.env.BEECOUNT_DO.idFromName(`pack-${runId}`));
              const res = await stub.fetch('http://do/backup-pack', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  sqliteR2Key,
                  outR2Key: outKey,
                  userId, ledgerId, runId,
                  shouldEncrypt,
                  password: effectiveConfigs[0]?.config?.age_passphrase || effectiveConfigs[0]?.config?.zipryption_password || undefined,
                  scheduleId: scheduleId ?? null, scheduleName: null,
                  jwtSecret: this.env.JWT_SECRET || null,
                }),
              });
              if (!res.ok) throw new Error(`backup-pack failed: ${await res.text()}`);
              const r = await res.json() as { ok: boolean; size?: number; error?: string };
              if (!r.ok) throw new Error(r.error || 'backup-pack failed');
              logFn(`[Backup] DO packed: ${r.size} bytes`);
              return 'ok';
            },
          );
          pactR2Key = outKey;
          await flushLogs();
        } catch (err) {
          logFn(`[Backup] DO pack failed: ${(err as Error).message}`);
          pactR2Key = null;
        }
      }

      // Step C: 上传（自由 Workflow 步骤，只做 I/O 上传）
      await broadcast({ type: 'backup_progress', phase: 'fan_out_start', runId });
      const backupResult = await step.do(
        'backup-fan-out',
        { retries: { limit: 1, delay: '1 minute', backoff: 'exponential' } },
        async () => {
          try {
            if (pactR2Key) {
              const obj = await this.env.R2.get(pactR2Key);
              if (obj) {
                const bytes = new Uint8Array(await obj.arrayBuffer());
                return await uploadPreparedBackup(
                  db, runId, userId, ledgerId, effectiveConfigs,
                  this.env.R2, logFn, retentionDays,
                  (phase) => { broadcast({ type: 'backup_progress', phase, runId }).catch(() => {}); },
                  bytes, shouldEncrypt,
                );
              }
            }
            return {
              success: false,
              message: 'Backup bytes not available (pack failed)',
              backupSize: 0,
              attachmentsUploaded: 0,
            };
          } finally {
            // 上传完成后清理临时中转文件（R2 失败不阻塞）
            if (pactR2Key) this.env.R2.delete(pactR2Key).catch(() => {});
            if (sqliteR2Key) this.env.R2.delete(sqliteR2Key).catch(() => {});
          }
        },
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