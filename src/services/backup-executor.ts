/**
 * 备份执行器 - 提取公共的备份执行逻辑
 *
 * 被 src/index.ts（定时任务）和 src/routes/admin_backup.ts（管理员手动触发）共用
 */

import { uploadToS3 } from '../lib/s3';

export interface BackupResult {
  success: boolean;
  message: string;
  backupSize?: number;
  backupPath?: string;
}

async function fetchLedgerChanges(
  db: D1Database,
  ledgerId: string
): Promise<{ entity_type: string; entity_sync_id: string; payload_json: string }[]> {
  const result = await db
    .prepare('SELECT entity_type, entity_sync_id, payload_json FROM sync_changes WHERE ledger_id = ?')
    .bind(ledgerId)
    .all();
  return (result.results || []) as { entity_type: string; entity_sync_id: string; payload_json: string }[];
}

export async function performBackup(
  db: D1Database,
  runId: string,
  ledgerId: string,
  remoteConfig: Record<string, string>
): Promise<BackupResult> {
  try {
    console.log(`[Backup] Starting backup for ledger: ${ledgerId}`);

    const changes = await fetchLedgerChanges(db, ledgerId);
    console.log(`[Backup] Found ${changes.length} changes to backup`);

    const backupData = {
      ledger_id: ledgerId,
      backup_time: new Date().toISOString(),
      version: '1.0',
      changes: changes.map(c => ({
        entity_type: c.entity_type,
        entity_sync_id: c.entity_sync_id,
        payload: JSON.parse(c.payload_json)
      }))
    };

    const backupContent = JSON.stringify(backupData, null, 2);
    const backupSize = backupContent.length;

    console.log(`[Backup] Backup content size: ${backupSize} bytes`);

    if (remoteConfig.backend_type === 's3') {
      const s3Endpoint = remoteConfig.endpoint || 'https://s3.amazonaws.com';
      const s3Bucket = remoteConfig.bucket;
      const s3AccessKey = remoteConfig.access_key_id;
      const s3SecretKey = remoteConfig.secret_access_key;
      const s3Region = remoteConfig.region || 'auto';

      if (!s3Bucket || !s3AccessKey || !s3SecretKey) {
        return { success: false, message: 'S3 configuration incomplete' };
      }

      let basePrefix = '';
      if (remoteConfig.savePath && typeof remoteConfig.savePath === 'string' &&
          remoteConfig.savePath !== 'custom' && remoteConfig.savePath !== 'environment variable') {
        basePrefix = remoteConfig.savePath.trim().replace(/^\/+|\/+$/g, '') + '/';
        console.log(`[Backup] Using savePath: ${basePrefix}`);
      } else if (remoteConfig.root_path && typeof remoteConfig.root_path === 'string' && remoteConfig.root_path.trim() !== '') {
        basePrefix = remoteConfig.root_path.trim().replace(/^\/+|\/+$/g, '') + '/';
        console.log(`[Backup] Using root_path: ${basePrefix}`);
      }

      const timestamp = new Date().toISOString().replace(/[:\-T]/g, '').slice(0, 14);
      const backupKey = `${basePrefix}backups/${ledgerId}/${timestamp}_backup.json`;

      console.log(`[Backup] Uploading to S3 key: ${backupKey}`);

      const uploadResult = await uploadToS3(
        s3Endpoint,
        s3Bucket,
        s3AccessKey,
        s3SecretKey,
        s3Region,
        backupKey,
        backupContent
      );

      if (!uploadResult.ok) {
        return { success: false, message: uploadResult.message };
      }

      console.log(`[Backup] Upload successful: ${backupKey}`);

      return {
        success: true,
        message: 'Backup completed successfully',
        backupSize,
        backupPath: backupKey
      };
    } else if (remoteConfig.backend_type === 'local') {
      console.log('[Backup] Local backend - skipping upload (simulated)');
      return {
        success: true,
        message: 'Backup completed (local storage)',
        backupSize,
        backupPath: `local://backup_${runId}.json`
      };
    } else {
      return { success: false, message: `Unsupported backend type: ${remoteConfig.backend_type}` };
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error('[Backup] Error:', errorMsg);
    return { success: false, message: `Backup error: ${errorMsg}` };
  }
}

/**
 * 计算下次运行时间
 * Cron 表达式格式: 分钟 小时 日期 月份 星期
 * @param cronExpr cron表达式
 * @param timezoneOffset 用户时区偏移（分钟，东八区为-480）
 */
export function calculateNextRun(cronExpr: string, timezoneOffset: number = 0): string {
  try {
    const parts = cronExpr.trim().split(/\s+/);

    if (parts.length < 5) {
      const nextDate = new Date();
      nextDate.setMinutes(nextDate.getMinutes() + 5);
      return nextDate.toISOString();
    }

    const minuteStr = parts[0];
    const hourStr = parts[1];
    const dayStr = parts[2];

    const targetMinute = minuteStr === '*' ? 0 : parseInt(minuteStr, 10);
    const targetHour = hourStr === '*' ? 0 : parseInt(hourStr, 10);

    const now = new Date();

    let targetLocal = new Date();
    targetLocal.setHours(targetHour);
    targetLocal.setMinutes(targetMinute);
    targetLocal.setSeconds(0);
    targetLocal.setMilliseconds(0);

    if (targetLocal.getTime() <= now.getTime()) {
      targetLocal.setDate(targetLocal.getDate() + 1);
    }

    if (dayStr !== '*') {
      const targetDay = parseInt(dayStr, 10);
      if (!isNaN(targetDay) && targetDay > 0 && targetDay <= 31) {
        if (targetDay < targetLocal.getDate()) {
          targetLocal.setMonth(targetLocal.getMonth() + 1);
        }
        targetLocal.setDate(targetDay);
      }
    }

    const targetUtc = new Date(targetLocal.getTime() + timezoneOffset * 60000);

    return targetUtc.toISOString();
  } catch (e) {
    console.error('[Schedule] Error parsing cron expression:', cronExpr, e);
    const nextDate = new Date();
    nextDate.setMinutes(nextDate.getMinutes() + 5);
    return nextDate.toISOString();
  }
}
