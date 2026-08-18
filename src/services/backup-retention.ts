/**
 * 备份保留策略 — 对齐原版 Python services/backup/retention.py
 *
 * 解析备份文件名 → 按 retention_days 计算待删列表 → 保留至少 N 份
 *
 * 支持的文件名格式（原版三种 + TS 现有格式）:
 *   - 原版加密:  20260612-040000.zip
 *   - 原版明文:  20260612-040000.tar.gz
 *   - 原版老格式: 20260612-040000Z.tar.gz / 20260612-040000Z.tar.gz.age（Z = UTC）
 *   - TS 现有:   20260612160400_backup.tar.gz / .zip / .tar.gz.age
 *
 * 时间语义:带 Z 后缀按 UTC；其余按当地生成时间处理（TS 文件名用 UTC+8 时间
 * 生成，当作 UTC 解析会多保留 ~8h，属安全方向，与原版近似等价）。
 */

// TS 现有格式: 20260612160400_backup.tar.gz / .zip / .tar.gz.age
const TS_NAME_RE = /^(\d{14})_backup(?:\.zip|\.tar\.gz(?:\.age)?)$/;
// 原版格式: 20260612-040000(.zip|.tar.gz[.age])，可选 Z 后缀（UTC）
const ORIG_NAME_RE = /^(\d{8})-(\d{6})(Z?)(?:\.zip|\.tar\.gz(?:\.age)?)$/;

export interface RemoteFile {
  name: string;
  path?: string; // 远端文件 ID 或路径（用于删除）
  timestamp: Date; // UTC
}

/**
 * 解析备份文件名中的时间戳（返回 UTC Date）
 */
export function parseBackupFilename(name: string): Date | null {
  // 只取文件名部分（去掉路径前缀）
  const basename = name.split('/').pop() || name;

  const tsMatch = TS_NAME_RE.exec(basename);
  if (tsMatch) {
    const s = tsMatch[1]; // YYYYMMDDHHMMSS (14 digits)
    return new Date(Date.UTC(
      parseInt(s.slice(0, 4), 10), parseInt(s.slice(4, 6), 10) - 1,
      parseInt(s.slice(6, 8), 10), parseInt(s.slice(8, 10), 10),
      parseInt(s.slice(10, 12), 10), parseInt(s.slice(12, 14), 10),
    ));
  }

  const origMatch = ORIG_NAME_RE.exec(basename);
  if (origMatch) {
    const dateS = origMatch[1]; // YYYYMMDD
    const timeS = origMatch[2]; // HHMMSS
    // 无 Z：按 UTC 近似（保留偏多，安全方向；与原版 local-tz 语义差 ≤ 时区偏移）
    return new Date(Date.UTC(
      parseInt(dateS.slice(0, 4), 10), parseInt(dateS.slice(4, 6), 10) - 1,
      parseInt(dateS.slice(6, 8), 10), parseInt(timeS.slice(0, 2), 10),
      parseInt(timeS.slice(2, 4), 10), parseInt(timeS.slice(4, 6), 10),
    ));
  }
  return null;
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