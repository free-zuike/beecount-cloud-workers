/**
 * 备份保留策略 — 对齐原版 Python services/backup/retention.py
 *
 * 解析备份文件名 → 按 retention_days 计算待删列表 → 保留至少 N 份
 *
 * 文件名格式:
 *   - 加密: 20260612-040000.zip
 *   - 明文: 20260612-040000.tar.gz
 *   - 老格式: 20260612-040000Z.tar.gz / 20260612-040000Z.tar.gz.age
 */

const TAR_NAME_RE = /^(\d{14})_backup(?:\.zip|\.tar\.gz(?:\.age)?)$/;

export interface RemoteFile {
  name: string;
  path?: string; // 远端文件 ID 或路径（用于删除）
  timestamp: Date; // UTC
}

/**
 * 解析备份文件名中的时间戳
 */
export function parseBackupFilename(name: string): Date | null {
  // 只取文件名部分（去掉路径前缀）
  const basename = name.split('/').pop() || name;
  const m = TAR_NAME_RE.exec(basename);
  if (!m) return null;
  const dateStr = m[1]; // YYYYMMDDHHMMSS (14 digits)

  const year = parseInt(dateStr.slice(0, 4), 10);
  const month = parseInt(dateStr.slice(4, 6), 10) - 1;
  const day = parseInt(dateStr.slice(6, 8), 10);
  const hour = parseInt(dateStr.slice(8, 10), 10);
  const min = parseInt(dateStr.slice(10, 12), 10);
  const sec = parseInt(dateStr.slice(12, 14), 10);

  // TS 版使用 UTC+8 本地时间生成时间戳，当作 UTC 处理
  return new Date(Date.UTC(year, month, day, hour, min, sec));
}

/**
 * 从文件列表里筛选出备份文件
 */
export function filterBackupFiles(items: Array<{ Name?: string; Path?: string; IsDir?: boolean }>): RemoteFile[] {
  const out: RemoteFile[] = [];
  for (const item of items) {
    if (item.IsDir) continue;
    const name = item.Name || item.Path || '';
    const ts = parseBackupFilename(name);
    if (!ts) continue;
    out.push({ name, path: item.Path, timestamp: ts });
  }
  return out;
}

/**
 * 计算应删除的备份文件列表
 *
 * 规则:
 *   - 文件 timestamp < now - retention_days → 待删
 *   - 但全局保留至少 keepAtLeast 份(防 retention=0 误配把所有备份删光)
 */
export function computeRetentionDeletes(
  files: RemoteFile[],
  retentionDays: number,
  now?: Date,
  keepAtLeast: number = 1,
): RemoteFile[] {
  if (retentionDays < 1) retentionDays = 1;
  const cutoff = (now ?? new Date()).getTime() - retentionDays * 24 * 60 * 60 * 1000;

  const byTime = [...files].sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  const toDelete = byTime.filter(f => f.timestamp.getTime() < cutoff);
  const keepCount = byTime.length - toDelete.length;

  if (keepCount < keepAtLeast) {
    const rescue = keepAtLeast - keepCount;
    return toDelete.slice(rescue);
  }
  return toDelete;
}